-- =============================================================================
--  0009_role_cleanup.sql
--  Reorganize the seeded staff_roles taxonomy so the UI can present:
--
--    Department OFM:    Weekly, Chatter, Model    (kind = ofm_*)
--    Department Reddit: (no sub-roles)
--    Department Staff:  Manager, Employee         (kind = staff)
--
--  Changes:
--    * Rename "OFM Weekly"  -> "Weekly"
--    * Rename "OFM Chatter" -> "Chatter"
--    * Rename "OFM Model"   -> "Model"
--    * Delete Server / Bartender / Host (unused for content-agency context)
--    * Delete "Reddit" role (Reddit is a department, not a role)
--    * Insert "Employee" role for any agency missing it
--    * Replace seed_agency_staff_defaults() for future agencies
-- =============================================================================


-- 1. Rename existing OFM-prefixed roles (idempotent — only renames if found).
update public.staff_roles
set name = 'Weekly', sort_order = 100
where name = 'OFM Weekly' and deleted_at is null;

update public.staff_roles
set name = 'Chatter', sort_order = 101
where name = 'OFM Chatter' and deleted_at is null;

update public.staff_roles
set name = 'Model', sort_order = 102
where name = 'OFM Model' and deleted_at is null;


-- 2. Delete roles that don't fit the agency-management context.
--    Soft-delete (mark deleted_at) so historical employee records that
--    reference these by string name aren't orphaned visually.
update public.staff_roles
set deleted_at = now()
where name in ('Server', 'Bartender', 'Host', 'Reddit')
  and deleted_at is null;


-- 3. Ensure every existing agency has an "Employee" role (kind = staff).
insert into public.staff_roles (agency_id, name, kind, sort_order)
select distinct sr.agency_id, 'Employee', 'staff', 1
from public.staff_roles sr
where not exists (
  select 1
  from public.staff_roles existing
  where existing.agency_id = sr.agency_id
    and existing.name = 'Employee'
    and existing.deleted_at is null
);


-- 4. Replace the seed function so NEW agencies get the right defaults.
create or replace function public.seed_agency_staff_defaults(target_agency_id uuid)
returns void
language plpgsql
security invoker
as $$
begin
  -- Roles for the new taxonomy:
  --   sort_order < 100  = Staff department
  --   sort_order 100+   = OFM sub-roles
  insert into public.staff_roles (agency_id, name, sort_order, kind)
  select target_agency_id, name, sort_order, kind from (values
    ('Manager'::text,  0::int,   'staff'::text),
    ('Employee',       1,        'staff'),
    ('Weekly',         100,      'ofm_weekly'),
    ('Chatter',        101,      'ofm_chatter'),
    ('Model',          102,      'ofm_model')
  ) t(name, sort_order, kind)
  where not exists (
    select 1 from public.staff_roles
    where agency_id = target_agency_id
      and deleted_at is null
  );

  -- OFM-specific role labels for the legacy Add OFM Employee modal.
  -- Kept here so the function shape matches the previous version.
  insert into public.employee_roles (agency_id, name, sort_order)
  select target_agency_id, name, sort_order from (values
    ('Chatter'::text,  0::int),
    ('Model',          1),
    ('Weekly',         2)
  ) t(name, sort_order)
  where not exists (
    select 1 from public.employee_roles where agency_id = target_agency_id
  );
end $$;


-- =============================================================================
--  End of 0009_role_cleanup.sql
-- =============================================================================
