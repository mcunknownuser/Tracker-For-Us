-- =============================================================================
--  0018_department_layout_type.sql
--
--  Big-picture change: each agency now defines its own departments instead
--  of receiving fixed OFM/Reddit/Staff defaults. Every department carries
--  a layout_type that determines which page format it uses:
--
--    models    — chatter sales + model withdrawals UX (the old OFM page)
--    marketing — accounts + monthly income UX        (the old Reddit page)
--
--  Owners can have multiple departments of each type (e.g. 3 Models orgs +
--  2 Marketing orgs). Each shows up as its own sidebar tab.
--
--  Migration steps:
--    1. Create the enum
--    2. Add the column nullable
--    3. Backfill existing departments based on their seeded names
--    4. Make the column NOT NULL
--    5. Stop seeding default departments for NEW agencies
-- =============================================================================


-- ---------------------------------------------------------------------------
--  1. Enum
-- ---------------------------------------------------------------------------

do $$ begin
  create type department_layout as enum ('models', 'marketing');
exception when duplicate_object then null;
end $$;


-- ---------------------------------------------------------------------------
--  2. Column (nullable while we backfill)
-- ---------------------------------------------------------------------------

alter table public.departments
  add column if not exists layout_type department_layout;


-- ---------------------------------------------------------------------------
--  3. Backfill
--     OFM    -> models
--     Reddit -> marketing
--     Anything else (Staff, custom) -> models as a safe default.
--     Owners can change this later from Settings or by deleting + recreating.
-- ---------------------------------------------------------------------------

update public.departments set layout_type = 'models'
  where layout_type is null and lower(name) = 'ofm';

update public.departments set layout_type = 'marketing'
  where layout_type is null and lower(name) = 'reddit';

update public.departments set layout_type = 'models'
  where layout_type is null;


-- ---------------------------------------------------------------------------
--  4. Enforce NOT NULL going forward
-- ---------------------------------------------------------------------------

alter table public.departments
  alter column layout_type set not null;


-- ---------------------------------------------------------------------------
--  5. Stop seeding default departments for new agencies.
--     The owner now creates them in the onboarding wizard. We keep the
--     function around for callers / external tooling, but it just no-ops.
--
--     Existing agencies are unaffected — they keep whatever was seeded.
-- ---------------------------------------------------------------------------

create or replace function public.seed_agency_team_defaults(target_agency_id uuid)
returns void
language plpgsql
security invoker
as $$
begin
  -- Intentionally empty. Default departments + roles are no longer seeded;
  -- the owner picks them during onboarding.
  perform 1 where target_agency_id is not null;  -- silences unused-param lint
end $$;
