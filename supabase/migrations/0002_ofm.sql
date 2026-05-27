-- =============================================================================
--  0002_ofm.sql
--  OFM (OnlyFans Management) domain tables.
-- =============================================================================
--
--  What this migration sets up:
--    * employees           one row per person managed in OFM (chatter, model,
--                          or weekly-salaried staff)
--    * chatter_sales       sales attributed to a specific chatter
--    * model_withdrawals   payouts a model received from a platform
--    * payments            money paid OUT to any employee
--    * calendar_events     agency calendar / event tracking
--
--  Money rule (applies to every table here):
--    All currency is stored as BIGINT cents. Never numeric/float — floating-
--    point arithmetic is wrong for money. To display $12.34, store 1234.
--
--  Multi-tenancy:
--    Every table has agency_id NOT NULL referencing public.agency. RLS is on
--    and uses the is_agency_member() helper from 0001_tenancy.sql.
--    Even if a query forgets to filter by agency_id, RLS prevents leaks.
--
--  Composite FK trick:
--    chatter_sales and model_withdrawals each carry a *generated* employee_kind
--    column that is ALWAYS 'chatter' or 'model' respectively. The foreign key
--    is on (employee_id, employee_kind) referencing employees(id, kind). This
--    makes it impossible at the database level to accidentally attribute a
--    sale to a 'model' or 'weekly' employee.
--
-- =============================================================================


-- =============================================================================
--  1. Enums
-- =============================================================================
--  employee_kind: what type of employee this is.
--
--    weekly   - paid a flat $/week salary. Used for general staff.
--    chatter  - earns commission on chatter_sales they generate.
--    model    - earns a cut of withdrawals from their accounts.

do $$ begin
  create type employee_kind as enum ('weekly', 'chatter', 'model');
exception when duplicate_object then null;
end $$;


