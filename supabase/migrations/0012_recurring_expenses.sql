-- =============================================================================
--  0012_recurring_expenses.sql
--  Real recurrence for expenses (manual roll-forward, not automated).
-- =============================================================================
--
--  Concept:
--    A recurring expense is a stream of normal expense rows. Each row records
--    one occurrence. The MOST RECENT row in a stream carries `next_due_on`,
--    marking when the next occurrence is scheduled. When the user clicks
--    "Log it" on the banner, we:
--      1. Create a new expense row dated next_due_on
--      2. Set its next_due_on to (current next_due_on + interval)
--      3. Clear next_due_on on the previous head row
--
--  Why not auto-create via cron:
--    Phase 6 territory. For now, the user is always in control.
-- =============================================================================


-- recurrence_kind: how often this stream repeats. Null = not recurring.
alter table public.expenses
  add column if not exists recurrence_kind text
  check (
    recurrence_kind is null
    or recurrence_kind in ('weekly', 'biweekly', 'monthly', 'yearly')
  );

-- next_due_on: when the NEXT occurrence is due. Only set on the head of a
-- recurring stream. Null on historical occurrences.
alter table public.expenses
  add column if not exists next_due_on date;

-- Consistency: if recurrence_kind is set, is_recurring must be true.
alter table public.expenses
  drop constraint if exists expenses_recurrence_consistency;
alter table public.expenses
  add constraint expenses_recurrence_consistency check (
    recurrence_kind is null or is_recurring = true
  );

-- Index for "what's due today" lookups.
create index if not exists expenses_due_idx
  on public.expenses (agency_id, next_due_on)
  where deleted_at is null and next_due_on is not null;


-- =============================================================================
--  End of 0012_recurring_expenses.sql
-- =============================================================================
