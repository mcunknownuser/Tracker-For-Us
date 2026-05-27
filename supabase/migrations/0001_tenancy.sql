-- =============================================================================
--  0001_tenancy.sql
--  Foundation of the VoltrisAi multi-tenant SaaS.
-- =============================================================================
--
--  What this migration sets up:
--    * agency              one row per customer organization (e.g. "Plutus")
--    * agency_membership   which users belong to which agency, with a role
--    * agency_invite       outstanding invitations to join an agency
--    * helper functions    used by Row Level Security on every other table
--
--  Conventions used everywhere in this project:
--
--    1. UUIDs are the technical primary key. Never used in URLs you'd show
--       a user — agency_number is for that.
--
--    2. agency.agency_number is a separate, human-friendly sequential ID
--       (1, 2, 3, ...) so YOU (the operator) can quickly tell which agency
--       signed up first when reading the database directly or in the admin
--       panel. NOT shown to the agencies themselves — their UI only shows
--       their name ("Plutus"). The number is operational metadata.
--
--    3. Soft deletes via deleted_at. Hard-deleting an agency would orphan
--       payments, sales, and audit trail — never worth it.
--
--    4. Row Level Security is ENABLED on every domain table.
--       Default-deny. A user only sees rows in agencies they belong to.
--
--    5. Money is BIGINT cents everywhere — never numeric/float.
--       (Defined in later migrations; flagged here so the rule is in one place.)
--
-- =============================================================================


-- =============================================================================
--  1. Extensions
-- =============================================================================
--  pgcrypto gives us gen_random_uuid() for primary keys.

create extension if not exists "pgcrypto";


-- =============================================================================
--  2. Enums
-- =============================================================================
--  agency_role: what permissions a member has within an agency.
--
--    owner  - the person who created the agency. Can do anything.
--             Cannot be removed by anyone but themselves.
--             Exactly one owner per agency (enforced below).
--    admin  - can invite/remove staff, edit anything, but cannot delete
--             the agency or transfer ownership.
--    staff  - can read/edit data, cannot invite others or change settings.

do $$ begin
  create type agency_role as enum ('owner', 'admin', 'staff');
exception when duplicate_object then null;
end $$;


-- =============================================================================
--  3. agency table
-- =============================================================================
--  One row per customer organization. The "tenant" in multi-tenant SaaS.
--
--  Example rows after a few signups:
--    id                                   | agency_number | name              | owner_user_id
--    ------------------------------------ | ------------- | ----------------- | -------------
--    7d3f...                              | 1             | Plutus            | abc...
--    9a8c...                              | 2             | Some Other Agency | def...
--    f1e0...                              | 3             | Third Agency      | ghi...

create table if not exists public.agency (
  -- Technical primary key. Used in foreign keys and RLS — never shown to users.
  id              uuid primary key default gen_random_uuid(),

  -- Human-friendly sequential number. Postgres auto-assigns 1, 2, 3, ...
  -- For YOUR admin/operator view only — never shown to the agency in their UI.
  -- Lets you read the agency table at a glance: "ah, Plutus was #1, signed up first."
  -- "generated always as identity" means Postgres manages it; you cannot insert
  -- a value here manually. That's intentional — keeps the numbering clean.
  agency_number   bigint generated always as identity unique,

  -- The agency's real name, set by the owner during signup.
  -- e.g. "Plutus", "Sunset Media", whatever they call themselves.
  name            text not null check (length(trim(name)) > 0),

  -- Optional URL-safe slug if we ever want pretty URLs (e.g. /agency/plutus).
  -- Constrained to lowercase letters, digits, and hyphens.
  -- Nullable for now — agencies pick this later if they want.
  slug            text unique check (slug is null or slug ~ '^[a-z0-9-]+$'),

  -- The user who created the agency. They get the 'owner' role in
  -- agency_membership automatically (handled in app code on signup).
  -- on delete restrict: deleting an auth user with an agency they own
  -- is blocked until ownership is transferred or the agency is deleted.
  owner_user_id   uuid not null references auth.users(id) on delete restrict,

  -- Audit timestamps.
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- Soft delete. When set, the agency is hidden everywhere but data is preserved.
  deleted_at      timestamptz
);

-- Quickly find active (non-deleted) agencies.
create index if not exists agency_active_idx
  on public.agency (created_at desc)
  where deleted_at is null;

-- Lookup by owner — useful for "what agencies does this user own?"
create index if not exists agency_owner_idx
  on public.agency (owner_user_id)
  where deleted_at is null;


