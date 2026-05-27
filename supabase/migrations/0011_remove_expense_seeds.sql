-- =============================================================================
--  0011_remove_expense_seeds.sql
--  Stop seeding default expense categories and payment methods.
--
--  Why:
--    Each agency has its own bookkeeping vocabulary. The defaults we shipped
--    (Subscriptions, Skrill, Wise, Crypto, etc.) aren't universally relevant
--    and create noise. Agencies should add their own via the Settings page.
--
--  Changes:
--    1. Soft-delete every existing seeded category and method (any rows still
--       active). Existing expenses with category_id / payment_method_id
--       pointing at these stay intact — they just won't render a label,
--       and the row stops appearing in the picker.
--    2. Replace seed_agency_expense_defaults() with a no-op so new agencies
--       start with empty lists.
-- =============================================================================


-- 1. Soft-delete all existing rows in both tables.
update public.expense_categories set deleted_at = now() where deleted_at is null;
update public.payment_methods     set deleted_at = now() where deleted_at is null;


-- 2. Replace the seed function with a no-op. The function call site in
--    create_agency_for_current_user() stays — it just does nothing now.
create or replace function public.seed_agency_expense_defaults(target_agency_id uuid)
returns void
language plpgsql
security invoker
as $$
begin
  -- Intentionally empty. Agencies define their own expense categories
  -- and payment methods via the Settings page.
  perform target_agency_id;  -- suppress unused-parameter warning
end $$;


-- =============================================================================
--  End of 0011_remove_expense_seeds.sql
-- =============================================================================
