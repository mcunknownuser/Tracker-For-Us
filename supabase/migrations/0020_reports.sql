-- =============================================================================
--  0020_reports.sql
--  Generated reports — the spec cache and the run history.
-- =============================================================================
--
--  What this migration sets up:
--    * report_specs   one row per recognised upload shape. The AI plans the
--                     report structure once; every later upload with the same
--                     column layout reuses that plan.
--    * report_runs    one row per generated report — the computed numbers and
--                     the prose written about them, kept forever.
--
--  Why report_specs is keyed by signature:
--    The signature is a hash of the upload's normalised headers (see
--    UploadProfile.signature in src/lib/reports/types.ts). The client uploads
--    the same weekly export every Monday, so the same signature comes back
--    every week. Looking the spec up by signature means week two reuses week
--    one's structure: the report stays comparable week to week, and we skip a
--    planning call to the model entirely. That reuse is the whole point of the
--    unique (agency_id, signature) constraint below.
--
--  Why report_runs stores the whole ComputedReport as jsonb:
--    The client's workflow is a weekly report plus a monthly rollup. Keeping
--    each week's computed sections intact means the monthly rollup can
--    re-aggregate weeks that were already computed instead of re-parsing the
--    source spreadsheets. Store the shape faithfully — a flattened or
--    summarised blob would make the rollup impossible.
--
--  No soft deletes here:
--    Unlike expenses/tracking, these tables have no deleted_at — a discarded
--    report is discarded, and neither table is referenced by money records.
--    So the uniqueness rule from 0013 (partial index over active rows) does
--    not apply: (agency_id, signature) is a plain table constraint. It has to
--    be, in fact — PostgREST's upsert cannot target a *partial* unique index
--    and errors with 42P10 (see the note in src/lib/tracking.ts), and
--    upserting the spec by signature is exactly what store.ts does.
--
-- =============================================================================


-- =============================================================================
--  1. report_specs
-- =============================================================================
--  The plan for a report: which sections, which metrics, computed how. It is
--  AI output, validated before it lands here, and it contains no figures —
--  only descriptions of calculations.
--
--  Example rows for an agency:
--    signature        | pinned | spec
--    ---------------- | ------ | ---------------------------------------
--    a41f9c...        | false  | {"version":1,"title":"Weekly Chatter…"}
--    7bd002...        | true   | {"version":1,"title":"Monthly Rollup…"}

create table if not exists public.report_specs (
  id              uuid primary key default gen_random_uuid(),

  agency_id       uuid not null references public.agency(id) on delete cascade,

  -- Hash of the upload's normalised headers. Opaque to the database; the
  -- only thing that matters here is that identical uploads hash identically.
  signature       text not null check (length(trim(signature)) > 0),

  -- The ReportSpec, verbatim. jsonb because the spec's shape is owned by
  -- src/lib/reports/types.ts and evolves there, not through migrations.
  spec            jsonb not null,

  -- A pinned spec is reused verbatim and never re-planned, even if the
  -- planner would produce something different. This is how the agency locks
  -- a report layout they've settled on.
  pinned          boolean not null default false,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- One spec per upload shape per agency. Two agencies uploading the same
  -- export each get their own spec — they may want different reports from it.
  constraint report_specs_agency_signature_uniq unique (agency_id, signature)
);

-- No separate agency_id index: the unique constraint's index is
-- (agency_id, signature), so agency-scoped lookups already use it.

drop trigger if exists report_specs_touch_updated_at on public.report_specs;
create trigger report_specs_touch_updated_at
  before update on public.report_specs
  for each row execute function public.touch_updated_at();


-- =============================================================================
--  2. report_runs
-- =============================================================================
--  One generated report. `computed` holds every number in the report (all of
--  it produced by engine.ts from the source rows) and `prose` holds the
--  commentary the model wrote about those numbers.
--
--  spec_id is nullable and `on delete set null` on purpose: deleting a cached
--  spec must not destroy the reports that were produced from it. The run keeps
--  its own copy of the spec inside `computed` anyway, so it still renders.

create table if not exists public.report_runs (
  id              uuid primary key default gen_random_uuid(),

  agency_id       uuid not null references public.agency(id) on delete cascade,

  -- Which cached spec produced this run. Null once that spec is deleted, or
  -- if the run was generated from a one-off spec that was never cached.
  spec_id         uuid references public.report_specs(id) on delete set null,

  -- Report title as shown in the history list (from ReportSpec.title).
  title           text not null check (length(trim(title)) > 0),

  -- The period the report covers, as free text — "Week of 4 Aug", "July 2026".
  -- Free-text because it comes from the upload, which has no reliable date
  -- convention. Nullable: not every upload says what period it covers.
  period_label    text,

  -- Names of the files this report was generated from, for provenance.
  source_files    text[] not null default '{}',

  -- The full ComputedReport. Kept whole so the monthly rollup can re-aggregate
  -- it (see the header note) instead of re-reading the source files.
  computed        jsonb not null,

  -- The full ReportProse — headline, per-section commentary, recommendations.
  prose           jsonb not null,

  created_at      timestamptz not null default now(),

  -- Who generated it. Nullable — if that user is later removed, the report
  -- stays and loses attribution (same rule as notes.author_user_id).
  created_by      uuid references auth.users(id) on delete set null
);

-- The history list: an agency's reports, newest first.
create index if not exists report_runs_agency_recent_idx
  on public.report_runs (agency_id, created_at desc);


-- =============================================================================
--  3. Row Level Security
-- =============================================================================
--  Same rule as every other domain table: any member of the agency has full
--  access to that agency's rows, and nobody sees anyone else's.

alter table public.report_specs enable row level security;
alter table public.report_runs  enable row level security;

drop policy if exists report_specs_agency on public.report_specs;
create policy report_specs_agency on public.report_specs
  for all to authenticated
  using       (public.is_agency_member(agency_id))
  with check  (public.is_agency_member(agency_id));

drop policy if exists report_runs_agency on public.report_runs;
create policy report_runs_agency on public.report_runs
  for all to authenticated
  using       (public.is_agency_member(agency_id))
  with check  (public.is_agency_member(agency_id));


-- =============================================================================
--  End of 0020_reports.sql
-- =============================================================================
