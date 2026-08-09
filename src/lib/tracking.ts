// =============================================================================
//  tracking.ts
//  Tracking links — list + import from Infloww CSVs.
//
//  The DB stores time-series snapshots per link (one per CSV upload). For
//  v1 we only display the latest snapshot per link.
// =============================================================================

import { supabase } from './supabase';
import { getActiveAgencyId } from './agency';

// =============================================================================
//  Types
// =============================================================================
export type TrackingUser = {
  id: string;
  agency_id: string;
  name: string;
  created_at: string;
};

export type TrackingLink = {
  id: string;
  agency_id: string;
  user_id: string;
  name: string;
  date_created: string | null;
  source: string | null;
  tag: string | null;
  list: string | null;
};

export type TrackingSnapshot = {
  id: string;
  agency_id: string;
  link_id: string;
  recorded_at: string;
  clicks: number;
  subs: number;
  fans_who_spent: number;
  subscription_cvr: number | null;
  spending_cvr: number | null;
  promo_cost_cents: number;
  earnings_cents: number;
  profit_cents: number;
  cpc: number | null;
  epc: number | null;
  cps: number | null;
  aeps: number | null;
  roi: number | null;
  source_csv_uploaded_at: string | null;
};

// Combined view used by the page — link metadata + most-recent metrics.
export type LinkWithLatest = TrackingLink & {
  latest: TrackingSnapshot | null;
};

// =============================================================================
//  Queries
// =============================================================================
export async function listUsers(): Promise<TrackingUser[]> {
  const agencyId = getActiveAgencyId();
  if (!agencyId) return [];
  const { data, error } = await supabase
    .from('tracking_users')
    .select('id, agency_id, name, created_at')
    .eq('agency_id', agencyId)
    .order('name', { ascending: true });
  if (error) throw error;
  return (data ?? []) as TrackingUser[];
}

// Just the links — used by the new delta-driven view that pairs them with
// every snapshot in range.
export async function listLinks(): Promise<TrackingLink[]> {
  const agencyId = getActiveAgencyId();
  if (!agencyId) return [];
  const { data, error } = await supabase
    .from('tracking_links')
    .select('id, agency_id, user_id, name, date_created, source, tag, list')
    .eq('agency_id', agencyId)
    .is('deleted_at', null)
    .order('name', { ascending: true });
  if (error) throw error;
  return (data ?? []) as unknown as TrackingLink[];
}

// Every snapshot in the given window (or all, if no rangeStart).
export async function listAllSnapshots(opts?: {
  rangeStart?: string;
  rangeEnd?: string;
}): Promise<TrackingSnapshot[]> {
  const agencyId = getActiveAgencyId();
  if (!agencyId) return [];
  let q = supabase
    .from('tracking_link_snapshots')
    .select(
      'id, agency_id, link_id, recorded_at, clicks, subs, fans_who_spent, ' +
        'subscription_cvr, spending_cvr, promo_cost_cents, earnings_cents, ' +
        'profit_cents, cpc, epc, cps, aeps, roi, source_csv_uploaded_at',
    )
    .eq('agency_id', agencyId)
    .order('recorded_at', { ascending: false });
  if (opts?.rangeStart) q = q.gte('recorded_at', opts.rangeStart);
  if (opts?.rangeEnd) q = q.lte('recorded_at', opts.rangeEnd);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as TrackingSnapshot[];
}

