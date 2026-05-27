// =============================================================================
//  Tracking.tsx
//  Tracking links — delta-driven view modelled on Infloww/Plutus, adapted
//  to the editorial dark theme.
//
//  Layout:
//    1. Page header: title + creator filter + Upload CSV
//    2. Date + period selector (Today / Yesterday / Week / Month)
//    3. Top 5 panels (period deltas vs. all-time cumulative)
//    4. Source chips + name search
//    5. Flat table with delta values
//    6. Uploads section (delete past imports)
//
//  Snapshot range: last 9 months is hard-capped (matches what the user
//  asked for in the previous step).
// =============================================================================

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { PageHeader } from '../components/PageHeader';
import { Modal } from '../components/Modal';
import { Link } from 'react-router-dom';
import { ROUTES } from '../lib/routes';
import { Button, TextLink } from '../components/FormControls';
import { Select } from '../components/Select';
import { InlineCalendar } from '../components/DatePicker';
import {
  type TrackingUser,
  type TrackingLink,
  type TrackingSnapshot,
  type ParsedRow,
  type ParsedSection,
  type ImportSummary,
  listUsers,
  listLinks,
  listAllSnapshots,
  parseInflowwCsv,
  importParsedRows,
  autoMatchModel,
  normalizeModelName,
} from '../lib/tracking';
import { listTeamMembers, type TeamMember } from '../lib/teamMembers';
import {
  type ColumnKey,
  defaultVisibleColumns,
  loadVisibleColumns,
} from '../lib/trackingColumns';
import { formatCents } from '../lib/money';
import { payStructureLabel } from '../lib/staffRoles';
import { toast } from '../lib/toast';

// =============================================================================
//  Page
// =============================================================================
type Period = 'today' | 'yesterday' | 'week' | 'month';

const NINE_MONTHS_DAYS = 30 * 9;

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function shiftIso(iso: string, deltaDays: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y!, (m! - 1), d! + deltaDays);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function isoToDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y!, (m! - 1), d!);
}

function longLabel(iso: string): string {
  return isoToDate(iso).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// Start/end of a calendar day in the user's *local* timezone, returned as
// UTC ISO timestamps. recorded_at in the DB is stored as UTC ISO, so we
// compare against the converted form.
function startOfDayIso(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y!, (m! - 1), d!, 0, 0, 0, 0).toISOString();
}

// Period bounds for each tab — anchored to the user's selected date.
//   today     → just that day
//   yesterday → the day before
//   week      → the past 7 days ending on selected
//   month     → the past 30 days ending on selected
function periodBounds(period: Period, selectedDate: string): { start: string; end: string } {
  switch (period) {
    case 'today':
      return { start: startOfDayIso(selectedDate), end: endOfDayIso(selectedDate) };
    case 'yesterday': {
      const y = shiftIso(selectedDate, -1);
      return { start: startOfDayIso(y), end: endOfDayIso(y) };
    }
    case 'week':
      return {
        start: startOfDayIso(shiftIso(selectedDate, -6)),
        end: endOfDayIso(selectedDate),
      };
    case 'month':
      return {
        start: startOfDayIso(shiftIso(selectedDate, -29)),
        end: endOfDayIso(selectedDate),
      };
  }
}

