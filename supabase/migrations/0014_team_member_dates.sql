-- =============================================================================
--  0014_team_member_dates.sql
--  Optional start_date / end_date on team_members.
--  An employee is "former" once end_date is set and on or before today.
-- =============================================================================

alter table public.team_members
  add column if not exists start_date date,
  add column if not exists end_date   date;

alter table public.team_members
  drop constraint if exists team_members_date_order;

alter table public.team_members
  add constraint team_members_date_order check (
    end_date is null or start_date is null or end_date >= start_date
  );

-- Index for "show me active members" filtering. We can't use current_date in
-- an index expression (it's not immutable), so we just index end_date and
-- the query filters at runtime.
create index if not exists team_members_end_date_idx
  on public.team_members (agency_id, end_date)
  where deleted_at is null;

-- =============================================================================
--  End of 0014_team_member_dates.sql
-- =============================================================================
