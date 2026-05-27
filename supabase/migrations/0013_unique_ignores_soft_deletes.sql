-- =============================================================================
--  0013_unique_ignores_soft_deletes.sql
--  Replace name-uniqueness constraints with partial unique indexes that
--  only consider non-deleted rows.
-- =============================================================================
--
--  The bug:
--    expense_categories has `unique (agency_id, name)`. When a row is
--    soft-deleted (deleted_at set), the constraint STILL treats its name
--    as taken. The user can't re-create a category with the same name.
--    Same applies to payment_methods, staff_roles, departments,
--    tracking_links.
--
--  The fix:
--    Drop the table-level uniqueness constraints. Add partial unique
--    indexes that say "names must be unique AMONG active rows only".
-- =============================================================================


-- 1. expense_categories
alter table public.expense_categories
  drop constraint if exists expense_categories_agency_name_uniq;
drop index if exists public.expense_categories_agency_name_uniq;

create unique index if not exists expense_categories_agency_name_active_uniq
  on public.expense_categories (agency_id, name)
  where deleted_at is null;


-- 2. payment_methods
alter table public.payment_methods
  drop constraint if exists payment_methods_agency_name_uniq;
drop index if exists public.payment_methods_agency_name_uniq;

create unique index if not exists payment_methods_agency_name_active_uniq
  on public.payment_methods (agency_id, name)
  where deleted_at is null;


-- 3. staff_roles
alter table public.staff_roles
  drop constraint if exists staff_roles_dept_name_uniq;
drop index if exists public.staff_roles_dept_name_uniq;

create unique index if not exists staff_roles_dept_name_active_uniq
  on public.staff_roles (department_id, name)
  where deleted_at is null;


-- 4. departments
alter table public.departments
  drop constraint if exists departments_agency_name_uniq;
drop index if exists public.departments_agency_name_uniq;

create unique index if not exists departments_agency_name_active_uniq
  on public.departments (agency_id, name)
  where deleted_at is null;


-- 5. tracking_links
alter table public.tracking_links
  drop constraint if exists tracking_links_user_name_uniq;
drop index if exists public.tracking_links_user_name_uniq;

create unique index if not exists tracking_links_user_name_active_uniq
  on public.tracking_links (user_id, name)
  where deleted_at is null;


-- =============================================================================
--  End of 0013_unique_ignores_soft_deletes.sql
-- =============================================================================
1