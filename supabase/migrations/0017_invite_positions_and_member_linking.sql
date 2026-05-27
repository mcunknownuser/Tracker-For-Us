-- =============================================================================
--  0017_invite_positions_and_member_linking.sql
--
--  Two related changes:
--
--  (1) Staff invites now carry a "position" — a staff_role_id. Admin picks
--      it when inviting someone as `staff`. Admin invites still don't need
--      a position (admins aren't tied to a department/role).
--
--  (2) team_members rows can be linked to an auth user. When an invite is
--      accepted, we try to auto-link any existing team_member with that
--      email. If none exists, the user appears in `list_unlinked_members`
--      so the admin can hit "Add as employee" and create one pre-filled
--      with the position chosen at invite time.
--
--  Why nullable user_id on team_members:
--    Plenty of team_members will never log in (e.g. payment-only contractors).
--    So user_id is optional. A partial unique index ensures a single user
--    can be linked to at most one active team_member per agency.
-- =============================================================================


-- ---------------------------------------------------------------------------
--  1. agency_invite.staff_role_id
-- ---------------------------------------------------------------------------

alter table public.agency_invite
  add column if not exists staff_role_id uuid references public.staff_roles(id) on delete set null;

-- We don't enforce "must be present when role=staff" at the DB layer —
-- the RPC does that. Letting old/admin rows exist with null keeps backfill
-- simple.


-- ---------------------------------------------------------------------------
--  2. team_members.user_id
-- ---------------------------------------------------------------------------

alter table public.team_members
  add column if not exists user_id uuid references auth.users(id) on delete set null;

-- At most one ACTIVE team_member per (agency, user). Inactive (deleted_at
-- set) rows are excluded so re-onboarding works.
create unique index if not exists team_members_agency_user_active_uniq
  on public.team_members (agency_id, user_id)
  where user_id is not null and deleted_at is null;


-- ---------------------------------------------------------------------------
--  3. create_agency_invite — now accepts an optional staff_role_id.
--     Drop + recreate because the signature changes.
-- ---------------------------------------------------------------------------

drop function if exists public.create_agency_invite(uuid, text, agency_role);

create or replace function public.create_agency_invite(
  p_agency_id      uuid,
  p_email          text,
  p_role           agency_role default 'staff',
  p_staff_role_id  uuid        default null
)
returns public.agency_invite
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite public.agency_invite;
  v_role_agency uuid;
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;

  if not public.is_agency_admin(p_agency_id) then
    raise exception 'not authorized to invite for this agency';
  end if;

  if p_role = 'owner' then
    raise exception 'cannot invite as owner';
  end if;

  if p_email is null or length(trim(p_email)) = 0 then
    raise exception 'email is required';
  end if;

  -- Staff invites must specify a position. Admin invites should not.
  if p_role = 'staff' and p_staff_role_id is null then
    raise exception 'a position is required for staff invites';
  end if;
  if p_role = 'admin' and p_staff_role_id is not null then
    raise exception 'admins do not have a position — leave it blank';
  end if;

  -- If a position was supplied, make sure it belongs to this agency.
  if p_staff_role_id is not null then
    select agency_id into v_role_agency
      from public.staff_roles
     where id = p_staff_role_id;
    if v_role_agency is null then
      raise exception 'position not found';
    end if;
    if v_role_agency <> p_agency_id then
      raise exception 'position does not belong to this agency';
    end if;
  end if;

  insert into public.agency_invite
    (agency_id, email, role, token, expires_at, invited_by, staff_role_id)
  values
    (p_agency_id, lower(trim(p_email)), p_role,
     public._invite_token(), now() + interval '7 days', auth.uid(),
     p_staff_role_id)
  returning * into v_invite;

  return v_invite;
end
$$;


-- ---------------------------------------------------------------------------
--  4. peek_agency_invite — now also returns position name + department.
--     Drop + recreate because the return type changes.
-- ---------------------------------------------------------------------------

drop function if exists public.peek_agency_invite(text);

create or replace function public.peek_agency_invite(p_token text)
returns table (
  invite_id        uuid,
  agency_id        uuid,
  agency_name      text,
  email            text,
  invite_role      agency_role,
  staff_role_id    uuid,
  staff_role_name  text,
  department_name  text,
  expires_at       timestamptz,
  accepted         boolean
)
language sql
security definer
stable
set search_path = public
as $$
  select
    i.id,
    i.agency_id,
    a.name,
    i.email,
    i.role,
    i.staff_role_id,
    sr.name,
    d.name,
    i.expires_at,
    (i.accepted_at is not null)
  from public.agency_invite i
  join public.agency a            on a.id  = i.agency_id
  left join public.staff_roles sr on sr.id = i.staff_role_id
  left join public.departments d  on d.id  = sr.department_id
  where i.token = p_token;
$$;


-- ---------------------------------------------------------------------------
--  5. accept_agency_invite — also tries to link an existing team_member.
--     Same signature as before; CREATE OR REPLACE is fine.
-- ---------------------------------------------------------------------------

create or replace function public.accept_agency_invite(p_token text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite     public.agency_invite;
  v_user_email text;
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;

  select * into v_invite from public.agency_invite where token = p_token;
  if not found then
    raise exception 'invite not found';
  end if;

  if v_invite.accepted_at is not null then
    raise exception 'invite already used';
  end if;

  if v_invite.expires_at <= now() then
    raise exception 'invite expired';
  end if;

  select email into v_user_email from auth.users where id = auth.uid();
  if v_user_email is null
     or lower(v_user_email) <> lower(v_invite.email) then
    raise exception 'this invite was sent to a different email';
  end if;

  -- Login access.
  insert into public.agency_membership (agency_id, user_id, role)
  values (v_invite.agency_id, auth.uid(), v_invite.role)
  on conflict (agency_id, user_id) do nothing;

  -- Auto-link to a pre-existing employee record, if any.
  -- We pick the oldest still-active team_member with a matching email and
  -- no user yet. If there are duplicates, the rest stay unlinked — the
  -- partial unique index makes "one user, one active team_member" a hard
  -- invariant per agency.
  update public.team_members
     set user_id = auth.uid()
   where id = (
     select id
       from public.team_members
      where agency_id   = v_invite.agency_id
        and user_id     is null
        and deleted_at  is null
        and email is not null
        and lower(email) = lower(v_invite.email)
      order by created_at asc
      limit 1
   );

  update public.agency_invite
     set accepted_at = now()
   where id = v_invite.id;

  return v_invite.agency_id;
end
$$;


-- ---------------------------------------------------------------------------
--  6. list_unlinked_members — memberships with no team_member.
--     Used by the Employees page to surface "needs an employee record".
-- ---------------------------------------------------------------------------

create or replace function public.list_unlinked_members(p_agency_id uuid)
returns table (
  user_id            uuid,
  email              text,
  joined_at          timestamptz,
  membership_role    agency_role,
  suggested_role_id  uuid,
  suggested_role_name text,
  suggested_dept_id  uuid,
  suggested_dept_name text
)
language sql
security definer
stable
set search_path = public
as $$
  select
    m.user_id,
    u.email,
    m.created_at,
    m.role,
    sr.id,
    sr.name,
    d.id,
    d.name
  from public.agency_membership m
  join auth.users u on u.id = m.user_id
  -- Suggested position comes from the most recent accepted invite for this
  -- email. May be null (e.g. owner, or membership added outside the invite
  -- flow). We use lateral so we get exactly one row.
  left join lateral (
    select i.staff_role_id
      from public.agency_invite i
     where i.agency_id   = p_agency_id
       and i.accepted_at is not null
       and lower(i.email) = lower(u.email)
     order by i.accepted_at desc
     limit 1
  ) inv on true
  left join public.staff_roles sr on sr.id = inv.staff_role_id
  left join public.departments d  on d.id  = sr.department_id
  where m.agency_id = p_agency_id
    and m.role <> 'owner'
    and not exists (
      select 1 from public.team_members tm
       where tm.agency_id  = p_agency_id
         and tm.user_id    = m.user_id
         and tm.deleted_at is null
    )
    -- RLS-equivalent: only show to admins of this agency.
    and public.is_agency_admin(p_agency_id);
$$;


-- ---------------------------------------------------------------------------
--  7. Permissions
-- ---------------------------------------------------------------------------

grant execute on function public.create_agency_invite(uuid, text, agency_role, uuid) to authenticated;
grant execute on function public.peek_agency_invite(text)                            to anon, authenticated;
grant execute on function public.accept_agency_invite(text)                          to authenticated;
grant execute on function public.list_unlinked_members(uuid)                         to authenticated;
