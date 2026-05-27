-- =============================================================================
--  0010_unified_team.sql
--  Rebuild the team domain around user-editable departments + roles, plus a
--  single unified team_members table.
-- =============================================================================
--
--  Why this exists:
--    Migrations 0002 (OFM employees), 0003 (Reddit employees), and 0005
--    (Staff) created three separate tables with three different shapes.
--    The shape difference reflected the *pay structure*, not anything
--    fundamental about a person. This made "departments" baked into the
--    schema, so users couldn't define their own.
--
--  New design:
--    * departments   — user-editable categories (OFM, Reddit, Staff, or any
--                      custom name like "Wholesale")
--    * staff_roles   — user-editable named roles inside each department.
--                      Each role has a pay_structure that drives the form.
--    * team_members  — unified employees table. Everyone is here, regardless
--                      of department. The pay_structure column says how
--                      they get paid; the matching pay fields are populated
--                      (and pay_consistency enforces the right combination).
--
--  Pay structures (built into the app's calculation code):
--    flat        - $X every Y days. Covers weekly, biweekly, monthly.
--    commission  - X% of chatter_sales for this team member.
--    share       - X% of model_withdrawals for this team member.
--
--  Data preserved: NONE. The previous team tables were empty (the user
--  hadn't populated them yet). Domain tables that referenced them
--  (chatter_sales, model_withdrawals, payments, reddit_accounts, etc.)
--  are rebuilt with FKs pointing at team_members.
--
-- =============================================================================


-- =============================================================================
--  1. Drop old structures
-- =============================================================================
-- Cascade drops the dependent views/policies. Order: deepest dependents first.

drop view  if exists public.employee_month_summary cascade;

drop table if exists public.reddit_payments         cascade;
drop table if exists public.reddit_account_income   cascade;
drop table if exists public.reddit_accounts         cascade;
drop table if exists public.reddit_employees        cascade;

drop table if exists public.payments                cascade;
drop table if exists public.chatter_sales           cascade;
drop table if exists public.model_withdrawals       cascade;

drop table if exists public.staff                   cascade;
drop table if exists public.employees               cascade;

drop table if exists public.staff_roles             cascade;
drop table if exists public.employee_roles          cascade;

drop type  if exists public.employee_kind           cascade;
drop type  if exists public.reddit_pay_frequency    cascade;

drop function if exists public.seed_agency_staff_defaults(uuid) cascade;


-- =============================================================================
--  2. New enum: pay_structure
-- =============================================================================

do $$ begin
  create type pay_structure as enum ('flat', 'commission', 'share');
exception when duplicate_object then null;
end $$;


-- =============================================================================
--  3. departments
-- =============================================================================
--  User-editable. Each row groups roles and team members.
--  Default seeds (OFM, Reddit, Staff) are added by seed_agency_team_defaults().

create table public.departments (
  id            uuid primary key default gen_random_uuid(),
  agency_id     uuid not null references public.agency(id) on delete cascade,
  name          text not null check (length(trim(name)) > 0),
  sort_order    int  not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  constraint departments_agency_name_uniq unique (agency_id, name)
);

create index departments_agency_idx
  on public.departments (agency_id, sort_order) where deleted_at is null;

drop trigger if exists departments_touch_updated_at on public.departments;
create trigger departments_touch_updated_at
  before update on public.departments
  for each row execute function public.touch_updated_at();


-- =============================================================================
--  4. staff_roles (rebuilt)
-- =============================================================================
--  Belongs to a department. Each role has a fixed pay_structure that
--  determines which pay fields appear when adding/editing a team member.

create table public.staff_roles (
  id              uuid primary key default gen_random_uuid(),
  agency_id       uuid not null references public.agency(id) on delete cascade,
  department_id   uuid not null references public.departments(id) on delete cascade,
  name            text not null check (length(trim(name)) > 0),
  pay_structure   pay_structure not null,
  sort_order      int not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  constraint staff_roles_dept_name_uniq unique (department_id, name)
);

create index staff_roles_agency_idx
  on public.staff_roles (agency_id, sort_order) where deleted_at is null;
create index staff_roles_department_idx
  on public.staff_roles (department_id, sort_order) where deleted_at is null;

drop trigger if exists staff_roles_touch_updated_at on public.staff_roles;
create trigger staff_roles_touch_updated_at
  before update on public.staff_roles
  for each row execute function public.touch_updated_at();


-- =============================================================================
--  5. team_members
-- =============================================================================
--  One row per person on the team, across every department. Pay fields
--  populated according to pay_structure. pay_consistency enforces the
--  right combination at the DB level.

create table public.team_members (
  id                  uuid primary key default gen_random_uuid(),
  agency_id           uuid not null references public.agency(id) on delete cascade,
  department_id       uuid not null references public.departments(id) on delete restrict,

  -- Optional reference to a staff_role for display + role name normalization.
  -- on delete set null: if a role is removed, the team member keeps their
  -- role_label text but loses the back-reference.
  role_id             uuid references public.staff_roles(id) on delete set null,
  role_label          text,  -- denormalized name for fast list rendering

  name                text not null check (length(trim(name)) > 0),

  pay_structure       pay_structure not null,

  -- Flat pay: $X every Y days.
  flat_amount_cents   bigint
                      check (flat_amount_cents is null or flat_amount_cents >= 0),
  flat_period_days    int
                      check (flat_period_days is null or flat_period_days > 0),

  -- Commission / share rate. 0..1 decimal. 0.10 = 10%.
  rate                numeric(5,4)
                      check (rate is null or (rate >= 0 and rate <= 1)),

  -- Optional contact.
  phone               text,
  email               text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,

  -- Enforce that exactly the right pay fields are populated for the structure.
  constraint pay_consistency check (
    (pay_structure = 'flat'
      and flat_amount_cents is not null
      and flat_period_days is not null
      and rate is null)
    or (pay_structure in ('commission', 'share')
      and rate is not null
      and flat_amount_cents is null
      and flat_period_days is null)
  ),

  -- Composite uniqueness so chatter_sales / model_withdrawals can FK on
  -- (id, pay_structure) and enforce that sales only point at commission-paid
  -- members, withdrawals only at share-paid members.
  constraint team_members_id_paystructure_uniq unique (id, pay_structure)
);

create index team_members_agency_idx
  on public.team_members (agency_id) where deleted_at is null;
create index team_members_department_idx
  on public.team_members (department_id) where deleted_at is null;
create index team_members_role_idx
  on public.team_members (role_id) where deleted_at is null;

drop trigger if exists team_members_touch_updated_at on public.team_members;
create trigger team_members_touch_updated_at
  before update on public.team_members
  for each row execute function public.touch_updated_at();


-- =============================================================================
--  6. chatter_sales (rebuilt to FK team_members)
-- =============================================================================

create table public.chatter_sales (
  id                uuid primary key default gen_random_uuid(),
  agency_id         uuid not null references public.agency(id) on delete cascade,

  team_member_id    uuid not null,

  -- Generated 'commission' so the composite FK only allows commission-paid
  -- team members.
  pay_structure     pay_structure not null
                    generated always as ('commission'::pay_structure) stored,

  amount_cents      bigint not null check (amount_cents >= 0),
  description       text,
  occurred_on       date not null,
  created_at        timestamptz not null default now(),
  deleted_at        timestamptz,

  foreign key (team_member_id, pay_structure)
    references public.team_members (id, pay_structure) on delete restrict
);

create index chatter_sales_agency_month_idx
  on public.chatter_sales (agency_id, occurred_on) where deleted_at is null;
create index chatter_sales_member_month_idx
  on public.chatter_sales (team_member_id, occurred_on) where deleted_at is null;


-- =============================================================================
--  7. model_withdrawals (rebuilt to FK team_members)
-- =============================================================================

create table public.model_withdrawals (
  id                uuid primary key default gen_random_uuid(),
  agency_id         uuid not null references public.agency(id) on delete cascade,

  team_member_id    uuid not null,

  pay_structure     pay_structure not null
                    generated always as ('share'::pay_structure) stored,

  amount_cents      bigint not null check (amount_cents >= 0),
  description       text,
  occurred_on       date not null,
  created_at        timestamptz not null default now(),
  deleted_at        timestamptz,

  foreign key (team_member_id, pay_structure)
    references public.team_members (id, pay_structure) on delete restrict
);

create index model_withdrawals_agency_month_idx
  on public.model_withdrawals (agency_id, occurred_on) where deleted_at is null;
create index model_withdrawals_member_month_idx
  on public.model_withdrawals (team_member_id, occurred_on) where deleted_at is null;


-- =============================================================================
--  8. payments (unified — replaces both old payments + reddit_payments)
-- =============================================================================

create table public.payments (
  id                uuid primary key default gen_random_uuid(),
  agency_id         uuid not null references public.agency(id) on delete cascade,

  -- Recipient. on delete restrict: can't drop a team member with payments
  -- on record — would orphan financial history.
  team_member_id    uuid not null
                    references public.team_members(id) on delete restrict,

  amount_cents      bigint not null check (amount_cents > 0),
  note              text,
  paid_on           date not null,

  -- Idempotency key. See migration 0002 for explanation.
  client_ref        text,

  created_at        timestamptz not null default now(),
  deleted_at        timestamptz
);

create unique index payments_idempotency_idx
  on public.payments (team_member_id, client_ref)
  where client_ref is not null and deleted_at is null;

create index payments_agency_month_idx
  on public.payments (agency_id, paid_on) where deleted_at is null;
create index payments_member_month_idx
  on public.payments (team_member_id, paid_on) where deleted_at is null;


-- =============================================================================
--  9. reddit_accounts + reddit_account_income (rebuilt, FK to team_members)
-- =============================================================================

create table public.reddit_accounts (
  id              uuid primary key default gen_random_uuid(),
  agency_id       uuid not null references public.agency(id) on delete cascade,
  label           text not null check (length(trim(label)) > 0),
  client_notes    text,

  -- Reddit VA assigned to the account (optional).
  team_member_id  uuid references public.team_members(id) on delete set null,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);

create index reddit_accounts_agency_idx
  on public.reddit_accounts (agency_id) where deleted_at is null;
create index reddit_accounts_member_idx
  on public.reddit_accounts (team_member_id) where deleted_at is null;

drop trigger if exists reddit_accounts_touch_updated_at on public.reddit_accounts;
create trigger reddit_accounts_touch_updated_at
  before update on public.reddit_accounts
  for each row execute function public.touch_updated_at();


create table public.reddit_account_income (
  id              uuid primary key default gen_random_uuid(),
  agency_id       uuid not null references public.agency(id) on delete cascade,
  account_id      uuid not null references public.reddit_accounts(id) on delete cascade,
  amount_cents    bigint not null check (amount_cents >= 0),
  month_start     date not null,
  created_at      timestamptz not null default now(),
  constraint reddit_income_unique unique (account_id, month_start)
);

create index reddit_account_income_agency_month_idx
  on public.reddit_account_income (agency_id, month_start);


-- =============================================================================
--  10. Row Level Security on every new table
-- =============================================================================

alter table public.departments            enable row level security;
alter table public.staff_roles            enable row level security;
alter table public.team_members           enable row level security;
alter table public.chatter_sales          enable row level security;
alter table public.model_withdrawals      enable row level security;
alter table public.payments               enable row level security;
alter table public.reddit_accounts        enable row level security;
alter table public.reddit_account_income  enable row level security;

do $$
declare
  t text;
  table_names text[] := array[
    'departments',
    'staff_roles',
    'team_members',
    'chatter_sales',
    'model_withdrawals',
    'payments',
    'reddit_accounts',
    'reddit_account_income'
  ];
begin
  foreach t in array table_names loop
    execute format('drop policy if exists %I_agency on public.%I', t, t);
    execute format(
      'create policy %I_agency on public.%I
         for all to authenticated
         using       (public.is_agency_member(agency_id))
         with check  (public.is_agency_member(agency_id))',
      t, t
    );
  end loop;
end $$;


-- =============================================================================
--  11. Seed function for new agencies
-- =============================================================================
--  Creates default departments (OFM, Reddit, Staff) + default roles inside
--  each. Idempotent — does nothing if departments already exist.

create or replace function public.seed_agency_team_defaults(target_agency_id uuid)
returns void
language plpgsql
security invoker
as $$
declare
  ofm_id    uuid;
  reddit_id uuid;
  staff_id  uuid;
begin
  -- Skip if this agency already has departments.
  if exists (
    select 1 from public.departments
    where agency_id = target_agency_id and deleted_at is null
  ) then
    return;
  end if;

  -- Create the 3 default departments.
  insert into public.departments (agency_id, name, sort_order)
  values
    (target_agency_id, 'OFM',    0),
    (target_agency_id, 'Reddit', 1),
    (target_agency_id, 'Staff',  2);

  select id into ofm_id    from public.departments where agency_id = target_agency_id and name = 'OFM';
  select id into reddit_id from public.departments where agency_id = target_agency_id and name = 'Reddit';
  select id into staff_id  from public.departments where agency_id = target_agency_id and name = 'Staff';

  -- Default roles per department.
  insert into public.staff_roles (agency_id, department_id, name, pay_structure, sort_order)
  values
    -- OFM
    (target_agency_id, ofm_id,    'Weekly',   'flat',       0),
    (target_agency_id, ofm_id,    'Chatter',  'commission', 1),
    (target_agency_id, ofm_id,    'Model',    'share',      2),
    -- Reddit
    (target_agency_id, reddit_id, 'Reddit VA', 'flat',      0),
    -- Staff
    (target_agency_id, staff_id,  'Manager',  'flat',       0),
    (target_agency_id, staff_id,  'Employee', 'flat',       1);
end $$;


-- =============================================================================
--  12. Update create_agency_for_current_user to call the new seed
-- =============================================================================

create or replace function public.create_agency_for_current_user(agency_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_agency_id   uuid;
  caller_user_id  uuid;
  trimmed_name    text;
begin
  caller_user_id := auth.uid();
  if caller_user_id is null then
    raise exception 'Not authenticated.';
  end if;

  trimmed_name := trim(coalesce(agency_name, ''));
  if length(trimmed_name) = 0 then
    raise exception 'Agency name is required.';
  end if;

  insert into public.agency (name, owner_user_id)
  values (trimmed_name, caller_user_id)
  returning id into new_agency_id;

  insert into public.agency_membership (agency_id, user_id, role)
  values (new_agency_id, caller_user_id, 'owner');

  perform public.seed_agency_expense_defaults(new_agency_id);
  perform public.seed_agency_team_defaults(new_agency_id);

  return new_agency_id;
end $$;

revoke all on function public.create_agency_for_current_user(text) from public;
grant execute on function public.create_agency_for_current_user(text) to authenticated;


-- =============================================================================
--  13. Backfill defaults for any agency that already exists
-- =============================================================================
--  In case an agency was created before this migration was run, seed its
--  defaults now. Idempotent.

do $$
declare a record;
begin
  for a in (select id from public.agency where deleted_at is null) loop
    perform public.seed_agency_team_defaults(a.id);
  end loop;
end $$;


-- =============================================================================
--  End of 0010_unified_team.sql
-- =============================================================================
