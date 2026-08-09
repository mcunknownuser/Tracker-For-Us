// =============================================================================
//  Upload profiling — the shape of the data, never the data itself.
//
//  This is what the AI planner sees. A week of Infloww exports is tens of
//  thousands of cells; sending them would be expensive, slow, and would let the
//  model read figures it might then quote. So the planner gets column names,
//  an inferred type, a handful of raw samples, and a numeric range — enough to
//  decide WHAT to compute, never enough to compute it. Every number in a
//  finished report still comes out of engine.ts.
//
//  Two things here are load-bearing:
//
//    "-" is not data. Infloww writes it for not-applicable. A column of "-" is
//    'empty' and its nonEmpty is 0 — if that leaked through as zero, "no hours
//    logged" would read as "zero hours worked" and every per-hour metric built
//    on it would be silently wrong.
//
//    signature is a hash of the normalized headers and nothing else. Same
//    export shape next week means the same signature, which is how a saved
//    ReportSpec gets reused instead of re-planned. Row count, file name and
//    cell values must never move it.
// =============================================================================
import type { ColumnProfile, ColumnType, RawTable, TableProfile, UploadProfile } from './types';
import { coerce, isEmptyValue, parseCurrency, parseDuration, parseNumber, parsePercent } from './coerce';

const TYPE_SAMPLE_LIMIT = 200;   // values inspected per column for type inference
const TYPE_MAJORITY = 0.8;       // below this the column is mixed — call it a string
const MAX_SAMPLES = 5;

// Type inference is a test of FORM, not of parseability. parseCurrency("4063")
// happily returns 4063, so "does the parser accept it" would label every count
// column as money. A value is currency only if it is written like currency.
const CURRENCY_MARK = /[$£€]/;

// Duration must match end to end, so free text that merely contains a stray
// "3d" ("Room 3d") is not mistaken for one. Units mirror coerce.ts.
const DURATION_SHAPE =
  /^(?:\d+(?:\.\d+)?\s*(?:years?|yrs?|y|months?|mos?|weeks?|wks?|w|days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,]*)+$/i;

// Anchored, so a period range ("2026-07-05 00:00:00 - 2026-07-11 23:59:59")
// stays a string rather than claiming to be a single date.
const DATE_SHAPE = /^(?:\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?|\d{1,2}\/\d{1,2}\/\d{2,4})$/;

const NUMERIC_TYPES = new Set<ColumnType>(['number', 'currency', 'percent', 'duration']);

// Caller guarantees raw is non-empty. Order matters: the specific formats get
// first refusal, and a bare number is only a number once they've all declined.
function classifyValue(raw: string): ColumnType {
  const s = raw.trim();
  if (CURRENCY_MARK.test(s) && parseCurrency(s) !== null) return 'currency';
  if (s.includes('%') && parsePercent(s) !== null) return 'percent';
  if (DURATION_SHAPE.test(s) && parseDuration(s) !== null) return 'duration';
  if (DATE_SHAPE.test(s)) return 'date';
  if (parseNumber(s) !== null) return 'number';
  return 'string';
}

function profileColumn(name: string, index: number, rows: string[][]): ColumnProfile {
  const distinct = new Set<string>();
  const samples: string[] = [];
  const emptySamples: string[] = [];
  const typeCounts = new Map<ColumnType, number>();
  let nonEmpty = 0;
  let typeSampled = 0;

  for (const row of rows) {
    const raw = row[index] ?? '';
    if (isEmptyValue(raw)) {
      // Kept only as a fallback sample, so an all-"-" column still shows the
      // planner what it actually contains.
      if (emptySamples.length < MAX_SAMPLES && !emptySamples.includes(raw)) emptySamples.push(raw);
      continue;
    }
    nonEmpty++;
    distinct.add(raw);
    if (samples.length < MAX_SAMPLES && !samples.includes(raw)) samples.push(raw);
    if (typeSampled < TYPE_SAMPLE_LIMIT) {
      typeSampled++;
      const t = classifyValue(raw);
      typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
    }
  }

  let type: ColumnType = 'empty';
  if (typeSampled > 0) {
    let best: ColumnType = 'string';
    let bestCount = 0;
    for (const [t, count] of typeCounts) {
      if (count > bestCount) {
        best = t;
        bestCount = count;
      }
    }
    type = bestCount / typeSampled >= TYPE_MAJORITY ? best : 'string';
  }

  for (const raw of emptySamples) {
    if (samples.length >= MAX_SAMPLES) break;
    samples.push(raw);
  }

  const profile: ColumnProfile = {
    name,
    index,
    type,
    nonEmpty,
    distinct: distinct.size,   // distinct non-empty values — usable groupBy cardinality
    samples,
  };

  if (NUMERIC_TYPES.has(type)) {
    let min = Infinity;
    let max = -Infinity;
    for (const row of rows) {
      const raw = row[index] ?? '';
      if (isEmptyValue(raw)) continue;
      const n = coerce(raw, type);
      if (n == null) continue;
      if (n < min) min = n;
      if (n > max) max = n;
    }
    if (Number.isFinite(min)) {
      profile.min = min;
      profile.max = max;
    }
  }

  return profile;
}

// djb2. Deterministic and dependency-free; a 32-bit space is ample for the
// handful of export shapes one agency sees, and a stale match still has to
// survive column-name lookup in the executor.
function hash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h * 33) ^ input.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// Cosmetic differences in a re-export (casing, padding) must not look like a
// new shape. Column order still does — a reordered export is a different one.
function normalizeHeader(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function tableSignature(headers: string[]): string {
  // \u0001 as the joiner: it cannot occur in a header, so ["a|b"] and ["a","b"]
  // can never collide.
  return hash(headers.map(normalizeHeader).join('\u0001'));
}

export function profileTable(table: RawTable): TableProfile {
  return {
    id: table.id,
    sourceFile: table.sourceFile,
    sheetName: table.sheetName,
    rowCount: table.rows.length,
    columns: table.headers.map((name, i) => profileColumn(name, i, table.rows)),
    signature: tableSignature(table.headers),
  };
}

export function profileUpload(tables: RawTable[]): UploadProfile {
  const profiled = tables.map(profileTable);
  // Sorted, so dropping the same five files in a different order is still the
  // same upload as far as spec reuse is concerned.
  const signature = hash(profiled.map((t) => t.signature).sort().join('\u0001'));
  return { tables: profiled, signature };
}