-- =============================================================================
--  2. employees
-- =============================================================================
--  One row per person tracked in OFM. The "kind" field decides which pay
--  fields apply:
--    weekly  → weekly_pay_cents set, rate null
--    chatter → rate set (commission %), weekly_pay_cents null
--    model   → rate set (model's share of withdrawals), weekly_pay_cents null

create table if not exists public.employees (
  id                 uuid primary key default gen_random_uuid(),

  -- Multi-tenant scope. Every employee belongs to exactly one agency.
  agency_id          uuid not null references public.agency(id) on delete cascade,

  -- Type of employee. Drives which pay fields are required.
  kind               employee_kind not null,

  -- Display name. Required and non-empty.
  name               text not null check (length(trim(name)) > 0),

  -- Optional free-text role label (e.g. "Senior Chatter", "Top Model").
  role               text,

  -- Weekly salary in cents. ONLY populated for kind = 'weekly'.
  weekly_pay_cents   bigint
                     check (weekly_pay_cents is null or weekly_pay_cents >= 0),

  -- Commission/cut rate as a decimal in [0, 1]. 0.10 means 10%.
  -- For 'chatter': % of sales they keep.
  -- For 'model':   % of withdrawals the model keeps (agency keeps 1 - rate).
  rate               numeric(5, 4)
                     check (rate is null or (rate >= 0 and rate <= 1)),

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,

  -- Enforce that exactly the right pay field is populated for the kind.
  -- (Without this, you could create a chatter with no rate and a weekly_pay,
  --  which would be nonsense.)
  constraint employees_pay_consistency check (
    (kind = 'weekly'
      and weekly_pay_cents is not null
      and rate is null)
    or
    (kind in ('chatter', 'model')
      and rate is not null
      and weekly_pay_cents is null)
  ),

  -- Composite uniqueness on (id, kind) — needed so child tables
  -- (chatter_sales, model_withdrawals) can FK on (id, kind) and enforce
  -- that sales only point at chatters, withdrawals only at models.
  constraint employees_id_kind_uniq unique (id, kind)
);

-- Common queries: "all active employees in this agency", "all chatters", etc.
create index if not exists employees_agency_active_idx
  on public.employees (agency_id) where deleted_at is null;
create index if not exists employees_agency_kind_idx
  on public.employees (agency_id, kind) where deleted_at is null;


-- =============================================================================
--  3. chatter_sales
-- =============================================================================
--  Sales attributed to a chatter. Their commission is computed as
--    amount_cents * employees.rate
--  ...at query time. We don't store the commission — it could change if the
--  rate is adjusted, and we always want it to reflect the current rate.

create table if not exists public.chatter_sales (
  id              uuid primary key default gen_random_uuid(),

  agency_id       uuid not null references public.agency(id) on delete cascade,

  employee_id     uuid not null,

  -- Generated constant 'chatter'. Combined with the composite FK below, this
  -- makes it IMPOSSIBLE to attribute a sale to a non-chatter employee.
  employee_kind   employee_kind not null
                  generated always as ('chatter'::employee_kind) stored,

  amount_cents    bigint not null check (amount_cents >= 0),

  -- Optional note (e.g. "PPV bundle", "tip from VIP").
  description     text,

  -- The DATE the sale happened (not the timestamp it was recorded).
  -- Use DATE because we report on calendar months in the agency's timezone.
  occurred_on     date not null,

  created_at      timestamptz not null default now(),
  deleted_at      timestamptz,

  -- The magic: this FK is on (employee_id, employee_kind), which forces
  -- employee_kind to match the employee's actual kind in the employees table.
  -- Since employee_kind is generated as 'chatter', only chatters can be referenced.
  foreign key (employee_id, employee_kind)
    references public.employees (id, kind) on delete restrict
);

-- Common queries:
--   "monthly sales total per agency"
--   "this chatter's sales for the month"
create index if not exists chatter_sales_agency_month_idx
  on public.chatter_sales (agency_id, occurred_on) where deleted_at is null;
create index if not exists chatter_sales_emp_month_idx
  on public.chatter_sales (employee_id, occurred_on) where deleted_at is null;


-- =============================================================================
--  4. model_withdrawals
-- =============================================================================
--  Payouts a model received from a platform (OF withdrawal, etc).
--  The model is owed amount * rate; the agency keeps amount * (1 - rate).

create table if not exists public.model_withdrawals (
  id              uuid primary key default gen_random_uuid(),

  agency_id       uuid not null references public.agency(id) on delete cascade,

  employee_id     uuid not null,

  -- Generated constant 'model' — same trick as chatter_sales. Only models
  -- can be referenced.
  employee_kind   employee_kind not null
                  generated always as ('model'::employee_kind) stored,

  amount_cents    bigint not null check (amount_cents >= 0),
  description     text,
  occurred_on     date not null,

  created_at      timestamptz not null default now(),
  deleted_at      timestamptz,

  foreign key (employee_id, employee_kind)
    references public.employees (id, kind) on delete restrict
);

create index if not exists model_withdrawals_agency_month_idx
  on public.model_withdrawals (agency_id, occurred_on) where deleted_at is null;
create index if not exists model_withdrawals_emp_month_idx
  on public.model_withdrawals (employee_id, occurred_on) where deleted_at is null;


-- =============================================================================
--  5. payments
-- =============================================================================
--  Money paid OUT to any employee (chatter, model, or weekly).
--  Tracks "we paid this person $X on this date."
--
--  Idempotency: client_ref is a UUID generated by the client before sending
--  the insert. If a slow network causes the client to retry the same payment,
--  the unique index on (employee_id, client_ref) makes the second insert fail
--  cleanly instead of double-recording the payment.

create table if not exists public.payments (
  id              uuid primary key default gen_random_uuid(),

  agency_id       uuid not null references public.agency(id) on delete cascade,

  -- Who got paid. on delete restrict: cannot delete an employee with payments
  -- on record — would orphan the financial history.
  employee_id     uuid not null
                  references public.employees(id) on delete restrict,

  amount_cents    bigint not null check (amount_cents > 0),
  note            text,

  -- The DATE the payment was made.
  paid_on         date not null,

  -- Client-generated idempotency key (use crypto.randomUUID()).
  -- Optional for backfill/import; required in new app code.
  client_ref      text,

  created_at      timestamptz not null default now(),
  deleted_at      timestamptz
);

-- Partial unique index: enforce idempotency only when client_ref is supplied.
-- (Imported/legacy payments without a ref are not blocked.)
create unique index if not exists payments_idempotency_idx
  on public.payments (employee_id, client_ref)
  where client_ref is not null and deleted_at is null;

create index if not exists payments_agency_month_idx
  on public.payments (agency_id, paid_on) where deleted_at is null;
create index if not exists payments_emp_month_idx
  on public.payments (employee_id, paid_on) where deleted_at is null;


-- =============================================================================
--  6. calendar_events
-- =============================================================================
--  Agency calendar. Free-form events with start/end time and notes.

create table if not exists public.calendar_events (
  id              uuid primary key default gen_random_uuid(),

  agency_id       uuid not null references public.agency(id) on delete cascade,

  title           text not null check (length(trim(title)) > 0),

  -- Use timestamptz so events display correctly across timezones.
  starts_at       timestamptz not null,

  -- Optional. If set, must be after starts_at.
  ends_at         timestamptz,

  notes           text,

  created_at      timestamptz not null default now(),
  deleted_at      timestamptz,

  constraint calendar_events_time_order
    check (ends_at is null or ends_at >= starts_at)
);

create index if not exists calendar_events_agency_time_idx
  on public.calendar_events (agency_id, starts_at) where deleted_at is null;


-- =============================================================================
--  7. updated_at trigger (employees only)
-- =============================================================================
--  Sales, withdrawals, payments, and events are append-only conceptually —
--  edits would distort the audit trail. Only employees get an updated_at
--  bump on edit.

drop trigger if exists employees_touch_updated_at on public.employees;
create trigger employees_touch_updated_at
  before update on public.employees
  for each row execute function public.touch_updated_at();


-- =============================================================================
--  8. Row Level Security
-- =============================================================================
--  Same pattern for every table: only agency members can do anything.
--  is_agency_member() comes from 0001_tenancy.sql.

alter table public.employees          enable row level security;
alter table public.chatter_sales      enable row level security;
alter table public.model_withdrawals  enable row level security;
alter table public.payments           enable row level security;
alter table public.calendar_events    enable row level security;

-- One policy per table, applied to all operations.
-- using: which rows can be SELECTed/UPDATEd/DELETEd.
-- with check: which rows can be INSERTed/UPDATEd (prevents impersonating
-- another agency on write).

do $$
declare
  t text;
  table_names text[] := array[
    'employees',
    'chatter_sales',
    'model_withdrawals',
    'payments',
    'calendar_events'
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
--  9. Monthly summary view (sanity check from SQL editor)
-- =============================================================================
--  Per-employee totals for the current month, agency-scoped via RLS.
--  Use this when debugging from the Supabase SQL editor — the app computes
--  the same numbers client-side.

create or replace view public.employee_month_summary
with (security_invoker = true) as
select
  e.id                                          as employee_id,
  e.agency_id,
  e.kind,
  e.name,
  date_trunc('month', d.month_start)::date      as month_start,
  -- Gross volume the employee generated this month.
  coalesce(s.sales_cents, 0)                    as sales_cents,
  coalesce(w.withdrawals_cents, 0)              as withdrawals_cents,
  -- What they earned this month (commission or fixed pay × ~4 weeks).
  case e.kind
    when 'chatter' then round(coalesce(s.sales_cents, 0)       * e.rate)::bigint
    when 'model'   then round(coalesce(w.withdrawals_cents, 0) * e.rate)::bigint
    when 'weekly'  then coalesce(e.weekly_pay_cents, 0) * 4
  end                                           as earned_cents,
  -- What we've actually paid them this month.
  coalesce(p.paid_cents, 0)                     as paid_cents
from public.employees e
cross join lateral (
  select date_trunc('month', now() at time zone 'America/New_York')::date as month_start
) d
left join lateral (
  select sum(amount_cents)::bigint as sales_cents
  from public.chatter_sales
  where employee_id = e.id
    and deleted_at is null
    and occurred_on >= d.month_start
    and occurred_on <  (d.month_start + interval '1 month')
) s on true
left join lateral (
  select sum(amount_cents)::bigint as withdrawals_cents
  from public.model_withdrawals
  where employee_id = e.id
    and deleted_at is null
    and occurred_on >= d.month_start
    and occurred_on <  (d.month_start + interval '1 month')
) w on true
left join lateral (
  select sum(amount_cents)::bigint as paid_cents
  from public.payments
  where employee_id = e.id
    and deleted_at is null
    and paid_on >= d.month_start
    and paid_on <  (d.month_start + interval '1 month')
) p on true
where e.deleted_at is null;


-- =============================================================================
--  End of 0002_ofm.sql
-- =============================================================================
