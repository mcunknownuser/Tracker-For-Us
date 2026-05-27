-- =============================================================================
--  0008_agency_bootstrap.sql
--  Single transactional helper for creating an agency on first signup.
-- =============================================================================
--
--  Why this exists:
--    The RLS policy on agency_membership requires is_agency_admin() to insert.
--    But on first signup, the user is not YET an admin — they're trying to
--    become one. This chicken-and-egg means a normal two-step insert
--    (agency then membership) would fail at step 2.
--
--    The clean fix is one SECURITY DEFINER function that:
--      1. Creates the agency
--      2. Inserts the owner membership
--      3. Seeds per-agency defaults (categories, methods, roles)
--    ...all in one transaction. Either all succeed, or all roll back —
--    no orphan agencies with no owner.
--
--  SECURITY DEFINER lets this function bypass RLS for the duration of the
--  call. The function itself enforces that the caller is the user who
--  becomes the owner.
--
-- =============================================================================


create or replace function public.create_agency_for_current_user(agency_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_agency_id   uuid;
  caller_user_id  uuid;
  trimmed_name    text;
begin
  -- 1. Identify the caller.
  caller_user_id := auth.uid();
  if caller_user_id is null then
    raise exception 'Not authenticated.';
  end if;

  -- 2. Validate the agency name.
  trimmed_name := trim(coalesce(agency_name, ''));
  if length(trimmed_name) = 0 then
    raise exception 'Agency name is required.';
  end if;

  -- 3. Create the agency. The caller becomes the owner.
  insert into public.agency (name, owner_user_id)
  values (trimmed_name, caller_user_id)
  returning id into new_agency_id;

  -- 4. Create the membership row marking the caller as the owner.
  insert into public.agency_membership (agency_id, user_id, role)
  values (new_agency_id, caller_user_id, 'owner');

  -- 5. Seed per-agency defaults so the new owner doesn't see empty pickers.
  perform public.seed_agency_expense_defaults(new_agency_id);
  perform public.seed_agency_staff_defaults(new_agency_id);

  return new_agency_id;
end $$;


-- Only authenticated users can call this — never anon.
revoke all on function public.create_agency_for_current_user(text) from public;
grant execute on function public.create_agency_for_current_user(text) to authenticated;


-- =============================================================================
--  End of 0008_agency_bootstrap.sql
-- =============================================================================
