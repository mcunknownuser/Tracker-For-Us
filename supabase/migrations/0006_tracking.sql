-- =============================================================================
--  0006_tracking.sql
--  Tracking link analytics, imported from Infloww CSVs.
-- =============================================================================
--
--  What this migration sets up:
--    * tracking_users          one row per model that tracking links are
--                              grouped under (e.g. "Sofia", "Teddy")
--    * tracking_links          one row per tracking link (e.g. a Reddit promo
--                              link, a Twitter SFS swap link)
--    * tracking_link_snapshots one row per CSV import per link — preserves
--                              history so we can see growth over time
--
--  Why snapshots:
--    Infloww's UI shows a single point-in-time number. But agencies upload
--    new CSVs weekly. Storing each CSV row as a snapshot keeps history
--    so we can chart "clicks per week", "earnings curve", etc.
--
--  Note: "user" here means "model the tracking link is for" — NOT an
--    auth user. This is unfortunate naming inherited from the original
--    schema; renaming would touch a lot of UI code. Mental model:
--    tracking_user = a model in the tracking dashboard.
--
--  Bug fix from original schema: all _cents columns are bigint here
--    (in the original they were integer, which maxes out around $21M).
--
-- =============================================================================


-- =============================================================================
--  1. tracking_users
-- =============================================================================
--  The "groups" that tracking links roll up under. Usually one per model.
--
--  Example rows for an agency:
--    name
--    --------
--    Sofia
--    Teddy
--    Anastasia

create table if not exists public.tracking_users (
  id              uuid primary key default gen_random_uuid(),

  agency_id       uuid not null references public.agency(id) on delete cascade,

  -- Display name (a model name in practice).
  name            text not null check (length(trim(name)) > 0),

  created_at      timestamptz not null default now(),

  -- Unique per agency, not globally — two agencies can both have "Sofia".
  constraint tracking_users_agency_name_uniq unique (agency_id, name)
);

create index if not exists tracking_users_agency_idx
  on public.tracking_users (agency_id);


-- =============================================================================
--  2. tracking_links
-- =============================================================================
--  One row per tracking link. The "header" — metadata about the link itself,
--  static fields like name and source platform. Time-varying metrics
--  (clicks, earnings) live in tracking_link_snapshots.
--
--  Examples of links agencies create:
--    name                          | source     | tag    | list
--    ---------------------------- | ---------- | ------ | --------
--    "Reddit (Sofia Apr 9)"        | Reddit     |        |
--    "Twitter SFS - Apr 22"        | Twitter    |        | IFA
--    "@username- gg swap - roxy"   |            |        |

create table if not exists public.tracking_links (
  id              uuid primary key default gen_random_uuid(),

  agency_id       uuid not null references public.agency(id) on delete cascade,

  -- Which "user" (model) this link belongs to.
  user_id         uuid not null references public.tracking_users(id) on delete cascade,

  -- The name shown in Infloww.
  name            text not null,

  -- When the link was first created (from the Infloww CSV "Date created" col).
  date_created    date,

  -- Platform tag from Infloww (e.g. "Reddit", "Twitter", "Instagram",
  -- "OnlyFans"). Free-text because Infloww has weird ones (SFS, etc.).
  source          text,

  -- Optional tag and list grouping from Infloww.
  tag             text,
  list            text,

  created_at      timestamptz not null default now(),
  deleted_at      timestamptz,

  -- Unique within an agency by (user, name) — matches Infloww's behavior.
  -- Two different agencies can have links with the same name without conflict.
  constraint tracking_links_user_name_uniq unique (user_id, name)
);

create index if not exists tracking_links_agency_idx
  on public.tracking_links (agency_id) where deleted_at is null;
create index if not exists tracking_links_user_idx
  on public.tracking_links (user_id) where deleted_at is null;


-- =============================================================================
--  3. tracking_link_snapshots
-- =============================================================================
--  Time-series of metrics for each link. Each CSV upload creates a new
--  snapshot row per link — history is preserved, never overwritten.
--
--  Columns mirror the Infloww CSV column-for-column so the importer is a
--  near-direct mapping.

create table if not exists public.tracking_link_snapshots (
  id              uuid primary key default gen_random_uuid(),

  agency_id       uuid not null references public.agency(id) on delete cascade,

  link_id         uuid not null references public.tracking_links(id) on delete cascade,

  -- When this snapshot was recorded in our DB.
  recorded_at     timestamptz not null default now(),

  -- Volume metrics.
  clicks                  integer  not null default 0 check (clicks >= 0),
  subs                    integer  not null default 0 check (subs >= 0),
  fans_who_spent          integer  not null default 0 check (fans_who_spent >= 0),

  -- Conversion rates. Percent expressed as a number with 2 decimals
  -- (e.g. 23.45 means 23.45%). Nullable because Infloww emits blanks.
  subscription_cvr        numeric(6,2),
  spending_cvr            numeric(6,2),

  -- Money. BIGINT cents (fixed from the original schema where these were integer).
  promo_cost_cents        bigint   not null default 0 check (promo_cost_cents >= 0),
  earnings_cents          bigint   not null default 0 check (earnings_cents >= 0),
  profit_cents            bigint   not null default 0,  -- can be negative

  -- Derived ratios that Infloww calculates and ships in the CSV.
  -- We keep them as-is so the UI can display the same numbers as Infloww
  -- without recomputation. Nullable because Infloww emits blanks.
  cpc                     numeric(10,2),   -- cost per click
  epc                     numeric(10,2),   -- earnings per click
  cps                     numeric(10,2),   -- cost per subscriber
  aeps                    numeric(10,2),   -- avg earnings per spending fan
  roi                     numeric(10,2),   -- return on investment %

  -- When was the source CSV uploaded? Useful when reviewing whether a
  -- spike is real or just a delayed upload.
  source_csv_uploaded_at  timestamptz
);

create index if not exists tracking_link_snapshots_link_idx
  on public.tracking_link_snapshots (link_id, recorded_at desc);
create index if not exists tracking_link_snapshots_agency_idx
  on public.tracking_link_snapshots (agency_id, recorded_at desc);


-- =============================================================================
--  4. Row Level Security
-- =============================================================================

alter table public.tracking_users           enable row level security;
alter table public.tracking_links           enable row level security;
alter table public.tracking_link_snapshots  enable row level security;

do $$
declare
  t text;
  table_names text[] := array[
    'tracking_users',
    'tracking_links',
    'tracking_link_snapshots'
  ];
begin
  foreach t in array table_names loop
    execute format('drop policy if exists %I_agency on public.%I', t, t);
    execute format(
      'create policy %I_agency on public.%I
         for all to authenticated
         using       (public.is_agency_member(agency_id))
         with check  (public.is_agency_member(agency_id))',
      t, t
    );
  end loop;
end $$;


-- =============================================================================
--  End of 0006_tracking.sql
-- =============================================================================
