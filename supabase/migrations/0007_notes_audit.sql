-- =============================================================================
--  0007_notes_audit.sql
--  Free-text notes per page + audit trail of all data changes.
-- =============================================================================
--
--  What this migration sets up:
--    * notes        per-page notes (one running list per tab/page)
--    * audit_log    one row per data change anywhere in the agency
--
--  Why audit_log includes prev_value/next_value:
--    Lets the UI show "you changed Sofia's commission from 50% to 55% on
--    May 3" without having to reconstruct from event sourcing. Stored as
--    JSONB so the same column shape works for any entity type.
--
--  Multi-tenancy:
--    Both tables include agency_id. In a multi-user agency we ALSO record
--    user_id on audit_log entries so you can see who made each change.
--
-- =============================================================================


-- =============================================================================
--  1. notes
-- =============================================================================
--  Free-text notes attached to a "tab" (page). The agency can pin running
--  reminders on the Dashboard, the Reddit page, etc.
--
--  Each note is a single entry — to update text, insert a new note, not
--  edit the existing one. Keeps history without an edit history table.

create table if not exists public.notes (
  id              uuid primary key default gen_random_uuid(),

  agency_id       uuid not null references public.agency(id) on delete cascade,

  -- Which page/tab this note belongs to. Free-text — values come from the
  -- frontend (e.g. "dashboard", "reddit", "tracking"). Not validated server-side
  -- so adding new tabs doesn't require a schema migration.
  tab             text not null check (length(trim(tab)) > 0),

  -- Who wrote the note. Nullable — if the user is later deleted, the note
  -- remains for posterity but loses attribution.
  author_user_id  uuid references auth.users(id) on delete set null,

  content         text not null check (length(trim(content)) > 0),

  created_at      timestamptz not null default now()
);

create index if not exists notes_agency_tab_idx
  on public.notes (agency_id, tab, created_at desc);
create index if not exists notes_agency_recent_idx
  on public.notes (agency_id, created_at desc);


-- =============================================================================
--  2. audit_log
-- =============================================================================
--  Append-only log of every data change. Powers the "Audit" view in the UI
--  and is the first thing to check when "wait, who changed this?"
--
--  entity_type and entity_id together identify what changed.
--    entity_type = 'employees',     entity_id = <employee uuid>
--    entity_type = 'expenses',      entity_id = <expense uuid>
--    entity_type = 'tracking_links',entity_id = <link uuid>
--    etc.
--
--  prev_value and next_value are JSONB snapshots of the row before/after.
--    For 'create' actions, prev_value is null.
--    For 'delete' actions, next_value is null.

create table if not exists public.audit_log (
  id              uuid primary key default gen_random_uuid(),

  agency_id       uuid not null references public.agency(id) on delete cascade,

  -- Who made the change. Nullable for system-generated changes (imports,
  -- automated tasks).
  user_id         uuid references auth.users(id) on delete set null,

  -- What kind of thing was changed.
  -- e.g. 'employees', 'expenses', 'tracking_links', 'payments'.
  entity_type     text not null check (length(trim(entity_type)) > 0),

  -- Which specific row (uuid). Nullable if the change is "bulk import"
  -- with no single target.
  entity_id       uuid,

  action          text not null check (action in ('create', 'update', 'delete')),

  -- Human-readable description for the UI (e.g. "Added expense: Office Rent").
  -- The app composes this when writing the log entry.
  description     text,

  -- Snapshots of the row state. JSONB lets us store any shape.
  prev_value      jsonb,
  next_value      jsonb,

  created_at      timestamptz not null default now()
);

create index if not exists audit_log_agency_recent_idx
  on public.audit_log (agency_id, created_at desc);
create index if not exists audit_log_agency_entity_idx
  on public.audit_log (agency_id, entity_type, entity_id);
create index if not exists audit_log_agency_user_idx
  on public.audit_log (agency_id, user_id, created_at desc);


-- =============================================================================
--  3. Row Level Security
-- =============================================================================
--  Notes: full CRUD for any member of the agency.
--  Audit log: members can READ, but only INSERTS are allowed
--             (no UPDATE or DELETE — append-only). Deleting audit entries
--             would defeat the purpose.

alter table public.notes      enable row level security;
alter table public.audit_log  enable row level security;

-- Notes policy: any agency member can do anything.
drop policy if exists notes_agency on public.notes;
create policy notes_agency on public.notes
  for all to authenticated
  using       (public.is_agency_member(agency_id))
  with check  (public.is_agency_member(agency_id));

-- Audit log policies: separate select and insert. No update/delete.
drop policy if exists audit_log_select on public.audit_log;
create policy audit_log_select on public.audit_log
  for select to authenticated
  using (public.is_agency_member(agency_id));

drop policy if exists audit_log_insert on public.audit_log;
create policy audit_log_insert on public.audit_log
  for insert to authenticated
  with check (public.is_agency_member(agency_id));

-- Intentionally no UPDATE or DELETE policies on audit_log.


-- =============================================================================
--  End of 0007_notes_audit.sql
-- =============================================================================
