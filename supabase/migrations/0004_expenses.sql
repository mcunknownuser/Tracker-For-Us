-- =============================================================================
--  0004_expenses.sql
--  Expense tracking domain tables.
-- =============================================================================
--
--  What this migration sets up:
--    * expense_categories   user-defined buckets for expenses (e.g.
--                           "Subscriptions", "Employee Pay")
--    * payment_methods      how an expense was paid (e.g. "Wise", "Crypto")
--    * expenses             individual expense entries
--    * seed_agency_expense_defaults()  helper called on new agency signup
--                           to populate sensible default categories and methods
--
--  Why a seed function instead of static inserts:
--    In a multi-tenant SaaS, each agency needs its OWN set of default
--    categories. We can't seed them once globally. The app calls
--    seed_agency_expense_defaults(agency_id) right after creating a new
--    agency so the new owner sees something useful instead of empty pickers.
--
-- =============================================================================


-- =============================================================================
--  1. expense_categories
-- =============================================================================
--  Buckets for organizing expenses. Each agency manages their own list.
--  color is a hex string used for UI badges and chart segments.

create table if not exists public.expense_categories (
  id              uuid primary key default gen_random_uuid(),

  agency_id       uuid not null references public.agency(id) on delete cascade,

  name            text not null check (length(trim(name)) > 0),

  -- Display color for UI. Default is brand indigo.
  -- Stored as hex including the '#'. Validate format with a regex.
  color           text not null default '#6366f1'
                  check (color ~ '^#[0-9a-fA-F]{6}$'),

  -- For drag-to-reorder in the UI. Lower numbers appear first.
  sort_order      int not null default 0,

  created_at      timestamptz not null default now(),
  deleted_at      timestamptz,

  -- A category name should be unique per agency. Different agencies can
  -- both have "Subscriptions" without conflict.
  constraint expense_categories_agency_name_uniq
    unique (agency_id, name)
);

create index if not exists expense_categories_agency_sorted_idx
  on public.expense_categories (agency_id, sort_order)
  where deleted_at is null;


-- =============================================================================
--  2. payment_methods
-- =============================================================================
--  How an expense was paid. Same structure as expense_categories.

create table if not exists public.payment_methods (
  id              uuid primary key default gen_random_uuid(),

  agency_id       uuid not null references public.agency(id) on delete cascade,

  name            text not null check (length(trim(name)) > 0),

  color           text not null default '#6366f1'
                  check (color ~ '^#[0-9a-fA-F]{6}$'),

  sort_order      int not null default 0,

  created_at      timestamptz not null default now(),
  deleted_at      timestamptz,

  constraint payment_methods_agency_name_uniq
    unique (agency_id, name)
);

create index if not exists payment_methods_agency_sorted_idx
  on public.payment_methods (agency_id, sort_order)
  where deleted_at is null;


-- =============================================================================
--  3. expenses
-- =============================================================================
--  Individual expense entries. The bulk of what users add day-to-day.
--
--  category_id and payment_method_id are nullable + ON DELETE SET NULL.
--  Why: if you delete a category, you don't want to lose the expense entries
--  that referenced it — they should just go to "(no category)". Same for
--  payment methods.

create table if not exists public.expenses (
  id                uuid primary key default gen_random_uuid(),

  agency_id         uuid not null references public.agency(id) on delete cascade,

  -- What was the expense for. Free-text, required.
  name              text not null check (length(trim(name)) > 0),

  -- Strictly positive (an expense of $0 is meaningless — it should be deleted
  -- instead).
  amount_cents      bigint not null check (amount_cents > 0),

  incurred_on       date not null,

  category_id       uuid references public.expense_categories(id) on delete set null,
  payment_method_id uuid references public.payment_methods(id) on delete set null,

  note              text,

  -- Mark as recurring so reports can distinguish one-off vs recurring spend.
  -- For v1 this is just a flag — actual auto-creation of recurring expenses
  -- is a later feature.
  is_recurring      boolean not null default false,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz
);

create index if not exists expenses_agency_month_idx
  on public.expenses (agency_id, incurred_on desc)
  where deleted_at is null;
create index if not exists expenses_category_idx
  on public.expenses (category_id) where deleted_at is null;
create index if not exists expenses_method_idx
  on public.expenses (payment_method_id) where deleted_at is null;


-- =============================================================================
--  4. updated_at trigger
-- =============================================================================
--  Expenses can be edited (typo in name, wrong amount). Categories and
--  payment methods get their own triggers too — UI users will rename them.

drop trigger if exists expenses_touch_updated_at on public.expenses;
create trigger expenses_touch_updated_at
  before update on public.expenses
  for each row execute function public.touch_updated_at();


-- =============================================================================
--  5. seed_agency_expense_defaults() helper
-- =============================================================================
--  Call this immediately after creating a new agency to populate sensible
--  defaults. Idempotent — does nothing if categories or methods already
--  exist for that agency.
--
--  Usage from app code (after creating an agency):
--    select public.seed_agency_expense_defaults('<agency-uuid>');

create or replace function public.seed_agency_expense_defaults(target_agency_id uuid)
returns void
language plpgsql
security invoker
as $$
begin
  -- Default categories.
  insert into public.expense_categories (agency_id, name, color, sort_order)
  select target_agency_id, name, color, sort_order from (values
    ('Subscriptions'::text, '#3b82f6'::text, 0::int),
    ('Miscellaneous',       '#8b5cf6',       1),
    ('Employee Pay',        '#10b981',       2)
  ) t(name, color, sort_order)
  where not exists (
    select 1 from public.expense_categories where agency_id = target_agency_id
  );

  -- Default payment methods.
  insert into public.payment_methods (agency_id, name, color, sort_order)
  select target_agency_id, name, color, sort_order from (values
    ('Skrill'::text,       '#3b82f6'::text, 0::int),
    ('Wise',               '#10b981',       1),
    ('Crypto',             '#f59e0b',       2),
    ('Bank Transfer',      '#6366f1',       3),
    ('PayPal',             '#0ea5e9',       4),
    ('Cash',               '#475569',       5)
  ) t(name, color, sort_order)
  where not exists (
    select 1 from public.payment_methods where agency_id = target_agency_id
  );
end $$;


-- =============================================================================
--  6. Row Level Security
-- =============================================================================

alter table public.expense_categories  enable row level security;
alter table public.payment_methods     enable row level security;
alter table public.expenses            enable row level security;

do $$
declare
  t text;
  table_names text[] := array[
    'expense_categories',
    'payment_methods',
    'expenses'
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
--  End of 0004_expenses.sql
-- =============================================================================
