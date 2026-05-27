-- =============================================================================
--  0003_reddit.sql
--  Reddit marketing domain tables.
-- =============================================================================
--
--  What this migration sets up:
--    * reddit_employees       virtual assistants / staff working on Reddit
--    * reddit_accounts        Reddit accounts the agency uses for promotion
--    * reddit_account_income  monthly income attributed to each account
--    * reddit_payments        money paid OUT to Reddit staff
--
--  Why these are separate from the OFM tables:
--    Reddit work has its own pay structure (flat $/week or $/2-weeks, no
--    commission) and its own concept of "accounts" — the Reddit handles
--    the agency owns and posts from. Trying to cram this into the OFM
--    employees table would mean every employee carries fields that don't
--    apply. Easier to keep them parallel.
--
--  Multi-tenancy:
--    Every table has agency_id NOT NULL. RLS uses is_agency_member() from
--    0001_tenancy.sql.
--
-- =============================================================================


-- =============================================================================
--  1. Enums
-- =============================================================================
--  reddit_pay_frequency: how often Reddit staff get paid.
--
--    weekly    - every 7 days
--    biweekly  - every 14 days

do $$ begin
  create type reddit_pay_frequency as enum ('weekly', 'biweekly');
exception when duplicate_object then null;
end $$;


-- =============================================================================
--  2. reddit_employees
-- =============================================================================
--  People working on Reddit promotion (usually VAs).
--  Pay is a flat rate per pay period — no commission, no per-account split.

create table if not exists public.reddit_employees (
  id              uuid primary key default gen_random_uuid(),

  agency_id       uuid not null references public.agency(id) on delete cascade,

  name            text not null check (length(trim(name)) > 0),

  -- Pay rate per pay period in cents.
  -- e.g. 50000 with pay_frequency='weekly' = $500/week.
  rate_cents      bigint not null check (rate_cents >= 0),

  pay_frequency   reddit_pay_frequency not null default 'weekly',

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);

create index if not exists reddit_employees_agency_idx
  on public.reddit_employees (agency_id) where deleted_at is null;


-- =============================================================================
--  3. reddit_accounts
-- =============================================================================
--  The actual Reddit handles the agency owns/operates for promotion.
--  Optionally linked to a specific employee responsible for the account.

create table if not exists public.reddit_accounts (
  id              uuid primary key default gen_random_uuid(),

  agency_id       uuid not null references public.agency(id) on delete cascade,

  -- Display label for the account. Usually the Reddit handle (e.g. "u/foo")
  -- or a nickname. Required and non-empty.
  label           text not null check (length(trim(label)) > 0),

  -- Free-text notes for internal use (e.g. "ban risk: high",
  -- "primary VIP funnel", "do not post NSFW").
  client_notes    text,

  -- Who's currently responsible for this account.
  -- on delete set null: if the employee is removed, the account stays
  -- (we don't want to lose the account just because the VA quit).
  employee_id     uuid references public.reddit_employees(id) on delete set null,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);

create index if not exists reddit_accounts_agency_idx
  on public.reddit_accounts (agency_id) where deleted_at is null;
create index if not exists reddit_accounts_employee_idx
  on public.reddit_accounts (employee_id) where deleted_at is null;


-- =============================================================================
--  4. reddit_account_income
-- =============================================================================
--  Monthly income attributed to a Reddit account.
--  One row per account per month — the unique constraint enforces that.
--
--  Why month-level, not day-level: Reddit promotion conversion is slow and
--  bursty. Monthly totals are the natural unit of analysis. If you need
--  finer granularity later, this becomes income_period with start/end.

create table if not exists public.reddit_account_income (
  id              uuid primary key default gen_random_uuid(),

  agency_id       uuid not null references public.agency(id) on delete cascade,

  -- on delete cascade: if the account is hard-deleted, its income history goes too.
  -- (Normally we soft-delete accounts, so this rarely triggers.)
  account_id      uuid not null
                  references public.reddit_accounts(id) on delete cascade,

  amount_cents    bigint not null check (amount_cents >= 0),

  -- First day of the month this income is attributed to (always day 01).
  -- Use DATE not timestamptz — we don't care about exact time, just month.
  month_start     date not null,

  created_at      timestamptz not null default now(),

  -- One income record per account per month. Editing means updating the
  -- existing row, not inserting a second one.
  constraint reddit_income_unique unique (account_id, month_start)
);

create index if not exists reddit_account_income_agency_month_idx
  on public.reddit_account_income (agency_id, month_start);
create index if not exists reddit_account_income_account_idx
  on public.reddit_account_income (account_id, month_start desc);


-- =============================================================================
--  5. reddit_payments
-- =============================================================================
--  Money paid OUT to Reddit employees. Same idempotency pattern as OFM payments.

create table if not exists public.reddit_payments (
  id              uuid primary key default gen_random_uuid(),

  agency_id       uuid not null references public.agency(id) on delete cascade,

  -- on delete restrict: cannot delete an employee with payment history.
  employee_id     uuid not null
                  references public.reddit_employees(id) on delete restrict,

  amount_cents    bigint not null check (amount_cents > 0),
  note            text,
  paid_on         date not null,

  -- Idempotency key — see payments.client_ref in 0002_ofm.sql.
  client_ref      text,

  created_at      timestamptz not null default now(),
  deleted_at      timestamptz
);

create unique index if not exists reddit_payments_idempotency_idx
  on public.reddit_payments (employee_id, client_ref)
  where client_ref is not null and deleted_at is null;

create index if not exists reddit_payments_agency_month_idx
  on public.reddit_payments (agency_id, paid_on) where deleted_at is null;
create index if not exists reddit_payments_emp_month_idx
  on public.reddit_payments (employee_id, paid_on) where deleted_at is null;


-- =============================================================================
--  6. updated_at triggers
-- =============================================================================
--  Employees and accounts can have their details edited (name change, notes
--  update, employee reassignment). Income and payments are append-only.

drop trigger if exists reddit_employees_touch_updated_at on public.reddit_employees;
create trigger reddit_employees_touch_updated_at
  before update on public.reddit_employees
  for each row execute function public.touch_updated_at();

drop trigger if exists reddit_accounts_touch_updated_at on public.reddit_accounts;
create trigger reddit_accounts_touch_updated_at
  before update on public.reddit_accounts
  for each row execute function public.touch_updated_at();


-- =============================================================================
--  7. Row Level Security
-- =============================================================================

alter table public.reddit_employees       enable row level security;
alter table public.reddit_accounts        enable row level security;
alter table public.reddit_account_income  enable row level security;
alter table public.reddit_payments        enable row level security;

do $$
declare
  t text;
  table_names text[] := array[
    'reddit_employees',
    'reddit_accounts',
    'reddit_account_income',
    'reddit_payments'
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
--  End of 0003_reddit.sql
-- =============================================================================