export function Tracking() {
  const [users, setUsers] = useState<TrackingUser[]>([]);
  const [links, setLinks] = useState<TrackingLink[]>([]);
  const [snapshots, setSnapshots] = useState<TrackingSnapshot[]>([]);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const [selectedDate, setSelectedDate] = useState<string>(todayIso());
  const [period, setPeriod] = useState<Period>('today');
  const [creatorFilter, setCreatorFilter] = useState<string>('all');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [search, setSearch] = useState('');

  const [importing, setImporting] = useState(false);
  const [detailLinkId, setDetailLinkId] = useState<string | null>(null);

  // Column visibility — managed in Settings, stored in user_preferences
  // (synced across devices). We seed with the default (all visible) and
  // refresh from the DB on mount and whenever Settings broadcasts a
  // change.
  const [visibleColumns, setVisibleColumns] = useState<Set<ColumnKey>>(() =>
    defaultVisibleColumns(),
  );
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const cols = await loadVisibleColumns();
      if (!cancelled) setVisibleColumns(cols);
    };
    void refresh();
    const handler = () => void refresh();
    window.addEventListener('voltrisai:prefs-changed', handler);
    return () => {
      cancelled = true;
      window.removeEventListener('voltrisai:prefs-changed', handler);
    };
  }, []);

  async function reload() {
    try {
      const rangeStart = new Date();
      rangeStart.setDate(rangeStart.getDate() - NINE_MONTHS_DAYS);
      const [u, l, s, tm] = await Promise.all([
        listUsers(),
        listLinks(),
        listAllSnapshots({ rangeStart: rangeStart.toISOString() }),
        listTeamMembers(),
      ]);
      setUsers(u);
      setLinks(l);
      setSnapshots(s);
      setTeamMembers(tm);
      setLoaded(true);
    } catch (e) {
      setError(e as Error);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  // ---------------------------------------------------------------------------
  //  Build delta rows.
  //
  //  For each link:
  //    * current  = latest snapshot inside the selected period
  //    * baseline = latest snapshot BEFORE the period started
  //    * delta    = current − (baseline ?? 0)
  //
  //  This means same-day uploads aggregate naturally — e.g. a 2am upload
  //  (+5) and an 8pm upload (+7 more) both compare to "before today",
  //  giving a Today delta of +12.
  //
  //  hasComparison flags whether the link has at least 2 snapshots anywhere
  //  in its history. Top 5 filters by this so a brand-new link's first
  //  upload doesn't appear with its full cumulative value as a fake delta.
  // ---------------------------------------------------------------------------
  const rows = useMemo<DeltaRow[]>(() => {
    if (!loaded) return [];

    const { start: periodStart, end: periodEnd } = periodBounds(period, selectedDate);

    // Snapshots are pre-sorted recorded_at desc. Bucket by link_id.
    const byLink = new Map<string, TrackingSnapshot[]>();
    for (const s of snapshots) {
      const arr = byLink.get(s.link_id) ?? [];
      arr.push(s);
      byLink.set(s.link_id, arr);
    }

    const out: DeltaRow[] = [];
    for (const link of links) {
      const arr = byLink.get(link.id) ?? [];
      if (arr.length === 0) continue;

      // Snapshots inside the period (arr is sorted recorded_at desc).
      const inPeriod = arr.filter(
        (s) => s.recorded_at >= periodStart && s.recorded_at <= periodEnd,
      );
      if (inPeriod.length === 0) continue;

      // Current = latest snapshot inside the period.
      const current = inPeriod[0]!;

      // Baseline preference order:
      //   1. Latest snapshot from BEFORE the period (true "yesterday" value)
      //   2. Earliest snapshot inside the period (within-period growth)
      //   3. Zero — first ever upload. Compare against zero so the table
      //      shows the full cumulative values rather than "0" deltas.
      //
      // hasComparison flags whether there's a real comparison point. Top 5
      // still hides "first upload" rows so we don't surface them as fake
      // gains.
      const prePeriod = arr.find((s) => s.recorded_at < periodStart);
      let baseline: TrackingSnapshot;
      let hasComparison: boolean;
      if (prePeriod) {
        baseline = prePeriod;
        hasComparison = true;
      } else if (inPeriod.length >= 2) {
        baseline = inPeriod[inPeriod.length - 1]!;
        hasComparison = true;
      } else {
        // First-ever upload: synthesize a zero baseline so deltas equal
        // the current cumulative values.
        baseline = {
          ...current,
          clicks: 0,
          subs: 0,
          fans_who_spent: 0,
          promo_cost_cents: 0,
          earnings_cents: 0,
          profit_cents: 0,
        };
        hasComparison = false;
      }

      out.push(buildDeltaRow(link, current, baseline, hasComparison));
    }
    return out;
  }, [loaded, links, snapshots, selectedDate, period]);

  // Map each *model* team_member to the set of tracking_user ids whose
  // names normalize to the same string. Multiple tracking_users can map to
  // one team_member (e.g. CSV imports created "Teddy" and "Teddy 🏳️‍⚧️"
  // separately). We want the dropdown to show "Teddy" once, and selecting
  // it should filter to links from BOTH underlying tracking_users.
  const memberToUserIds = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const m of teamMembers) {
      if (m.pay_structure !== 'share') continue;
      const mNorm = normalizeModelName(m.name);
      const ids = new Set<string>();
      for (const u of users) {
        if (normalizeModelName(u.name) === mNorm) ids.add(u.id);
      }
      if (ids.size > 0) map.set(m.id, ids);
    }
    return map;
  }, [teamMembers, users]);

  // Models that have at least one matching tracking_user. Drives the
  // dropdown and the "valid creators" filter on the table.
  const validModels = useMemo(
    () => teamMembers.filter((m) => memberToUserIds.has(m.id)),
    [teamMembers, memberToUserIds],
  );

  // Flat set of every tracking_user id that maps to *any* valid model.
  const validUserIds = useMemo(() => {
    const ids = new Set<string>();
    for (const set of memberToUserIds.values()) {
      for (const id of set) ids.add(id);
    }
    return ids;
  }, [memberToUserIds]);

  // Source chips dynamically from the rows.
  const sources = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) if (r.source) set.add(r.source);
    return Array.from(set).sort();
  }, [rows]);

  // Apply filters, then sort by subs delta DESC so the biggest gainers
  // sit at the top of the table.
  const filteredRows = useMemo(() => {
    // Always drop links belonging to creators that aren't valid models.
    let r = rows.filter((x) => validUserIds.has(x.user_id));
    if (creatorFilter !== 'all') {
      // creatorFilter is a team_member id; resolve it to its set of
      // underlying tracking_user ids.
      const ids = memberToUserIds.get(creatorFilter);
      if (ids) r = r.filter((x) => ids.has(x.user_id));
      else r = [];
    }
    if (sourceFilter !== 'all') r = r.filter((x) => (x.source ?? '') === sourceFilter);
    if (search.trim())
      r = r.filter((x) => x.name.toLowerCase().includes(search.trim().toLowerCase()));
    return [...r].sort((a, b) => b.subsDelta - a.subsDelta);
  }, [rows, validUserIds, memberToUserIds, creatorFilter, sourceFilter, search]);

  // All-time rows: latest snapshot per link regardless of selected period.
  // Why: the "Top 5 · all-time subs" panel is cumulative — it must not
  // change when the user flips between Today / Yesterday / Week / Month.
  const allTimeRows = useMemo(() => {
    if (!loaded) return [] as { link_id: string; name: string; user_id: string; source: string | null; subs: number }[];
    const latestByLink = new Map<string, TrackingSnapshot>();
    for (const s of snapshots) {
      if (!latestByLink.has(s.link_id)) latestByLink.set(s.link_id, s);
    }
    const out: { link_id: string; name: string; user_id: string; source: string | null; subs: number }[] = [];
    for (const link of links) {
      const latest = latestByLink.get(link.id);
      if (!latest) continue;
      out.push({
        link_id: link.id,
        name: link.name,
        user_id: link.user_id,
        source: link.source,
        subs: latest.subs,
      });
    }
    return out;
  }, [loaded, links, snapshots]);

  const filteredAllTime = useMemo(() => {
    let r = allTimeRows.filter((x) => validUserIds.has(x.user_id));
    if (creatorFilter !== 'all') {
      const ids = memberToUserIds.get(creatorFilter);
      if (ids) r = r.filter((x) => ids.has(x.user_id));
      else r = [];
    }
    if (sourceFilter !== 'all') r = r.filter((x) => (x.source ?? '') === sourceFilter);
    if (search.trim())
      r = r.filter((x) => x.name.toLowerCase().includes(search.trim().toLowerCase()));
    return r;
  }, [allTimeRows, validUserIds, memberToUserIds, creatorFilter, sourceFilter, search]);

  // Top 5 panels.
  // Period panel: only include links that have a real comparison snapshot
  // (i.e. not the user's first-ever upload for that link) and a non-zero
  // delta. Otherwise we'd be showing the full cumulative value as a fake
  // gain.
  const top5Period = useMemo(
    () =>
      [...filteredRows]
        .filter((r) => r.hasComparison && r.subsDelta !== 0)
        .sort((a, b) => b.subsDelta - a.subsDelta)
        .slice(0, 5),
    [filteredRows],
  );
  const top5AllTime = useMemo(
    () => [...filteredAllTime].sort((a, b) => b.subs - a.subs).slice(0, 5),
    [filteredAllTime],
  );

  const periodLabel: Record<Period, string> = {
    today: 'today',
    yesterday: 'yesterday',
    week: 'this week',
    month: 'this month',
  };

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        eyebrow="Tracking links"
        title="Tracking."
        subtitle="Daily deltas computed against the previous CSV upload. Last 9 months only."
        actions={
          <>
            <div className="w-56">
              <Select
                id="creator"
                value={creatorFilter}
                onChange={setCreatorFilter}
                options={[
                  { value: 'all', label: 'All creators', detail: `${validModels.length} total` },
                  ...validModels.map((m) => ({ value: m.id, label: m.name, detail: '' })),
                ]}
              />
            </div>
            <button
              onClick={() => setImporting(true)}
              disabled={!loaded}
              className="bg-neutral-50 px-4 py-3 text-[11px] font-medium uppercase tracking-widest text-neutral-950 transition-colors hover:bg-neutral-300 disabled:opacity-40"
            >
              Upload CSV
            </button>
            <Link
              to={ROUTES.settingsTracking}
              title="Tracking columns + CSV upload history"
              aria-label="Tracking settings"
              className="flex items-center justify-center border border-neutral-800 px-4 text-neutral-400 transition-colors hover:border-neutral-500 hover:text-neutral-100"
            >
              <TrackingGearIcon />
            </Link>
          </>
        }
      />

      {error && (
        <div className="mb-6 border border-red-900/60 bg-red-950/30 p-4 text-sm text-red-200">
          {error.message}
        </div>
      )}

      {!loaded ? (
        <Loading />
      ) : snapshots.length === 0 ? (
        <EmptyState onImport={() => setImporting(true)} />
      ) : (
        <>
          <DateAndPeriod
            selectedDate={selectedDate}
            onChangeDate={setSelectedDate}
            period={period}
            onChangePeriod={setPeriod}
          />

          <TopFive
            label={`Top 5 · ${period} subs`}
            sublabel={`new subs gained ${periodLabel[period]}`}
            items={top5Period.map((r) => ({
              link_id: r.link_id,
              name: r.name,
              value: signedInt(r.subsDelta),
              tone: r.subsDelta > 0 ? 'positive' : r.subsDelta < 0 ? 'negative' : 'neutral',
            }))}
            empty={`No subs ${periodLabel[period]}.`}
            onItemClick={setDetailLinkId}
            twin={{
              label: 'Top 5 · all-time subs',
              sublabel: 'cumulative (most recent snapshot)',
              items: top5AllTime.map((r) => ({
                link_id: r.link_id,
                name: r.name,
                value: r.subs.toLocaleString(),
                tone: 'neutral',
              })),
              empty: 'No subs recorded.',
            }}
          />

          <SourceChipsAndSearch
            sources={sources}
            selected={sourceFilter}
            onSelect={setSourceFilter}
            search={search}
            onSearch={setSearch}
          />

          <DeltaTable
            rows={filteredRows}
            onRowClick={setDetailLinkId}
            visibleColumns={visibleColumns}
          />
        </>
      )}

      {importing && (
        <ImportModal
          onClose={() => setImporting(false)}
          onDone={() => {
            setImporting(false);
            void reload();
          }}
        />
      )}

      {detailLinkId && (() => {
        const link = links.find((l) => l.id === detailLinkId);
        if (!link) return null;
        const linkSnapshots = snapshots.filter((s) => s.link_id === link.id);
        const creator = users.find((u) => u.id === link.user_id);
        return (
          <LinkDetailModal
            link={link}
            creatorName={creator?.name ?? '—'}
            snapshots={linkSnapshots}
            onClose={() => setDetailLinkId(null)}
          />
        );
      })()}
    </div>
  );
}

