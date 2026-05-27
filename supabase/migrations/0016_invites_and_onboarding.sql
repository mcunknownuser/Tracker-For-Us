-- =============================================================================
--  0016_invites_and_onboarding.sql
--
--  Phase 4: teammate invites + first-run wizard.
--
--  What this adds:
--    * agency.onboarding_completed_at  — null until the owner finishes the
--      first-run wizard. Used by the app to decide whether to show the
--      wizard or the routed app.
--
--    * Four RPCs for the invite flow. All are SECURITY DEFINER because:
--        - peek/accept must work for ANY caller who has the token
--        - create/regenerate must bypass the agency_invite RLS policy when
--          assigning tokens (the policy is admin-only-read, but we want to
--          return the freshly-minted row).
--
--  Invite lifecycle:
--    pending  -> token live, accepted_at IS NULL, expires_at in future
--    expired  -> accepted_at IS NULL, expires_at in past
--    accepted -> accepted_at IS NOT NULL (token is dead, single-use)
--
--  Tokens are two concatenated UUIDs with dashes stripped (~64 hex chars).
--  We use gen_random_uuid() instead of gen_random_bytes() because Supabase
--  installs pgcrypto in the `extensions` schema, but gen_random_uuid is in
--  Postgres core and works without the extension being on the search path.
-- =============================================================================


-- ---------------------------------------------------------------------------
--  1. Onboarding flag on agency
-- ---------------------------------------------------------------------------

alter table public.agency
  add column if not exists onboarding_completed_at timestamptz;


-- ---------------------------------------------------------------------------
--  2. Helper: url-safe random token
--     Two gen_random_uuid()s, hyphens stripped, concatenated. ~256 bits of
--     entropy, ~64 hex chars. Url-safe by virtue of being 0-9a-f only.
-- ---------------------------------------------------------------------------

create or replace function public._invite_token()
returns text
language sql
volatile
set search_path = public
as $$
  select replace(gen_random_uuid()::text, '-', '')
      || replace(gen_random_uuid()::text, '-', '');
$$;


-- ---------------------------------------------------------------------------
--  3. create_agency_invite(agency_id, email, role)
--     Admin-only. Returns the freshly-created invite row.
-- ---------------------------------------------------------------------------

create or replace function public.create_agency_invite(
  p_agency_id uuid,
  p_email     text,
  p_role      agency_role default 'staff'
)
returns public.agency_invite
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite public.agency_invite;
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

  insert into public.agency_invite
    (agency_id, email, role, token, expires_at, invited_by)
  values
    (p_agency_id, lower(trim(p_email)), p_role,
     public._invite_token(), now() + interval '7 days', auth.uid())
  returning * into v_invite;

  return v_invite;
end
$$;


-- ---------------------------------------------------------------------------
--  4. regenerate_agency_invite(invite_id)
--     Rotates the token + resets the expiry on a pending invite.
--     Once accepted, an invite is dead — admin must create a fresh one.
-- ---------------------------------------------------------------------------

create or replace function public.regenerate_agency_invite(p_invite_id uuid)
returns public.agency_invite
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite public.agency_invite;
begin
  select * into v_invite from public.agency_invite where id = p_invite_id;
  if not found then
    raise exception 'invite not found';
  end if;

  if not public.is_agency_admin(v_invite.agency_id) then
    raise exception 'not authorized';
  end if;

  if v_invite.accepted_at is not null then
    raise exception 'invite already accepted — create a new one instead';
  end if;

  update public.agency_invite
     set token      = public._invite_token(),
         expires_at = now() + interval '7 days'
   where id = p_invite_id
  returning * into v_invite;

  return v_invite;
end
$$;


-- ---------------------------------------------------------------------------
--  5. peek_agency_invite(token)
--     Anyone holding the token can read a small projection of the invite.
--     Used by the AcceptInvite page so we can show "Join {agency}?".
--     Returns nothing if the token doesn't exist — caller treats that the
--     same as expired/invalid.
-- ---------------------------------------------------------------------------

create or replace function public.peek_agency_invite(p_token text)
returns table (
  invite_id    uuid,
  agency_id    uuid,
  agency_name  text,
  email        text,
  invite_role  agency_role,
  expires_at   timestamptz,
  accepted     boolean
)
language sql
security definer
stable
set search_path = public
as $$
  select i.id, i.agency_id, a.name, i.email, i.role, i.expires_at,
         (i.accepted_at is not null)
    from public.agency_invite i
    join public.agency a on a.id = i.agency_id
   where i.token = p_token;
$$;


-- ---------------------------------------------------------------------------
--  6. accept_agency_invite(token)
--     Caller must be signed in. Caller's email must match the invite's
--     email (case-insensitive). Creates the membership and marks the
--     invite accepted in a single transaction.
--
--     Returns the agency_id so the client can switch context immediately.
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

  -- Idempotent: if they're already a member (e.g. clicked twice), no-op.
  insert into public.agency_membership (agency_id, user_id, role)
  values (v_invite.agency_id, auth.uid(), v_invite.role)
  on conflict (agency_id, user_id) do nothing;

  update public.agency_invite
     set accepted_at = now()
   where id = v_invite.id;

  return v_invite.agency_id;
end
$$;


-- ---------------------------------------------------------------------------
--  7. Permissions
--     peek is callable by anon so the AcceptInvite page can render before
--     the user signs in. The token itself is the access control.
-- ---------------------------------------------------------------------------

grant execute on function public.create_agency_invite(uuid, text, agency_role)  to authenticated;
grant execute on function public.regenerate_agency_invite(uuid)                  to authenticated;
grant execute on function public.peek_agency_invite(text)                        to anon, authenticated;
grant execute on function public.accept_agency_invite(text)                      to authenticated;