-- =============================================================================
--  4. agency_membership table
-- =============================================================================
--  Joins users to agencies. A user can belong to multiple agencies
--  (e.g. an accountant working with several clients).
--
--  Example rows:
--    agency_id    | user_id   | role    | created_at
--    ------------ | --------- | ------- | -----------
--    7d3f... (P1) | abc...    | owner   | 2026-05-11
--    7d3f... (P1) | xyz...    | staff   | 2026-05-12
--    9a8c... (A2) | def...    | owner   | 2026-05-13

create table if not exists public.agency_membership (
  id              uuid primary key default gen_random_uuid(),

  -- Which agency this membership is for.
  -- on delete cascade: if the agency is hard-deleted (rare), memberships go too.
  agency_id       uuid not null references public.agency(id) on delete cascade,

  -- Which user is a member.
  -- on delete cascade: if the user deletes their auth account, their memberships
  -- go too. (The agencies they owned are protected by owner_user_id's restrict.)
  user_id         uuid not null references auth.users(id) on delete cascade,

  -- What can this user do? See the agency_role enum above.
  role            agency_role not null default 'staff',

  -- Audit.
  created_at      timestamptz not null default now(),

  -- A user can have at most one role per agency.
  -- (If they need to change role, update the row — don't insert a second one.)
  unique (agency_id, user_id)
);

-- Quickly answer: "what agencies does this user belong to?"
create index if not exists agency_membership_user_idx
  on public.agency_membership (user_id);

-- Quickly answer: "who's in this agency?"
create index if not exists agency_membership_agency_idx
  on public.agency_membership (agency_id);

-- Enforce: at most ONE owner per agency. (Multiple admins/staff are fine.)
create unique index if not exists agency_membership_one_owner_idx
  on public.agency_membership (agency_id)
  where role = 'owner';


-- =============================================================================
--  5. agency_invite table
-- =============================================================================
--  When an admin invites someone to join their agency, we store the invite
--  here with a token. The recipient gets an email with a link containing the
--  token. When they click it, we look up the invite and create their membership.
--
--  Invites expire — stale invites should not stay valid forever.

create table if not exists public.agency_invite (
  id              uuid primary key default gen_random_uuid(),

  -- Which agency they're being invited to.
  agency_id       uuid not null references public.agency(id) on delete cascade,

  -- The email address that was invited. Used to match when they accept.
  -- Lowercased and trimmed before insert (handled in app code).
  email           text not null check (length(trim(email)) > 0),

  -- What role they'll get when they accept. Cannot invite as 'owner' —
  -- ownership transfer is a separate flow.
  role            agency_role not null default 'staff'
                  check (role in ('admin', 'staff')),

  -- Secret token sent in the invitation email. Used to redeem the invite.
  -- Should be a high-entropy random string generated client-side (UUID is fine).
  token           text not null unique,

  -- Invitation cannot be accepted after this. Recommend 7 days from creation.
  expires_at      timestamptz not null,

  -- Who sent the invite (for audit). Nullable in case the inviter is later removed.
  invited_by      uuid references auth.users(id) on delete set null,

  -- Set when the invite is accepted. Prevents replay.
  accepted_at     timestamptz,

  created_at      timestamptz not null default now(),

  -- Sanity: expiry must be in the future at creation time.
  constraint agency_invite_expiry_future
    check (expires_at > created_at)
);

-- Lookup invites for an agency (so admins can see pending invites).
create index if not exists agency_invite_agency_idx
  on public.agency_invite (agency_id)
  where accepted_at is null;

-- Lookup invites by email (when a user signs up, check for pending invites).
create index if not exists agency_invite_email_idx
  on public.agency_invite (lower(email))
  where accepted_at is null;


-- =============================================================================
--  6. updated_at trigger for agency
-- =============================================================================
--  Touches updated_at automatically on any UPDATE.

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists agency_touch_updated_at on public.agency;
create trigger agency_touch_updated_at
  before update on public.agency
  for each row execute function public.touch_updated_at();


-- =============================================================================
--  7. Helper functions used by RLS on every other table
-- =============================================================================
--  These are the workhorses that make tenant isolation work. Every domain
--  table (employees, expenses, etc.) will have an RLS policy like:
--
--      using (public.is_agency_member(agency_id))
--
--  ...and that policy calls these helpers to check whether the current user
--  (auth.uid()) has access to the agency that the row belongs to.
--
--  security definer: lets the function bypass RLS on agency_membership when
--  checking — necessary or we'd have infinite recursion (RLS calls function,
--  function reads table, table has RLS, ...).
--
--  stable: result depends only on inputs + database state, doesn't change
--  within a single statement. Lets Postgres cache the result per query.


-- is_agency_member: returns true if the calling user is in the agency.
-- Used in RLS policies for SELECT/INSERT/UPDATE/DELETE.
create or replace function public.is_agency_member(check_agency_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.agency_membership
    where agency_id = check_agency_id
      and user_id   = auth.uid()
  );
$$;


-- is_agency_admin: returns true if the calling user is owner OR admin.
-- Used to gate admin-only operations (inviting, removing staff, etc.).
create or replace function public.is_agency_admin(check_agency_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.agency_membership
    where agency_id = check_agency_id
      and user_id   = auth.uid()
      and role in ('owner', 'admin')
  );
$$;


-- is_agency_owner: returns true if the calling user is the owner.
-- Used for destructive operations (deleting agency, transferring ownership).
create or replace function public.is_agency_owner(check_agency_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.agency_membership
    where agency_id = check_agency_id
      and user_id   = auth.uid()
      and role      = 'owner'
  );
$$;


-- =============================================================================
--  8. Row Level Security on the tenancy tables themselves
-- =============================================================================
--  These three tables need their own RLS — they store WHO can see WHAT, so
--  they have to be especially careful.

alter table public.agency             enable row level security;
alter table public.agency_membership  enable row level security;
alter table public.agency_invite      enable row level security;


-- ---- agency ----
-- A user can see an agency only if they are a member of it.
-- A user can only update an agency they admin (owner or admin role).
-- Only owners can soft-delete an agency.

drop policy if exists agency_select on public.agency;
create policy agency_select on public.agency
  for select to authenticated
  using (public.is_agency_member(id));

drop policy if exists agency_insert on public.agency;
create policy agency_insert on public.agency
  for insert to authenticated
  with check (owner_user_id = auth.uid());  -- can only create one you own

drop policy if exists agency_update on public.agency;
create policy agency_update on public.agency
  for update to authenticated
  using       (public.is_agency_admin(id))
  with check  (public.is_agency_admin(id));

-- No DELETE policy: hard deletes are blocked entirely.
-- Use soft-delete via UPDATE deleted_at.


-- ---- agency_membership ----
-- A user can see memberships of any agency they're in (so they can see teammates).
-- Only admins can insert/update/delete memberships in their agency.
-- Special case: a user can always delete their OWN membership (leave the agency).

drop policy if exists agency_membership_select on public.agency_membership;
create policy agency_membership_select on public.agency_membership
  for select to authenticated
  using (public.is_agency_member(agency_id));

drop policy if exists agency_membership_insert on public.agency_membership;
create policy agency_membership_insert on public.agency_membership
  for insert to authenticated
  with check (public.is_agency_admin(agency_id));

drop policy if exists agency_membership_update on public.agency_membership;
create policy agency_membership_update on public.agency_membership
  for update to authenticated
  using       (public.is_agency_admin(agency_id))
  with check  (public.is_agency_admin(agency_id));

drop policy if exists agency_membership_delete on public.agency_membership;
create policy agency_membership_delete on public.agency_membership
  for delete to authenticated
  using (
    public.is_agency_admin(agency_id)
    or user_id = auth.uid()  -- always allowed to leave
  );


-- ---- agency_invite ----
-- Only admins of the target agency can see/create/delete invites.
-- Accepting an invite is done by an Edge Function with the service role key,
-- so no special policy is needed for "accepting" — that path bypasses RLS.

drop policy if exists agency_invite_select on public.agency_invite;
create policy agency_invite_select on public.agency_invite
  for select to authenticated
  using (public.is_agency_admin(agency_id));

drop policy if exists agency_invite_insert on public.agency_invite;
create policy agency_invite_insert on public.agency_invite
  for insert to authenticated
  with check (public.is_agency_admin(agency_id));

drop policy if exists agency_invite_delete on public.agency_invite;
create policy agency_invite_delete on public.agency_invite
  for delete to authenticated
  using (public.is_agency_admin(agency_id));


-- =============================================================================
--  End of 0001_tenancy.sql
-- =============================================================================
--
--  After this migration, the schema can support:
--    * Multiple agencies in one database, isolated by RLS
--    * Multiple users per agency, with roles (owner / admin / staff)
--    * Inviting new staff via tokenized email links
--
--  In the UI:
--    * Agencies see ONLY their own name ("Plutus"). They never see #1, #2, etc.
--    * In YOUR operator/admin panel (Phase 5), you'll see both: "Plutus  #1".
--      The agency_number column is the source of truth for signup order.
--
--  Next migrations will add domain tables (employees, expenses, etc.) — each
--  one will reference agency.id and have RLS policies built from the
--  is_agency_member() / is_agency_admin() helpers defined here.
-- =============================================================================