// =============================================================================
//  Delta row construction
// =============================================================================
type DeltaRow = {
  link_id: string;
  user_id: string;
  name: string;
  tag: string | null;
  list: string | null;
  source: string | null;
  date_created: string | null;
  // Deltas:
  clicksDelta: number;
  subsDelta: number;
  promoCostDelta: number;
  earningsDelta: number;
  fansSpentDelta: number;
  profitDelta: number;
  // Cumulative (from current snapshot):
  clicks: number;
  subs: number;
  fansSpent: number;
  promoCostCents: number;
  earningsCents: number;
  profitCents: number;
  // Static ratios (from current snapshot):
  cvr: number | null;
  spendingCvr: number | null;
  cpc: number | null;
  epc: number | null;
  cps: number | null;
  aeps: number | null;
  roi: number | null;
  // Does this link have at least one previous snapshot to compare against?
  // If false, the link's first-ever upload is being shown — Top 5 excludes
  // these to avoid showing the full cumulative value as a fake delta.
  hasComparison: boolean;
};

// Infer a source from the link name when the CSV's Source column is blank.
// Rules are intentionally permissive — if a link name mentions "swap" it's
// a shoutout (SFS), "reddit" is Reddit, "ig" or "instagram" is Instagram,
// etc. Order matters: more specific rules first.
//
// "Dating apps" is a single bucket that covers every common dating app —
// no need to filter Tinder vs Bumble vs Hinge separately.
const DATING_APP_KEYWORDS = [
  'bumble',
  'tinder',
  'hinge',
  'grindr',
  'match.com',
  'okcupid',
  'badoo',
  'feeld',
  'raya',
  'pof',           // Plenty of Fish
  'plentyoffish',
  'coffeemeetsbagel',
  'happn',
];

function deriveSource(link: TrackingLink): string | null {
  // Honor the explicit CSV value — but normalize dating-app names to the
  // shared "Dating apps" bucket so Infloww's own labels merge with our
  // inference.
  if (link.source && link.source.trim()) {
    const s = link.source.trim();
    if (DATING_APP_KEYWORDS.some((k) => s.toLowerCase().includes(k))) return 'Dating apps';
    return s;
  }
  const n = link.name.toLowerCase();
  if (DATING_APP_KEYWORDS.some((k) => n.includes(k)))                 return 'Dating apps';
  if (n.includes('swap'))                                             return 'SFS';
  if (n.includes('sfs'))                                              return 'SFS';
  if (n.includes('reddit'))                                           return 'Reddit';
  if (n.includes('onlyfans') || n.includes('onlyfinder'))             return 'OnlyFans';
  if (n.includes('instagram') || /\big\b/.test(n) || /\binsta\b/.test(n)) return 'Instagram';
  if (n.includes('twitter')   || /\bx\b/.test(n))                     return 'Twitter';
  if (n.includes('tiktok')    || n.includes('tik tok'))               return 'TikTok';
  if (n.includes('telegram'))                                         return 'Telegram';
  if (n.includes('fetlife'))                                          return 'FetLife';
  if (n.includes('thread'))                                           return 'Threads';
  return null;
}

function buildDeltaRow(
  link: TrackingLink,
  current: TrackingSnapshot,
  baseline: TrackingSnapshot,
  hasComparison: boolean,
): DeltaRow {
  return {
    link_id: link.id,
    user_id: link.user_id,
    name: link.name,
    tag: link.tag,
    list: link.list,
    source: deriveSource(link),
    date_created: link.date_created,
    clicksDelta: current.clicks - baseline.clicks,
    subsDelta: current.subs - baseline.subs,
    promoCostDelta: current.promo_cost_cents - baseline.promo_cost_cents,
    earningsDelta: current.earnings_cents - baseline.earnings_cents,
    fansSpentDelta: current.fans_who_spent - baseline.fans_who_spent,
    profitDelta: current.profit_cents - baseline.profit_cents,
    clicks: current.clicks,
    subs: current.subs,
    fansSpent: current.fans_who_spent,
    promoCostCents: current.promo_cost_cents,
    earningsCents: current.earnings_cents,
    profitCents: current.profit_cents,
    cvr: current.subscription_cvr,
    spendingCvr: current.spending_cvr,
    cpc: current.cpc,
    epc: current.epc,
    cps: current.cps,
    aeps: current.aeps,
    roi: current.roi,
    hasComparison,
  };
}