export async function listLinksWithLatest(opts?: {
  rangeStart?: string; // ISO timestamp
  rangeEnd?: string;
}): Promise<LinkWithLatest[]> {
  const agencyId = getActiveAgencyId();
  if (!agencyId) return [];
  // Two fetches: links, then snapshots (filtered to range). For each link
  // we keep the most recent snapshot within the range. Links with no
  // snapshot in range are returned with latest=null.
  let snapQuery = supabase
    .from('tracking_link_snapshots')
    .select(
      'id, agency_id, link_id, recorded_at, clicks, subs, fans_who_spent, ' +
        'subscription_cvr, spending_cvr, promo_cost_cents, earnings_cents, ' +
        'profit_cents, cpc, epc, cps, aeps, roi, source_csv_uploaded_at',
    )
    .eq('agency_id', agencyId)
    .order('recorded_at', { ascending: false });
  if (opts?.rangeStart) snapQuery = snapQuery.gte('recorded_at', opts.rangeStart);
  if (opts?.rangeEnd) snapQuery = snapQuery.lte('recorded_at', opts.rangeEnd);

  const [linksRes, snapsRes] = await Promise.all([
    supabase
      .from('tracking_links')
      .select('id, agency_id, user_id, name, date_created, source, tag, list')
      .eq('agency_id', agencyId)
      .is('deleted_at', null)
      .order('name', { ascending: true }),
    snapQuery,
  ]);
  if (linksRes.error) throw linksRes.error;
  if (snapsRes.error) throw snapsRes.error;

  const latestByLink = new Map<string, TrackingSnapshot>();
  for (const s of (snapsRes.data ?? []) as unknown as TrackingSnapshot[]) {
    if (!latestByLink.has(s.link_id)) latestByLink.set(s.link_id, s);
  }

  return ((linksRes.data ?? []) as unknown as TrackingLink[]).map((l) => ({
    ...l,
    latest: latestByLink.get(l.id) ?? null,
  }));
}

// =============================================================================
//  Uploads — group snapshots by recorded_at (each CSV import shares one ts)
// =============================================================================
export type UploadSummary = {
  recorded_at: string;        // ISO timestamp shared by every snapshot from one CSV
  snapshot_count: number;
  total_earnings_cents: number;
  total_clicks: number;
};

export async function listUploads(): Promise<UploadSummary[]> {
  const agencyId = getActiveAgencyId();
  if (!agencyId) return [];
  // PostgREST doesn't have a clean DISTINCT/GROUP BY shortcut, so we fetch
  // the lightweight fields and aggregate in JS. Snapshots from one CSV
  // share the exact same recorded_at (set once at import time).
  const { data, error } = await supabase
    .from('tracking_link_snapshots')
    .select('recorded_at, earnings_cents, clicks')
    .eq('agency_id', agencyId)
    .order('recorded_at', { ascending: false });
  if (error) throw error;
  const byTs = new Map<string, { count: number; earnings: number; clicks: number }>();
  for (const s of (data ?? []) as { recorded_at: string; earnings_cents: number; clicks: number }[]) {
    const v = byTs.get(s.recorded_at) ?? { count: 0, earnings: 0, clicks: 0 };
    v.count += 1;
    v.earnings += s.earnings_cents;
    v.clicks += s.clicks;
    byTs.set(s.recorded_at, v);
  }
  return Array.from(byTs.entries())
    .map(([recorded_at, v]) => ({
      recorded_at,
      snapshot_count: v.count,
      total_earnings_cents: v.earnings,
      total_clicks: v.clicks,
    }))
    .sort((a, b) => (a.recorded_at < b.recorded_at ? 1 : -1));
}

export async function deleteUpload(recordedAt: string): Promise<number> {
  // Hard delete all snapshots from that import. Links themselves stay —
  // they may have snapshots from other imports.
  const { data, error } = await supabase
    .from('tracking_link_snapshots')
    .delete()
    .eq('recorded_at', recordedAt)
    .select('id');
  if (error) throw error;
  return data?.length ?? 0;
}

