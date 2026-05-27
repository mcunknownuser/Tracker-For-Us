-- =============================================================================
--  0005_staff.sql
--  Staff directory and role taxonomy.
-- =============================================================================
--
--  What this migration sets up:
--    * staff_roles         configurable role names (e.g. "Manager", "Chatter").
--                          A "kind" field maps each role to a department:
--                          staff (general), ofm_weekly, ofm_chatter, ofm_model,
--                          or reddit.
--    * staff               the central employee directory: name + contact +
--                          department-specific pay fields.
--    * employee_roles      simple role names used by the OFM Add Employee
--                          modal (separate from staff_roles, kept for legacy
--                          reasons — possible consolidation candidate later).
--    * staff_id linking    ALTER employees and reddit_employees to point
--                          back to a staff row, so adding a person to a
--                          department-typed role auto-creates that department
--                          record.
--    * Seed helpers        per-agency defaults for roles, called on signup.
--
--  Why staff is separate from employees/reddit_employees:
--    Different departments (OFM vs Reddit) have different pay structures.
--    Trying to unify into one table means every employee carries every
--    department's pay fields, most of which are null. Splitting keeps each
--    department's table tight, with staff as the directory that knows
--    everyone has personal info (name, phone, email) in common.
--
-- =============================================================================


-- =============================================================================
--  1. staff_roles
-- =============================================================================
--  Roles that staff can have. Each role has a kind that tells the app which
--  department record (if any) to auto-create when this role is selected.
--
--  Kind values:
--    staff         general role with no department record (e.g. Manager)
--    ofm_weekly    creates an OFM employees row with kind='weekly'
--    ofm_chatter   creates an OFM employees row with kind='chatter'
--    ofm_model    creates an OFM employees row with kind='model'
--    reddit        creates a reddit_employees row

create table if not exists public.staff_roles (
  id              uuid primary key default gen_random_uuid(),

  agency_id       uuid not null references public.agency(id) on delete cascade,

  name            text not null check (length(trim(name)) > 0),

  -- Drives which department record the app auto-creates when this role
  -- is assigned. 'staff' = no department record (general staff).
  kind            text not null default 'staff'
                  check (kind in ('staff', 'ofm_weekly', 'ofm_chatter', 'ofm_model', 'reddit')),

  sort_order      int not null default 0,

  created_at      timestamptz not null default now(),
  deleted_at      timestamptz,

  constraint staff_roles_agency_name_uniq unique (agency_id, name)
);

create index if not exists staff_roles_agency_sorted_idx
  on public.staff_roles (agency_id, sort_order)
  where deleted_at is null;


-- =============================================================================
--  2. staff
-- =============================================================================
--  Central employee directory. One row per person who works at the agency,
--  regardless of department.
--
--  Pay fields are nullable because they only apply when staff have a
--  department record. They're stored here for convenience so the
--  "Edit Staff" modal can show/edit everything in one place; the app
--  syncs them to the matching department record on save.

create table if not exists public.staff (
  id                  uuid primary key default gen_random_uuid(),

  agency_id           uuid not null references public.agency(id) on delete cascade,

  name                text not null check (length(trim(name)) > 0),

  -- Free-text role label. Should match a staff_roles.name for the same
  -- agency, but we don't FK because users can type a one-off role.
  role                text,

  phone               text,
  email               text,

  -- Department-specific pay fields. Only the field matching the staff
  -- member's department is populated.
  --
  -- For OFM weekly:
  weekly_pay_cents    bigint
                      check (weekly_pay_cents is null or weekly_pay_cents >= 0),
  -- For OFM chatter / OFM model (decimal commission / share):
  rate                numeric(5,4)
                      check (rate is null or (rate >= 0 and rate <= 1)),
  -- For Reddit (flat rate per pay period, in cents):
  rate_cents          bigint
                      check (rate_cents is null or rate_cents >= 0),
  -- For Reddit:
  pay_frequency       text
                      check (pay_frequency is null
                             or pay_frequency in ('weekly', 'biweekly')),

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz
);