function endOfDayIso(date: string): string {
  // "2026-05-12" → "2026-05-12T23:59:59.999Z" (local end of day, returned in UTC).
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y!, (m! - 1), d!, 23, 59, 59, 999).toISOString();
}

// =============================================================================
//  Date + period selector
// =============================================================================
function DateAndPeriod({
  selectedDate,
  onChangeDate,
  period,
  onChangePeriod,
}: {
  selectedDate: string;
  onChangeDate: (d: string) => void;
  period: Period;
  onChangePeriod: (p: Period) => void;
}) {
  const isToday = selectedDate === todayIso();
  const dateLabel = isToday ? `Today · ${longLabel(selectedDate)}` : longLabel(selectedDate);
  return (
    <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      {/* Period tabs */}
      <div className="flex items-center gap-1 border border-neutral-800">
        {(['today', 'yesterday', 'week', 'month'] as Period[]).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onChangePeriod(p)}
            className={
              'px-4 py-2 text-[11px] uppercase tracking-widest transition-colors ' +
              (period === p
                ? 'bg-neutral-50 text-neutral-950'
                : 'text-neutral-400 hover:text-neutral-100')
            }
          >
            {p}
          </button>
        ))}
      </div>

      {/* Date stepper */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onChangeDate(shiftIso(selectedDate, -1))}
          className="border border-neutral-800 px-2 py-1.5 text-neutral-400 transition-colors hover:border-neutral-500 hover:text-neutral-100"
          aria-label="Previous day"
        >
          ←
        </button>
        <DateButton value={selectedDate} onChange={onChangeDate} label={dateLabel} />
        <button
          type="button"
          onClick={() => onChangeDate(shiftIso(selectedDate, 1))}
          className="border border-neutral-800 px-2 py-1.5 text-neutral-400 transition-colors hover:border-neutral-500 hover:text-neutral-100"
          aria-label="Next day"
        >
          →
        </button>
      </div>
    </div>
  );
}

// Inline date trigger — click the label to open the picker.
function DateButton({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onClickAway(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickAway);
    return () => document.removeEventListener('mousedown', onClickAway);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((x) => !x)}
        className="border border-neutral-800 px-4 py-1.5 text-[12px] uppercase tracking-widest text-neutral-200 transition-colors hover:border-neutral-500"
      >
        {label}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-72 border border-neutral-800 bg-neutral-950 p-4 shadow-2xl">
          <InlineCalendar
            value={value}
            onChange={(v) => {
              onChange(v);
              setOpen(false);
            }}
          />
        </div>
      )}
    </div>
  );
}

// =============================================================================
//  Top 5 panels (period vs all-time)
// =============================================================================
type Top5Item = {
  link_id: string;
  name: string;
  value: string;
  tone: 'positive' | 'negative' | 'neutral';
};

function TopFive({
  label,
  sublabel,
  items,
  empty,
  twin,
  onItemClick,
}: {
  label: string;
  sublabel: string;
  items: Top5Item[];
  empty: string;
  twin: { label: string; sublabel: string; items: Top5Item[]; empty: string };
  onItemClick: (linkId: string) => void;
}) {
  return (
    <div className="mb-10 grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Top5Card
        label={label}
        sublabel={sublabel}
        items={items}
        empty={empty}
        onItemClick={onItemClick}
      />
      <Top5Card
        label={twin.label}
        sublabel={twin.sublabel}
        items={twin.items}
        empty={twin.empty}
        onItemClick={onItemClick}
      />
    </div>
  );
}