export async function softDeleteLink(id: string): Promise<void> {
  const { error } = await supabase
    .from('tracking_links')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

// =============================================================================
//  CSV parsing — RFC 4180-ish, handles quoted fields w/ embedded commas
// =============================================================================
export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const flushField = () => {
    row.push(field);
    field = '';
  };
  const flushRow = () => {
    out.push(row);
    row = [];
  };
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          // Escaped quote inside a quoted field.
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ',') {
      flushField();
      i++;
      continue;
    }
    if (c === '\r') {
      // CRLF — skip; LF below will flush the row.
      i++;
      continue;
    }
    if (c === '\n') {
      flushField();
      flushRow();
      i++;
      continue;
    }
    field += c;
    i++;
  }
  // Tail.
  if (field.length > 0 || row.length > 0) {
    flushField();
    flushRow();
  }
  // Drop any trailing fully-empty row.
  while (out.length > 0 && out[out.length - 1]!.every((v) => v.trim() === '')) {
    out.pop();
  }
  return out;
}

// =============================================================================
//  Column matching — be forgiving about header variants
// =============================================================================
function norm(s: string): string {
  return s.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

// Map header label aliases to canonical field keys. The norm() function
// strips spaces / underscores / dashes and lowercases, so aliases below
// are written in their normalized form.
const HEADER_ALIASES: Record<string, string> = {
  user: 'user',
  model: 'user',
  name: 'name',
  link: 'name',
  linkname: 'name',
  trackinglink: 'name', // Infloww header
  datecreated: 'date_created',
  created: 'date_created',
  source: 'source',
  platform: 'source',
  tag: 'tag',
  list: 'list',
  clicks: 'clicks',
  subs: 'subs',
  subscribers: 'subs',
  fanswhospent: 'fans_who_spent',
  subscriptioncvr: 'subscription_cvr',
  subcvr: 'subscription_cvr',
  spendingcvr: 'spending_cvr',
  promocost: 'promo_cost',
  cost: 'promo_cost',
  earnings: 'earnings',
  revenue: 'earnings',
  profit: 'profit',
  cpc: 'cpc',
  epc: 'epc',
  cps: 'cps',
  aeps: 'aeps',
  roi: 'roi',
  lastupdated: '__ignore__', // tracked, but discarded
};

export type ParsedRow = {
  user: string;
  name: string;
  date_created: string | null;
  source: string | null;
  tag: string | null;
  list: string | null;
  clicks: number;
  subs: number;
  fans_who_spent: number;
  subscription_cvr: number | null;
  spending_cvr: number | null;
  promo_cost_cents: number;
  earnings_cents: number;
  profit_cents: number;
  cpc: number | null;
  epc: number | null;
  cps: number | null;
  aeps: number | null;
  roi: number | null;
};

// One section of the Infloww CSV — the rows under one model's header.
export type ParsedSection = {
  rawHeader: string;          // Full header line e.g. "Ember 🔥(2365…): Table 1"
  modelName: string;          // Extracted model name e.g. "Ember 🔥"
  rows: ParsedRow[];
};

export type ParseResult = {
  rows: ParsedRow[];           // Flat list (kept for backwards compat)
  sections: ParsedSection[];
  unmappedHeaders: string[];
  warnings: string[];
};

// Section header detection — Infloww CSVs are multi-section:
//
//   Ember 🔥(2365406295883784): Table 1
//   Tracking link,Date created,Clicks,...
//   <data rows>
//
//   Anastasia(2365403259338802): Table 1
//   Tracking link,Date created,Clicks,...
//   <data rows>
//
// We also support flat CSVs that have a single header with a "User" column.
export function isSectionHeader(row: string[]): boolean {
  const first = (row[0] ?? '').trim();
  if (!first) return false;
  // Other cells must be empty for it to be a section header line.
  if (row.slice(1).some((c) => (c ?? '').trim() !== '')) return false;
  // Ends with ": Table N".
  return /:\s*Table\s+\d+\s*$/i.test(first);
}

// Normalize a model name for auto-matching: lowercase, drop emojis +
// punctuation, collapse whitespace. "Ember 🔥" → "ember", "Queen Laura Ts"
// → "queen laura ts".
export function normalizeModelName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Try to match a CSV model name to a list of candidates by normalized name.
// Exact match first, then substring (either direction). Returns id or null.
export function autoMatchModel<T extends { id: string; name: string }>(
  csvName: string,
  candidates: T[],
): T | null {
  const target = normalizeModelName(csvName);
  if (!target) return null;
  const norm = candidates.map((c) => ({ c, n: normalizeModelName(c.name) }));
  // Exact match.
  const exact = norm.find(({ n }) => n === target);
  if (exact) return exact.c;
  // Substring — pick the longest matching candidate to prefer specificity.
  const partial = norm
    .filter(({ n }) => n && (n.includes(target) || target.includes(n)))
    .sort((a, b) => b.n.length - a.n.length)[0];
  return partial?.c ?? null;
}

export function extractModelName(raw: string): string {
  // Strip everything from the last '(' onward (Infloww ID + ": Table N").
  // Some rows are truncated and missing the closing paren — that's fine.
  const lastParen = raw.lastIndexOf('(');
  if (lastParen > 0) return raw.slice(0, lastParen).trim();
  // No '(' — just strip the ": Table N" suffix.
  return raw.replace(/:\s*Table\s+\d+\s*$/i, '').trim();
}

export function parseInflowwCsv(text: string): ParseResult {
  // Strip a UTF-8 BOM if present.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const grid = parseCsv(text);
  if (grid.length === 0) {
    return { rows: [], sections: [], unmappedHeaders: [], warnings: ['File is empty.'] };
  }

  const sections: ParsedSection[] = [];
  const unmappedSet = new Set<string>();
  const warnings: string[] = [];

  // State as we walk through the file. We reset colMap on blank lines
  // and section headers so a new column row is re-read for each section
  // (Infloww always re-emits the column header per section).
  let currentSection: ParsedSection | null = null;
  let colMap: Record<string, number> | null = null;
  let userColIdx: number | null = null;

  for (const row of grid) {
    // Blank line — ends the current section's data block.
    if (row.every((c) => !(c ?? '').trim())) {
      colMap = null;
      continue;
    }

    if (isSectionHeader(row)) {
      const raw = row[0]!;
      currentSection = {
        rawHeader: raw,
        modelName: extractModelName(raw),
        rows: [],
      };
      sections.push(currentSection);
      colMap = null;
      userColIdx = null;
      continue;
    }

    // First non-blank row of a section is the column header.
    if (colMap === null) {
      colMap = {};
      userColIdx = null;
      row.forEach((h, idx) => {
        const key = HEADER_ALIASES[norm(h)];
        if (key === '__ignore__') return;
        if (key === 'user') userColIdx = idx;
        else if (key) colMap![key] = idx;
        else if ((h ?? '').trim()) unmappedSet.add(h);
      });
      continue;
    }

    // Data row.
    const get = (k: string) =>
      colMap![k] != null ? (row[colMap![k]!] ?? '').trim() : '';
    const userFromCol =
      userColIdx != null ? (row[userColIdx] ?? '').trim() : '';
    const user = userFromCol || currentSection?.modelName || '';
    const name = get('name');
    if (!user || !name) continue;

    const parsed: ParsedRow = {
      user,
      name,
      date_created: parseDate(get('date_created')),
      source: get('source') || null,
      tag: get('tag') || null,
      list: get('list') || null,
      clicks: parseInt0(get('clicks')),
      subs: parseInt0(get('subs')),
      fans_who_spent: parseInt0(get('fans_who_spent')),
      subscription_cvr: parsePct(get('subscription_cvr')),
      spending_cvr: parsePct(get('spending_cvr')),
      promo_cost_cents: dollarsToCents(get('promo_cost')),
      earnings_cents: dollarsToCents(get('earnings')),
      profit_cents: dollarsToCents(get('profit')),
      cpc: parseNum(get('cpc')),
      epc: parseNum(get('epc')),
      cps: parseNum(get('cps')),
      aeps: parseNum(get('aeps')),
      roi: parsePct(get('roi')),
    };

    // Flat-CSV case (no section header but a User column): create a synthetic
    // section keyed on the user name.
    if (!currentSection) {
      const synth: ParsedSection = { rawHeader: user, modelName: user, rows: [] };
      sections.push(synth);
      currentSection = synth;
    }
    currentSection.rows.push(parsed);
  }

  // Dedupe within each section by name. The DB unique constraint is
  // (user_id, name), so keep first occurrence.
  let duplicateCount = 0;
  for (const sec of sections) {
    const seen = new Set<string>();
    sec.rows = sec.rows.filter((r) => {
      if (seen.has(r.name)) { duplicateCount++; return false; }
      seen.add(r.name);
      return true;
    });
  }
  if (duplicateCount > 0) {
    warnings.push(
      `${duplicateCount} duplicate link${duplicateCount === 1 ? '' : 's'} skipped (same name twice in one section).`,
    );
  }

  const flatRows = sections.flatMap((s) => s.rows);
  if (flatRows.length === 0) {
    warnings.push(
      'No tracking links recognized. Expected the standard export format with section headers like "ModelName(ID): Table 1".',
    );
  }

  return {
    rows: flatRows,
    sections,
    unmappedHeaders: Array.from(unmappedSet),
    warnings,
  };
}

// CSV value coercions — Infloww emits "—", "", "N/A", "$1,234.56", "23.45%" etc.
function parseInt0(v: string): number {
  if (!v) return 0;
  const n = parseInt(v.replace(/[^0-9-]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}
function parseNum(v: string): number | null {
  if (!v || v === '—' || v === '-' || /^N\/?A$/i.test(v)) return null;
  const n = Number(v.replace(/[$,%\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}
function parsePct(v: string): number | null {
  return parseNum(v); // stored as-is; Infloww already gives e.g. 23.45 for 23.45%
}
function dollarsToCents(v: string): number {
  const n = parseNum(v);
  if (n == null) return 0;
  return Math.round(n * 100);
}
// Month name → 0-indexed month number, for parsing "MMM D, YYYY" dates
// like "May 2, 2026" or "Jan 1, 2025" that Infloww emits.
const MONTH_MAP: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

function parseDate(v: string): string | null {
  if (!v) return null;
  const s = v.trim();
  // ISO (YYYY-MM-DD)
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // M/D/YYYY or MM/DD/YYYY
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (slash) {
    const [, mo, d, y] = slash;
    return `${y}-${mo!.padStart(2, '0')}-${d!.padStart(2, '0')}`;
  }
  // "MMM D, YYYY" — Infloww's format. Case-insensitive; comma optional.
  const named = s.match(/^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (named) {
    const [, monName, d, y] = named;
    const mo = MONTH_MAP[monName!.toLowerCase()];
    if (mo != null) {
      return `${y}-${String(mo + 1).padStart(2, '0')}-${d!.padStart(2, '0')}`;
    }
  }
  return null;
}

// =============================================================================
//  Import — upsert users, upsert links, insert snapshots
// =============================================================================
export type ImportSummary = {
  newUsers: number;
  newLinks: number;
  updatedLinks: number;
  snapshots: number;
};

// Wrap a Supabase error object as a real Error so the message bubbles up
// through React error handling cleanly (the raw object isn't an Error
// instance and would get swallowed by generic fallbacks).
function wrapSupabaseError(stage: string, error: { message?: string; details?: string; hint?: string; code?: string }): Error {
  const parts = [error.message, error.details, error.hint].filter(Boolean);
  return new Error(`${stage}: ${parts.join(' — ') || 'unknown error'}${error.code ? ` (${error.code})` : ''}`);
}

export async function importParsedRows(rows: ParsedRow[]): Promise<ImportSummary> {
  const agencyId = getActiveAgencyId();
  if (!agencyId) throw new Error('No active agency.');
  if (rows.length === 0) return { newUsers: 0, newLinks: 0, updatedLinks: 0, snapshots: 0 };

  // 1. Upsert unique users.
  const userNames = Array.from(new Set(rows.map((r) => r.user)));
  const existingUsersRes = await supabase
    .from('tracking_users')
    .select('id, name')
    .in('name', userNames);
  if (existingUsersRes.error) throw wrapSupabaseError('Loading existing users', existingUsersRes.error);
  const userIdByName = new Map<string, string>(
    (existingUsersRes.data ?? []).map((u: { id: string; name: string }) => [u.name, u.id]),
  );

  const newUserPayload = userNames
    .filter((n) => !userIdByName.has(n))
    .map((n) => ({ agency_id: agencyId, name: n }));
  let newUsers = 0;
  if (newUserPayload.length > 0) {
    const ins = await supabase
      .from('tracking_users')
      .insert(newUserPayload)
      .select('id, name');
    if (ins.error) throw wrapSupabaseError('Inserting models', ins.error);
    for (const u of ins.data ?? []) userIdByName.set(u.name, u.id);
    newUsers = ins.data?.length ?? 0;
  }

  // 2. Reconcile links manually. We can't use upsert here because the unique
  //    constraint on (user_id, name) is a *partial* unique index — it only
  //    applies where deleted_at IS NULL. PostgREST's onConflict doesn't pass
  //    the predicate, so Postgres rejects the upsert (error 42P10).
  //
  //    Instead: fetch existing links → insert only the new ones → and for
  //    links that already exist, backfill any null metadata (date_created,
  //    source, tag, list) from the latest parse. This lets a re-import
  //    fix up old rows that were imported before a parser fix.
  const linkKey = (uid: string, name: string) => `${uid}::${name}`;

  const existingLinksRes = await supabase
    .from('tracking_links')
    .select('id, user_id, name, date_created, source, tag, list')
    .in('user_id', Array.from(userIdByName.values()))
    .is('deleted_at', null);
  if (existingLinksRes.error) throw wrapSupabaseError('Loading existing links', existingLinksRes.error);
  type ExistingLink = {
    id: string;
    user_id: string;
    name: string;
    date_created: string | null;
    source: string | null;
    tag: string | null;
    list: string | null;
  };
  const linkIdByKey = new Map<string, string>();
  const existingByKey = new Map<string, ExistingLink>();
  for (const l of (existingLinksRes.data ?? []) as ExistingLink[]) {
    linkIdByKey.set(linkKey(l.user_id, l.name), l.id);
    existingByKey.set(linkKey(l.user_id, l.name), l);
  }

  // Build the new-link payload — only links not already in the map.
  const newLinkPayload: { agency_id: string; user_id: string; name: string; date_created: string | null; source: string | null; tag: string | null; list: string | null }[] = [];
  const seenNewKeys = new Set<string>();
  for (const r of rows) {
    const uid = userIdByName.get(r.user);
    if (!uid) continue;
    const key = linkKey(uid, r.name);
    if (linkIdByKey.has(key) || seenNewKeys.has(key)) continue;
    seenNewKeys.add(key);
    newLinkPayload.push({
      agency_id: agencyId,
      user_id: uid,
      name: r.name,
      date_created: r.date_created,
      source: r.source,
      tag: r.tag,
      list: r.list,
    });
  }

  // Upsert each new link. We can't batch-insert: the "existing" set above can
  // miss rows (PostgREST caps SELECTs at 1000 rows, and RLS can hide some), so
  // a link we think is new may already exist as an active row. A batch insert
  // would then be rejected wholesale with a unique violation (23505). And we
  // can't use PostgREST upsert because the conflict target is a *partial*
  // index (error 42P10). So: insert per row, and on a unique violation fall
  // back to fetching the existing active link's id and reusing it.
  let newLinks = 0;
  const upserted = await Promise.all(
    newLinkPayload.map(async (payload) => {
      const ins = await supabase
        .from('tracking_links')
        .insert(payload)
        .select('id, user_id, name')
        .single();
      if (!ins.error && ins.data) {
        return { row: ins.data as { id: string; user_id: string; name: string }, inserted: true };
      }
      if (ins.error?.code === '23505') {
        const existing = await supabase
          .from('tracking_links')
          .select('id, user_id, name')
          .eq('user_id', payload.user_id)
          .eq('name', payload.name)
          .is('deleted_at', null)
          .single();
        if (existing.error) throw wrapSupabaseError('Resolving existing link', existing.error);
        return { row: existing.data as { id: string; user_id: string; name: string }, inserted: false };
      }
      throw wrapSupabaseError('Inserting links', ins.error!);
    }),
  );
  for (const { row, inserted } of upserted) {
    linkIdByKey.set(linkKey(row.user_id, row.name), row.id);
    if (inserted) newLinks += 1;
  }

  // Count how many rows mapped to an existing link.
  const updatedLinks = rows.reduce((n, r) => {
    const uid = userIdByName.get(r.user);
    if (!uid) return n;
    const key = linkKey(uid, r.name);
    return seenNewKeys.has(key) ? n : n + 1;
  }, 0);

  // Backfill metadata on existing links — only set fields that are
  // currently null in the DB so we never overwrite something the user
  // (or a previous import) already populated.
  const backfillPromises: Promise<unknown>[] = [];
  const seenBackfill = new Set<string>();
  for (const r of rows) {
    const uid = userIdByName.get(r.user);
    if (!uid) continue;
    const key = linkKey(uid, r.name);
    if (seenBackfill.has(key)) continue;
    seenBackfill.add(key);
    const existing = existingByKey.get(key);
    if (!existing) continue; // it's a brand-new link, nothing to backfill
    const fields: Record<string, unknown> = {};
    if (!existing.date_created && r.date_created) fields.date_created = r.date_created;
    if (!existing.source       && r.source)       fields.source       = r.source;
    if (!existing.tag          && r.tag)          fields.tag          = r.tag;
    if (!existing.list         && r.list)         fields.list         = r.list;
    if (Object.keys(fields).length === 0) continue;
    backfillPromises.push(
      Promise.resolve(supabase.from('tracking_links').update(fields).eq('id', existing.id)),
    );
  }
  if (backfillPromises.length > 0) {
    await Promise.all(backfillPromises);
  }

  // 3. Insert one snapshot per parsed row. Skip rows whose link wasn't
  //    returned by the upsert (shouldn't happen, but guard anyway).
  const recordedAt = new Date().toISOString();
  const snapshotPayload: Record<string, unknown>[] = [];
  const skippedSnapshots: string[] = [];
  for (const r of rows) {
    const uid = userIdByName.get(r.user);
    if (!uid) { skippedSnapshots.push(`${r.user}::${r.name} (no user id)`); continue; }
    const linkId = linkIdByKey.get(linkKey(uid, r.name));
    if (!linkId) { skippedSnapshots.push(`${r.user}::${r.name} (no link id)`); continue; }
    snapshotPayload.push({
      agency_id: agencyId,
      link_id: linkId,
      recorded_at: recordedAt,
      clicks: r.clicks,
      subs: r.subs,
      fans_who_spent: r.fans_who_spent,
      subscription_cvr: r.subscription_cvr,
      spending_cvr: r.spending_cvr,
      promo_cost_cents: r.promo_cost_cents,
      earnings_cents: r.earnings_cents,
      profit_cents: r.profit_cents,
      cpc: r.cpc,
      epc: r.epc,
      cps: r.cps,
      aeps: r.aeps,
      roi: r.roi,
      source_csv_uploaded_at: recordedAt,
    });
  }
  if (skippedSnapshots.length > 0) {
    console.warn('Skipped snapshots:', skippedSnapshots);
  }
  if (snapshotPayload.length > 0) {
    const snapIns = await supabase
      .from('tracking_link_snapshots')
      .insert(snapshotPayload);
    if (snapIns.error) throw wrapSupabaseError('Inserting snapshots', snapIns.error);
  }

  return {
    newUsers,
    newLinks,
    updatedLinks,
    snapshots: snapshotPayload.length,
  };
}