create index if not exists staff_agency_idx
  on public.staff (agency_id) where deleted_at is null;


-- =============================================================================
--  3. employee_roles
-- =============================================================================
--  Simpler role list used specifically by the OFM Add Employee modal.
--  Kept separate from staff_roles for now because the OFM workflow predates
--  the unified staff directory. Future cleanup candidate.

create table if not exists public.employee_roles (
  id              uuid primary key default gen_random_uuid(),

  agency_id       uuid not null references public.agency(id) on delete cascade,

  name            text not null check (length(trim(name)) > 0),

  sort_order      int not null default 0,

  created_at      timestamptz not null default now(),
  deleted_at      timestamptz,

  constraint employee_roles_agency_name_uniq unique (agency_id, name)
);

create index if not exists employee_roles_agency_sorted_idx
  on public.employee_roles (agency_id, sort_order)
  where deleted_at is null;


-- =============================================================================
--  4. Link staff_id back to department records
-- =============================================================================
--  We add staff_id columns to the OFM employees and reddit_employees tables
--  (which were created in 0002 and 0003) so that a staff record can find its
--  department record and vice versa.
--
--  on delete set null: if the staff record is deleted, the department record
--  remains (so historical sales/payments aren't orphaned) — it just loses
--  its link back to the directory.

alter table public.employees
  add column if not exists staff_id uuid
  references public.staff(id) on delete set null;

alter table public.reddit_employees
  add column if not exists staff_id uuid
  references public.staff(id) on delete set null;

create index if not exists employees_staff_idx
  on public.employees (staff_id) where deleted_at is null;
create index if not exists reddit_employees_staff_idx
  on public.reddit_employees (staff_id) where deleted_at is null;


-- =============================================================================
--  5. updated_at triggers
-- =============================================================================

drop trigger if exists staff_touch_updated_at on public.staff;
create trigger staff_touch_updated_at
  before update on public.staff
  for each row execute function public.touch_updated_at();


-- =============================================================================
--  6. Seed helpers
-- =============================================================================
--  Per-agency defaults. Called by the app right after creating a new agency.

create or replace function public.seed_agency_staff_defaults(target_agency_id uuid)
returns void
language plpgsql
security invoker
as $$
begin
  -- General staff roles (no department record).
  insert into public.staff_roles (agency_id, name, sort_order, kind)
  select target_agency_id, name, sort_order, kind from (values
    ('Manager'::text,   0::int,  'staff'::text),
    ('Server',          1,       'staff'),
    ('Bartender',       2,       'staff'),
    ('Host',            3,       'staff'),
    -- Department-typed roles. Selecting one auto-creates the department record.
    ('OFM Weekly',      100,     'ofm_weekly'),
    ('OFM Chatter',     101,     'ofm_chatter'),
    ('OFM Model',       102,     'ofm_model'),
    ('Reddit',          103,     'reddit')
  ) t(name, sort_order, kind)
  where not exists (
    select 1 from public.staff_roles where agency_id = target_agency_id
  );

  -- OFM-specific role labels for the OFM Add Employee modal.
  insert into public.employee_roles (agency_id, name, sort_order)
  select target_agency_id, name, sort_order from (values
    ('Chatter'::text,  0::int),
    ('Model',          1),
    ('Manager',        2)
  ) t(name, sort_order)
  where not exists (
    select 1 from public.employee_roles where agency_id = target_agency_id
  );
end $$;


-- =============================================================================
--  7. Row Level Security
-- =============================================================================

alter table public.staff_roles     enable row level security;
alter table public.staff           enable row level security;
alter table public.employee_roles  enable row level security;

do $$
declare
  t text;
  table_names text[] := array[
    'staff_roles',
    'staff',
    'employee_roles'
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
--  End of 0005_staff.sql
-- =============================================================================