function Top5Card({
  label,
  sublabel,
  items,
  empty,
  onItemClick,
}: {
  label: string;
  sublabel: string;
  items: Top5Item[];
  empty: string;
  onItemClick: (linkId: string) => void;
}) {
  return (
    <div className="border border-neutral-800 bg-neutral-950 p-5">
      <div className="mb-1 text-[10px] font-medium uppercase tracking-editorial text-neutral-500">
        {label}
      </div>
      <div className="mb-4 text-[10px] uppercase tracking-widest text-neutral-600">
        {sublabel}
      </div>
      {items.length === 0 ? (
        <div className="flex h-32 items-center justify-center text-[10px] uppercase tracking-widest text-neutral-600">
          {empty}
        </div>
      ) : (
        <ol className="divide-y divide-neutral-900">
          {items.map((it, i) => (
            <li key={i}>
              <button
                type="button"
                onClick={() => onItemClick(it.link_id)}
                className="flex w-full items-baseline justify-between gap-3 py-2.5 text-left transition-colors hover:bg-neutral-900"
                title="View link details"
              >
              <div className="flex items-baseline gap-3 min-w-0">
                <span className="font-serif text-sm text-neutral-500 tabular-nums">
                  {i + 1}
                </span>
                <span className="truncate text-sm text-neutral-100">{it.name}</span>
              </div>
              <span
                className={
                  'text-sm font-medium tabular-nums ' +
                  (it.tone === 'positive'
                    ? 'text-emerald-400'
                    : it.tone === 'negative'
                      ? 'text-rose-400'
                      : 'text-neutral-200')
                }
              >
                {it.value}
              </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// =============================================================================
//  Source chips + search
// =============================================================================
function SourceChipsAndSearch({
  sources,
  selected,
  onSelect,
  search,
  onSearch,
}: {
  sources: string[];
  selected: string;
  onSelect: (s: string) => void;
  search: string;
  onSearch: (s: string) => void;
}) {
  return (
    <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex flex-wrap items-center gap-2">
        <Chip
          label="All"
          active={selected === 'all'}
          onClick={() => onSelect('all')}
        />
        {sources.map((s) => (
          <Chip
            key={s}
            label={s}
            active={selected === s}
            onClick={() => onSelect(s)}
          />
        ))}
      </div>
      <div className="lg:w-72">
        <input
          type="text"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search tracking link name…"
          className="block w-full border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
        />
      </div>
    </div>
  );
}

function Chip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'border px-3 py-1.5 text-[11px] uppercase tracking-widest transition-colors ' +
        (active
          ? 'border-neutral-50 bg-neutral-50 text-neutral-950'
          : 'border-neutral-800 text-neutral-400 hover:border-neutral-500 hover:text-neutral-100')
      }
    >
      {label}
    </button>
  );
}

// =============================================================================
//  Delta table — horizontal scroll for the full column set
// =============================================================================
function DeltaTable({
  rows,
  onRowClick,
  visibleColumns,
}: {
  rows: DeltaRow[];
  onRowClick: (linkId: string) => void;
  visibleColumns: Set<ColumnKey>;
}) {
  if (rows.length === 0) {
    return (
      <div className="mb-12 flex h-24 items-center justify-center border border-dashed border-neutral-800 text-[10px] uppercase tracking-widest text-neutral-600">
        No tracking links match the current filters.
      </div>
    );
  }
  const show = (k: ColumnKey) => visibleColumns.has(k);
  return (
    <div className="mb-12 -mx-2 overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="text-[10px] uppercase tracking-widest text-neutral-600">
            <Th align="left">Tracking link</Th>
            {show('date')      && <Th align="left">Date</Th>}
            {show('clicks')    && <Th>Clicks</Th>}
            {show('subs')      && <Th>Subs</Th>}
            {show('cvr')       && <Th>CVR</Th>}
            {show('promoCost') && <Th>Promo cost</Th>}
            {show('earnings')  && <Th>Earnings</Th>}
            {show('spendCvr')  && <Th>Spend CVR</Th>}
            {show('fansSpent') && <Th>Fans spent</Th>}
            {show('profit')    && <Th>Profit</Th>}
            {show('cpc')       && <Th>CPC</Th>}
            {show('epc')       && <Th>EPC</Th>}
            {show('cps')       && <Th>CPS</Th>}
            {show('aeps')      && <Th>AEPS</Th>}
            {show('roi')       && <Th>ROI</Th>}
            {show('source')    && <Th align="left">Source</Th>}
            {show('tag')       && <Th align="left">Tag</Th>}
            {show('list')      && <Th align="left">List</Th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-900">
          {rows.map((r) => (
            <tr
              key={r.link_id}
              onClick={() => onRowClick(r.link_id)}
              className="cursor-pointer transition-colors hover:bg-neutral-900"
              title="Click for cumulative totals"
            >
              <Td align="left">
                <div className="text-neutral-100">{r.name}</div>
              </Td>
              {show('date') && (
                <Td align="left">
                  <span className="text-[11px] uppercase tracking-widest text-neutral-500">
                    {r.date_created ? shortDate(r.date_created) : '—'}
                  </span>
                </Td>
              )}
              {show('clicks')    && <DeltaCell cumulative={r.clicks} delta={r.clicksDelta} format="int"   hasComparison={r.hasComparison} />}
              {show('subs')      && <DeltaCell cumulative={r.subs}   delta={r.subsDelta}   format="int"   hasComparison={r.hasComparison} />}
              {show('cvr') && (
                <Td>
                  <span className="tabular-nums text-neutral-300">
                    {r.cvr != null ? `${r.cvr.toFixed(2)}%` : '—'}
                  </span>
                </Td>
              )}
              {show('promoCost') && <DeltaCell cumulative={r.promoCostCents} delta={r.promoCostDelta} format="money" hasComparison={r.hasComparison} />}
              {show('earnings')  && <DeltaCell cumulative={r.earningsCents}  delta={r.earningsDelta}  format="money" hasComparison={r.hasComparison} />}
              {show('spendCvr') && (
                <Td>
                  <span className="tabular-nums text-neutral-300">
                    {r.spendingCvr != null ? `${r.spendingCvr.toFixed(2)}%` : '—'}
                  </span>
                </Td>
              )}
              {show('fansSpent') && <DeltaCell cumulative={r.fansSpent}    delta={r.fansSpentDelta} format="int"   hasComparison={r.hasComparison} />}
              {show('profit')    && <DeltaCell cumulative={r.profitCents}  delta={r.profitDelta}    format="money" hasComparison={r.hasComparison} />}
              {show('cpc') && (
                <Td>
                  <span className="tabular-nums text-neutral-300">
                    {r.cpc != null ? r.cpc.toFixed(2) : '—'}
                  </span>
                </Td>
              )}
              {show('epc') && (
                <Td>
                  <span className="tabular-nums text-neutral-300">
                    {r.epc != null ? r.epc.toFixed(2) : '—'}
                  </span>
                </Td>
              )}
              {show('cps') && (
                <Td>
                  <span className="tabular-nums text-neutral-300">
                    {r.cps != null ? r.cps.toFixed(2) : '—'}
                  </span>
                </Td>
              )}
              {show('aeps') && (
                <Td>
                  <span className="tabular-nums text-neutral-300">
                    {r.aeps != null ? r.aeps.toFixed(2) : '—'}
                  </span>
                </Td>
              )}
              {show('roi') && (
                <Td>
                  <span className="tabular-nums text-neutral-300">
                    {r.roi != null ? `${r.roi.toFixed(2)}%` : '—'}
                  </span>
                </Td>
              )}
              {show('source') && (
                <Td align="left">
                  <span className="text-[11px] uppercase tracking-widest text-neutral-500">
                    {r.source ?? '—'}
                  </span>
                </Td>
              )}
              {show('tag') && (
                <Td align="left">
                  <span className="text-[11px] text-neutral-500">{r.tag ?? '—'}</span>
                </Td>
              )}
              {show('list') && (
                <Td align="left">
                  <span className="text-[11px] text-neutral-500">{r.list ?? '—'}</span>
                </Td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children, align = 'right' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
      className={
        'whitespace-nowrap px-3 py-2 font-medium ' +
        (align === 'left' ? 'text-left' : 'text-right')
      }
    >
      {children}
    </th>
  );
}

function Td({ children, align = 'right' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <td
      className={
        'whitespace-nowrap px-3 py-3 ' +
        (align === 'left' ? 'text-left' : 'text-right')
      }
    >
      {children}
    </td>
  );
}

// Renders the cumulative value + a tiny inline delta when there's a real
// change. Same-value re-uploads and first-ever uploads both fall back to
// just the cumulative number, so the table never strips information away.
function DeltaCell({
  cumulative,
  delta,
  format,
  hasComparison,
}: {
  cumulative: number;
  delta: number;
  format: 'int' | 'money';
  hasComparison: boolean;
}) {
  const cumDisplay = format === 'money' ? formatCents(cumulative) : cumulative.toLocaleString();
  const showDelta = hasComparison && delta !== 0;
  const deltaSign = delta > 0 ? '+' : '−';
  const deltaTone = delta > 0 ? 'text-emerald-400' : 'text-rose-400';
  const deltaBody = format === 'money'
    ? formatCents(Math.abs(delta))
    : Math.abs(delta).toLocaleString();
  return (
    <Td>
      <span className="tabular-nums text-neutral-200">{cumDisplay}</span>
      {showDelta && (
        <span className={'ml-1.5 text-[10px] tabular-nums ' + deltaTone}>
          {deltaSign}{deltaBody}
        </span>
      )}
    </Td>
  );
}

function signedInt(n: number): string {
  if (n === 0) return '0';
  return `${n > 0 ? '+' : '−'}${Math.abs(n).toLocaleString()}`;
}

function shortDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y!, (m! - 1), d!).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// =============================================================================
//  Empty / loading
// =============================================================================
function Loading() {
  return (
    <div className="flex h-64 items-center justify-center border border-dashed border-neutral-800 text-xs uppercase tracking-widest text-neutral-700">
      Loading…
    </div>
  );
}

function EmptyState({ onImport }: { onImport: () => void }) {
  return (
    <div className="flex h-80 flex-col items-center justify-center gap-4 border border-dashed border-neutral-800 px-6 text-center">
      <div className="font-serif text-2xl text-neutral-200">No tracking data yet.</div>
      <div className="max-w-md text-xs uppercase tracking-widest text-neutral-600">
        Export a CSV from Infloww and import it here. Each upload adds a new
        snapshot — historical metrics are preserved.
      </div>
      <button
        onClick={onImport}
        className="mt-2 bg-neutral-50 px-5 py-3 text-[11px] font-medium uppercase tracking-widest text-neutral-950 transition-colors hover:bg-neutral-300"
      >
        Import your first CSV
      </button>
    </div>
  );
}

// =============================================================================
//  SubsChart — clean line chart of subs over time for one link.
// =============================================================================
function SubsChart({ snapshots }: { snapshots: TrackingSnapshot[] }) {
  // recharts expects ascending x. Snapshots come desc, so reverse.
  const data = useMemo(
    () =>
      [...snapshots].reverse().map((s) => ({
        ts: new Date(s.recorded_at).getTime(),
        subs: s.subs,
      })),
    [snapshots],
  );
  const minTs = data[0]?.ts ?? 0;
  const maxTs = data[data.length - 1]?.ts ?? 0;
  return (
    <section className="mb-6">
      <div className="mb-3 flex items-baseline justify-between border-b border-neutral-900 pb-2">
        <h3 className="font-serif text-base font-medium tracking-tight text-neutral-100">
          Subs over time
        </h3>
        <span className="text-[10px] uppercase tracking-widest text-neutral-600">
          {data.length} points
        </span>
      </div>
      <div className="h-48 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#262626" />
            <XAxis
              dataKey="ts"
              type="number"
              domain={[minTs, maxTs]}
              tickFormatter={(t) =>
                new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric' })
              }
              tick={{ fill: '#737373', fontSize: 11 }}
              stroke="#404040"
              minTickGap={32}
            />
            <YAxis
              tick={{ fill: '#737373', fontSize: 11 }}
              stroke="#404040"
              width={48}
              tickFormatter={(v) => v.toLocaleString()}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: '#0a0a0a',
                border: '1px solid #262626',
                color: '#fafafa',
                fontSize: 12,
              }}
              labelFormatter={(t) =>
                new Date(t as number).toLocaleString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })
              }
              formatter={(v: number) => [v.toLocaleString(), 'Subs']}
            />
            <Line
              type="monotone"
              dataKey="subs"
              stroke="#fafafa"
              strokeWidth={2}
              dot={{ fill: '#fafafa', r: 3 }}
              activeDot={{ r: 5 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

// =============================================================================
//  LinkDetailModal — cumulative totals + per-upload history
// =============================================================================
function LinkDetailModal({
  link,
  creatorName,
  snapshots,
  onClose,
}: {
  link: TrackingLink;
  creatorName: string;
  snapshots: TrackingSnapshot[]; // already filtered to this link, desc by recorded_at
  onClose: () => void;
}) {
  const latest = snapshots[0];
  if (!latest) {
    return (
      <Modal open onClose={onClose} eyebrow={creatorName} title={link.name} maxWidth="max-w-xl">
        <div className="border border-dashed border-neutral-800 p-6 text-center text-[10px] uppercase tracking-widest text-neutral-600">
          No snapshots recorded for this link.
        </div>
      </Modal>
    );
  }
  return (
    <Modal
      open
      onClose={onClose}
      eyebrow={`${creatorName}${link.source ? ' · ' + link.source : ''}`}
      title={link.name}
      maxWidth="max-w-xl"
    >
      {/* Cumulative totals */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <CumulativeStat label="Clicks" value={latest.clicks.toLocaleString()} />
        <CumulativeStat label="Subs" value={latest.subs.toLocaleString()} />
        <CumulativeStat label="Earnings" value={formatCents(latest.earnings_cents)} />
        <CumulativeStat label="Profit" value={formatCents(latest.profit_cents)} />
      </div>

      <div className="mb-6 grid grid-cols-2 gap-x-6 gap-y-2 border border-neutral-900 bg-neutral-950 p-4 text-xs">
        <DetailRow label="CVR" value={latest.subscription_cvr != null ? `${latest.subscription_cvr.toFixed(2)}%` : '—'} />
        <DetailRow label="Spend CVR" value={latest.spending_cvr != null ? `${latest.spending_cvr.toFixed(2)}%` : '—'} />
        <DetailRow label="Fans spent" value={latest.fans_who_spent.toLocaleString()} />
        <DetailRow label="ROI" value={latest.roi != null ? `${latest.roi.toFixed(2)}%` : '—'} />
        <DetailRow label="CPC" value={latest.cpc != null ? latest.cpc.toFixed(2) : '—'} />
        <DetailRow label="EPC" value={latest.epc != null ? latest.epc.toFixed(2) : '—'} />
        <DetailRow label="CPS" value={latest.cps != null ? latest.cps.toFixed(2) : '—'} />
        <DetailRow label="AEPS" value={latest.aeps != null ? latest.aeps.toFixed(2) : '—'} />
        <DetailRow label="Promo cost" value={formatCents(latest.promo_cost_cents)} />
        <DetailRow label="Tag" value={link.tag ?? '—'} />
        <DetailRow label="List" value={link.list ?? '—'} />
        <DetailRow label="Date created" value={link.date_created ? shortDate(link.date_created) : '—'} />
        <DetailRow label="Snapshots" value={snapshots.length.toString()} />
      </div>

      {/* Subs over time — line chart */}
      {snapshots.length > 1 && (
        <SubsChart snapshots={snapshots} />
      )}

      {/* Per-upload history (scrolls internally so the modal doesn't grow
          unbounded when there are lots of snapshots). */}
      {snapshots.length > 1 && (
        <section>
          <div className="mb-3 flex items-baseline justify-between border-b border-neutral-900 pb-2">
            <h3 className="font-serif text-base font-medium tracking-tight text-neutral-100">
              History
            </h3>
            <span className="text-[10px] uppercase tracking-widest text-neutral-600">
              {snapshots.length} snapshots
            </span>
          </div>
          {/* ~5 rows visible; scrolls for the rest. */}
          <div className="max-h-56 overflow-y-auto divide-y divide-neutral-900">
            {snapshots.map((s, i) => {
              const prev = snapshots[i + 1];
              const subsDelta = prev ? s.subs - prev.subs : s.subs;
              const earningsDelta = prev ? s.earnings_cents - prev.earnings_cents : s.earnings_cents;
              const when = new Date(s.recorded_at).toLocaleString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              });
              return (
                <div key={s.id} className="grid grid-cols-[1fr_auto_auto] items-baseline gap-4 py-2.5 text-sm">
                  <div className="text-[11px] uppercase tracking-widest text-neutral-500">
                    {when}
                  </div>
                  <div className="tabular-nums text-neutral-200">
                    {s.subs.toLocaleString()} subs
                    {prev && (
                      <span className={'ml-2 text-xs ' + (subsDelta > 0 ? 'text-emerald-400' : subsDelta < 0 ? 'text-rose-400' : 'text-neutral-600')}>
                        {subsDelta === 0 ? '·' : `${subsDelta > 0 ? '+' : '−'}${Math.abs(subsDelta).toLocaleString()}`}
                      </span>
                    )}
                  </div>
                  <div className="tabular-nums text-neutral-200">
                    {formatCents(s.earnings_cents)}
                    {prev && earningsDelta !== 0 && (
                      <span className={'ml-2 text-xs ' + (earningsDelta > 0 ? 'text-emerald-400' : 'text-rose-400')}>
                        {earningsDelta > 0 ? '+' : '−'}{formatCents(Math.abs(earningsDelta))}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </Modal>
  );
}

function CumulativeStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-neutral-800 bg-neutral-950 p-4">
      <div className="text-[9px] uppercase tracking-widest text-neutral-600">{label}</div>
      <div className="mt-1.5 font-serif text-2xl font-semibold tabular-nums tracking-tight text-neutral-50">
        {value}
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-[10px] uppercase tracking-widest text-neutral-600">{label}</span>
      <span className="tabular-nums text-neutral-200">{value}</span>
    </div>
  );
}

// =============================================================================
//  Import modal — file → window + section assignments → save
// =============================================================================
type WindowPreset = '1m' | '3m' | '6m' | '9m' | '1y' | 'all';

const WINDOW_OPTIONS: { value: WindowPreset; label: string; detail: string }[] = [
  { value: '1m',  label: 'Last 1 month',   detail: '30 days back'  },
  { value: '3m',  label: 'Last 3 months',  detail: '90 days back'  },
  { value: '6m',  label: 'Last 6 months',  detail: '180 days back' },
  { value: '9m',  label: 'Last 9 months',  detail: '270 days back' },
  { value: '1y',  label: 'Last 1 year',    detail: '365 days back' },
  { value: 'all', label: 'All time',       detail: 'no filter'     },
];

function windowStartDate(preset: WindowPreset): string | null {
  if (preset === 'all') return null;
  const days = preset === '1m' ? 30
    : preset === '3m' ? 90
    : preset === '6m' ? 180
    : preset === '9m' ? 270
    : 365;
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [fileName, setFileName] = useState<string | null>(null);
  const [sections, setSections] = useState<ParsedSection[] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [unmapped, setUnmapped] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  const [windowPreset, setWindowPreset] = useState<WindowPreset>('9m');
  const [members, setMembers] = useState<TeamMember[]>([]);

  // assignment[sectionIndex] = team_member.id | 'skip'
  const [assignments, setAssignments] = useState<Map<number, string>>(new Map());

  // Fetch employees once on mount.
  useEffect(() => {
    void (async () => {
      try {
        const m = await listTeamMembers();
        setMembers(m);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not load team.');
      }
    })();
  }, []);

  async function handleFile(file: File) {
    setFileName(file.name);
    setSummary(null);
    try {
      const text = await file.text();
      const result = parseInflowwCsv(text);
      setSections(result.sections);
      setWarnings(result.warnings);
      setUnmapped(result.unmappedHeaders);

      // Auto-match each section to a team_member by name.
      const next = new Map<number, string>();
      result.sections.forEach((sec, i) => {
        const match = autoMatchModel(sec.modelName, members);
        next.set(i, match ? match.id : 'skip');
      });
      setAssignments(next);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not read file.');
    }
  }

  // Re-run auto-match if members load after the file is already parsed.
  useEffect(() => {
    if (!sections || assignments.size > 0 || members.length === 0) return;
    const next = new Map<number, string>();
    sections.forEach((sec, i) => {
      const match = autoMatchModel(sec.modelName, members);
      next.set(i, match ? match.id : 'skip');
    });
    setAssignments(next);
  }, [sections, members, assignments.size]);

  const windowStart = windowStartDate(windowPreset);

  // Per-section stats — how many rows survive the date filter, count of older skipped.
  const sectionStats = useMemo(() => {
    if (!sections) return [];
    return sections.map((sec) => {
      let inWindow = 0;
      let olderSkipped = 0;
      for (const r of sec.rows) {
        if (!windowStart || !r.date_created || r.date_created >= windowStart) inWindow++;
        else olderSkipped++;
      }
      return { inWindow, olderSkipped };
    });
  }, [sections, windowStart]);

  // Totals (taking assignments + window into account).
  const totals = useMemo(() => {
    if (!sections) return { willSave: 0, totalSkipped: 0 };
    let willSave = 0;
    let totalSkipped = 0;
    sections.forEach((_, i) => {
      const target = assignments.get(i);
      const stats = sectionStats[i]!;
      if (!target || target === 'skip') {
        totalSkipped += stats.inWindow + stats.olderSkipped;
      } else {
        willSave += stats.inWindow;
        totalSkipped += stats.olderSkipped;
      }
    });
    return { willSave, totalSkipped };
  }, [sections, sectionStats, assignments]);

  async function handleImport() {
    if (!sections || importing) return;
    setImporting(true);
    try {
      // Build the flat row list with team-member names and within-window filter.
      const rowsToImport: ParsedRow[] = [];
      const memberById = new Map(members.map((m) => [m.id, m]));
      sections.forEach((sec, i) => {
        const target = assignments.get(i);
        if (!target || target === 'skip') return;
        const member = memberById.get(target);
        if (!member) return;
        for (const r of sec.rows) {
          if (windowStart && r.date_created && r.date_created < windowStart) continue;
          rowsToImport.push({ ...r, user: member.name });
        }
      });
      if (rowsToImport.length === 0) {
        toast.error('Nothing to save. Assign at least one section to a model.');
        setImporting(false);
        return;
      }
      const s = await importParsedRows(rowsToImport);
      setSummary(s);
      toast.success(`Imported ${s.snapshots} snapshot${s.snapshots === 1 ? '' : 's'}.`);
    } catch (err) {
      console.error('Tracking import failed:', err);
      const message =
        err instanceof Error
          ? err.message
          : typeof err === 'object' && err && 'message' in err
            ? String((err as { message?: unknown }).message)
            : 'Import failed.';
      toast.error(message);
    } finally {
      setImporting(false);
    }
  }

  function resetFile() {
    setFileName(null);
    setSections(null);
    setSummary(null);
    setWarnings([]);
    setUnmapped([]);
    setAssignments(new Map());
  }

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Import"
      title="Infloww CSV"
      maxWidth="max-w-2xl"
    >
      {!fileName && (
        <div className="border border-dashed border-neutral-800 bg-neutral-950 p-10 text-center">
          <div className="font-serif text-lg text-neutral-200">Choose a CSV file</div>
          <div className="mt-2 text-[10px] uppercase tracking-widest text-neutral-600">
            Exported from Infloww. Headers are matched case-insensitively.
          </div>
          <label className="mt-5 inline-block cursor-pointer border border-neutral-700 px-5 py-2.5 text-[11px] uppercase tracking-widest text-neutral-200 transition-colors hover:border-neutral-400">
            Select file
            <input
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
              }}
            />
          </label>
        </div>
      )}

      {fileName && sections && !summary && (
        <>
          {/* File header */}
          <div className="mb-5 flex items-baseline justify-between border-b border-neutral-900 pb-3">
            <div>
              <div className="text-[10px] uppercase tracking-widest text-neutral-600">File</div>
              <div className="font-serif text-base text-neutral-100">{fileName}</div>
            </div>
            <TextLink onClick={resetFile}>Choose different file</TextLink>
          </div>

          {/* Time window picker */}
          <div className="mb-5">
            <div className="mb-2 text-[10px] uppercase tracking-widest text-neutral-500">
              Time window
            </div>
            <Select
              id="window"
              value={windowPreset}
              onChange={(v) => setWindowPreset(v as WindowPreset)}
              options={WINDOW_OPTIONS}
            />
          </div>

          {/* Summary stats */}
          <div className="mb-5 border border-neutral-900 bg-neutral-950 p-4 text-sm">
            <Stat2 label="Window starts" value={windowStart ?? 'No limit'} />
            <Stat2
              label={`Skipped (older than ${WINDOW_OPTIONS.find((o) => o.value === windowPreset)?.label.replace('Last ', '') ?? ''})`}
              value={totals.totalSkipped.toString()}
              dim
            />
            <Stat2
              label="Will save"
              value={`${totals.willSave.toLocaleString()} rows`}
              accent
            />
          </div>

          {(warnings.length > 0 || unmapped.length > 0) && (
            <div className="mb-5 border border-yellow-900/50 bg-yellow-950/20 p-4 text-xs text-yellow-200">
              {warnings.map((w, i) => (
                <div key={i}>{w}</div>
              ))}
              {unmapped.length > 0 && (
                <div className="mt-1 text-yellow-400">
                  Ignored columns: {unmapped.join(', ')}
                </div>
              )}
            </div>
          )}

          {/* Sections in file */}
          <div className="mb-5">
            <div className="mb-2 text-[10px] uppercase tracking-widest text-neutral-500">
              Sections in file
            </div>
            <div className="divide-y divide-neutral-900 border border-neutral-900">
              {sections.map((sec, i) => {
                const target = assignments.get(i) ?? 'skip';
                const stats = sectionStats[i]!;
                const matchedMember =
                  target !== 'skip' ? members.find((m) => m.id === target) : null;
                const isAutoMatched =
                  matchedMember &&
                  autoMatchModel(sec.modelName, members)?.id === matchedMember.id;
                return (
                  <div key={i} className="grid grid-cols-[1fr_12rem] items-center gap-3 px-3 py-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm text-neutral-100">
                        {sec.rawHeader}
                      </div>
                      <div className="mt-0.5 text-[10px] uppercase tracking-widest text-neutral-600">
                        {stats.inWindow} row{stats.inWindow === 1 ? '' : 's'} in window
                        {stats.olderSkipped > 0 ? ` · ${stats.olderSkipped} older skipped` : ''}
                        {isAutoMatched ? ` · auto-matched ${matchedMember!.name}` : ''}
                      </div>
                    </div>
                    <Select
                      id={`section-${i}`}
                      value={target}
                      onChange={(v) =>
                        setAssignments((m) => {
                          const next = new Map(m);
                          next.set(i, v);
                          return next;
                        })
                      }
                      options={[
                        { value: 'skip', label: '— Skip —', detail: 'don\'t save these rows' },
                        ...members.map((m) => ({
                          value: m.id,
                          label: m.name,
                          detail: m.role_label ?? payStructureLabel(m.pay_structure),
                        })),
                      ]}
                    />
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <Button
              type="button"
              onClick={handleImport}
              loading={importing}
              disabled={totals.willSave === 0}
            >
              Save {totals.willSave.toLocaleString()} row{totals.willSave === 1 ? '' : 's'}
            </Button>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </>
      )}

      {summary && (
        <>
          <div className="mb-5 border border-emerald-900/50 bg-emerald-950/20 p-5 text-sm text-emerald-200">
            <div className="font-serif text-lg">Imported.</div>
            <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-xs tabular-nums">
              <div>{summary.newUsers} new model{summary.newUsers === 1 ? '' : 's'}</div>
              <div>{summary.newLinks} new link{summary.newLinks === 1 ? '' : 's'}</div>
              <div>{summary.updatedLinks} updated link{summary.updatedLinks === 1 ? '' : 's'}</div>
              <div>{summary.snapshots} snapshot{summary.snapshots === 1 ? '' : 's'} saved</div>
            </div>
          </div>
          <Button type="button" onClick={onDone}>Done</Button>
        </>
      )}
    </Modal>
  );
}

function Stat2({
  label,
  value,
  dim,
  accent,
}: {
  label: string;
  value: string;
  dim?: boolean;
  accent?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between py-1">
      <span className={'text-xs ' + (dim ? 'text-neutral-500' : 'text-neutral-400')}>
        {label}
      </span>
      <span
        className={
          'tabular-nums ' +
          (accent
            ? 'font-serif text-base text-neutral-50'
            : dim
              ? 'text-neutral-500'
              : 'text-neutral-200')
        }
      >
        {value}
      </span>
    </div>
  );
}


// =============================================================================
//  TrackingGearIcon — matches the gear used on the Expenses page so the two
//  page-level settings entry points feel like the same affordance.
// =============================================================================
function TrackingGearIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
