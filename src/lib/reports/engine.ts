// =============================================================================
//  Report engine — the only place in the pipeline that produces a number.
//
//  The planner (AI) says WHAT to compute; this file decides HOW and does the
//  arithmetic. Every figure a staff member reads on their report comes out of
//  here, so each one has to be re-derivable from the source rows. Four rules
//  drive most of the code below, and all four exist because the alternative
//  puts a confident wrong number in front of a real person:
//
//    1. Null is not zero. "-", blank and unparseable cells are dropped from
//       sums and means, never coerced to 0. A mean over 3 present values out
//       of 10 rows divides by 3.
//    2. A zero denominator yields raw: null / "—" / a note. Dimple clocked
//       0min the week she did $1,928 of sales — that is a tracking gap, and
//       printing "0.00/hr" would be an accusation, not a measurement.
//    3. A provided column beats a recomputed one. by-employee.csv ships
//       "Sales per hour" = $43.23 for Swift while Sales ÷ Clocked hours is
//       44.50 — Infloww computes it on a basis we do not have. Use the column,
//       and when the derived value disagrees by >1%, record BOTH in a note
//       instead of silently picking a side.
//    4. A broken section must not break the report. Failures are caught per
//       section (and per metric) and surfaced as text; a missing column is an
//       error message, not an exception.
//
//  All value reading and all display formatting go through coerce.ts, so the
//  profile and the engine can never disagree about what a cell means.
// =============================================================================

import type {
  Aggregation,
  ColumnType,
  ComputedReport,
  ComputedRow,
  ComputedSection,
  ComputedValue,
  Metric,
  Predicate,
  RawTable,
  ReportSpec,
  Section,
} from './types';
import {
  coerce,
  durationToHours,
  formatValue,
  isEmptyValue,
  parseDuration,
  parseNumber,
} from './coerce';

// profile.ts owns type inference; it is passed in rather than imported so the
// two stages stay independent. tableId -> column name -> ColumnType.
export type ColumnTypeMap = Record<string, Record<string, ColumnType>>;

// ---- Table context ---------------------------------------------------------

type Ctx = {
  table: RawTable;
  declared: Record<string, ColumnType> | undefined;
  resolved: Map<string, ColumnType>;
};

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function columnIndex(ctx: Ctx, name: string): number {
  const exact = ctx.table.headers.indexOf(name);
  if (exact !== -1) return exact;
  const target = norm(name);
  const i = ctx.table.headers.findIndex((h) => norm(h) === target);
  if (i === -1) {
    throw new Error(
      `Column "${name}" is not in ${ctx.table.sourceFile}. Available: ${ctx.table.headers.join(', ')}`,
    );
  }
  return i;
}

// A column's type decides how its cells are read AND whether a denominator is
// seconds that need converting to hours — so getting it wrong is a wrong
// number, not a cosmetic issue. The profile's answer wins; sniffing is only a
// fallback for columns it did not describe, and it must never guess "number"
// for "$1,928.00".
function resolveType(ctx: Ctx, name: string, index: number): ColumnType {
  const cached = ctx.resolved.get(name);
  if (cached) return cached;

  let type: ColumnType | undefined = ctx.declared?.[name];
  if (!type && ctx.declared) {
    const target = norm(name);
    const hit = Object.keys(ctx.declared).find((k) => norm(k) === target);
    if (hit) type = ctx.declared[hit];
  }
  if (!type) type = sniffType(ctx.table, index);

  ctx.resolved.set(name, type);
  return type;
}

function sniffType(table: RawTable, index: number): ColumnType {
  let seen = 0;
  for (const row of table.rows) {
    const cell = row[index] ?? '';
    if (isEmptyValue(cell)) continue;
    if (++seen > 50) break;
    const s = cell.trim();
    if (s.includes('%')) return 'percent';
    if (/[$£€]/.test(s)) return 'currency';
    if (parseNumber(s) != null) return 'number';
    if (parseDuration(s) != null) return 'duration';
    return 'string';
  }
  return seen === 0 ? 'empty' : 'string';
}

// ---- Reading values --------------------------------------------------------

function cellsOf(ctx: Ctx, rows: string[][], name: string): string[] {
  const idx = columnIndex(ctx, name);
  return rows.map((r) => r[idx] ?? '');
}

// Present values only. This is rule 1: a missing cell contributes nothing, it
// does not contribute a zero.
function valuesOf(ctx: Ctx, rows: string[][], name: string): number[] {
  const idx = columnIndex(ctx, name);
  const type = resolveType(ctx, name, idx);
  const out: number[] = [];
  for (const row of rows) {
    const cell = row[idx] ?? '';
    if (isEmptyValue(cell)) continue;
    const n = coerce(cell, type);
    if (n != null && Number.isFinite(n)) out.push(n);
  }
  return out;
}

// ---- Predicates ------------------------------------------------------------

function matchesPredicate(ctx: Ctx, row: string[], p: Predicate): boolean {
  if ('all' in p) return p.all.every((sub) => matchesPredicate(ctx, row, sub));
  if ('any' in p) return p.any.some((sub) => matchesPredicate(ctx, row, sub));

  const idx = columnIndex(ctx, p.column);
  const cell = row[idx] ?? '';
  const empty = isEmptyValue(cell);

  switch (p.op) {
    case 'nonEmpty':
      return !empty;
    case 'isEmpty':
      return empty;
    case 'eq':
    case 'neq':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      // Missing data cannot satisfy a comparison in either direction —
      // asserting "not equal" about a blank cell is as much a claim as
      // asserting "equal".
      if (empty) return false;

      const left = coerce(cell, resolveType(ctx, p.column, idx));
      const right = typeof p.value === 'number' ? p.value : parseNumber(p.value);
      if (left != null && right != null) {
        switch (p.op) {
          case 'eq':
            return left === right;
          case 'neq':
            return left !== right;
          case 'gt':
            return left > right;
          case 'gte':
            return left >= right;
          case 'lt':
            return left < right;
          case 'lte':
            return left <= right;
        }
      }
      // Text: equality is meaningful, ordering is not.
      if (p.op === 'eq') return norm(cell) === norm(String(p.value));
      if (p.op === 'neq') return norm(cell) !== norm(String(p.value));
      return false;
    }
  }
}

// ---- Aggregations ----------------------------------------------------------

type AggResult = { value: number | null; note?: string };

function describe(agg: Aggregation): string {
  switch (agg.op) {
    case 'sum':
    case 'mean':
    case 'median':
    case 'min':
    case 'max':
      return `${agg.op} of "${agg.column}"`;
    case 'count':
      return 'row count';
    case 'countWhere':
      return 'filtered row count';
    case 'distinctCount':
      return `distinct values of "${agg.column}"`;
    case 'ratio':
      return `${describe(agg.numerator)} ÷ ${describe(agg.denominator)}`;
    case 'shareOfTotal':
      return `top ${agg.topN} share of "${agg.column}"`;
    case 'passthrough':
      return `"${agg.column}"`;
  }
}

function aggColumn(agg: Aggregation): string | null {
  switch (agg.op) {
    case 'sum':
    case 'mean':
    case 'median':
    case 'min':
    case 'max':
    case 'passthrough':
      return agg.column;
    default:
      return null;
  }
}

function producesDuration(ctx: Ctx, agg: Aggregation): boolean {
  const col = aggColumn(agg);
  if (!col) return false;
  return resolveType(ctx, col, columnIndex(ctx, col)) === 'duration';
}

function evalAgg(ctx: Ctx, rows: string[][], agg: Aggregation): AggResult {
  switch (agg.op) {
    case 'sum': {
      const v = valuesOf(ctx, rows, agg.column);
      if (v.length === 0) return { value: null, note: `No usable values in "${agg.column}".` };
      return { value: v.reduce((a, b) => a + b, 0) };
    }
    case 'mean': {
      const v = valuesOf(ctx, rows, agg.column);
      if (v.length === 0) return { value: null, note: `No usable values in "${agg.column}".` };
      const mean = v.reduce((a, b) => a + b, 0) / v.length;
      const missing = rows.length - v.length;
      return {
        value: mean,
        note: missing > 0 ? `Mean over ${v.length} of ${rows.length} rows; ${missing} had no value.` : undefined,
      };
    }
    case 'median': {
      const v = valuesOf(ctx, rows, agg.column).sort((a, b) => a - b);
      if (v.length === 0) return { value: null, note: `No usable values in "${agg.column}".` };
      const mid = Math.floor(v.length / 2);
      const median = v.length % 2 === 0 ? (v[mid - 1]! + v[mid]!) / 2 : v[mid]!;
      return { value: median };
    }
    case 'min':
    case 'max': {
      const v = valuesOf(ctx, rows, agg.column);
      if (v.length === 0) return { value: null, note: `No usable values in "${agg.column}".` };
      return { value: agg.op === 'min' ? Math.min(...v) : Math.max(...v) };
    }
    case 'count':
      return { value: rows.length };
    case 'countWhere':
      return { value: rows.filter((r) => matchesPredicate(ctx, r, agg.predicate)).length };
    case 'distinctCount': {
      const seen = new Set<string>();
      for (const cell of cellsOf(ctx, rows, agg.column)) {
        if (!isEmptyValue(cell)) seen.add(norm(cell));
      }
      return { value: seen.size };
    }
    case 'shareOfTotal':
      return evalShareOfTotal(ctx, rows, agg.column, agg.topN);
    case 'ratio':
      return evalRatio(ctx, rows, agg);
    case 'passthrough': {
      const v = valuesOf(ctx, rows, agg.column);
      if (v.length === 0) return { value: null, note: `"${agg.column}" has no value here.` };
      return { value: v[0]! };
    }
  }
}

// Fan concentration: what share of the money came from the biggest N spenders.
function evalShareOfTotal(ctx: Ctx, rows: string[][], column: string, topN: number): AggResult {
  if (!Number.isInteger(topN) || topN < 1) {
    return { value: null, note: `topN must be a positive whole number, got ${topN}.` };
  }
  const v = valuesOf(ctx, rows, column);
  if (v.length === 0) return { value: null, note: `No usable values in "${column}".` };
  const total = v.reduce((a, b) => a + b, 0);
  if (total === 0) {
    return { value: null, note: `"${column}" totals 0, so a share of it is undefined.` };
  }
  const top = [...v].sort((a, b) => b - a).slice(0, topN);
  const note =
    v.length <= topN
      ? `Only ${v.length} value${v.length === 1 ? '' : 's'} present, so this is the whole column.`
      : undefined;
  return { value: (top.reduce((a, b) => a + b, 0) / total) * 100, note };
}

function evalRatio(
  ctx: Ctx,
  rows: string[][],
  agg: Extract<Aggregation, { op: 'ratio' }>,
): AggResult {
  const num = evalAgg(ctx, rows, agg.numerator);
  const den = evalAgg(ctx, rows, agg.denominator);

  // Durations are stored as seconds by coerce.ts. Per-hour metrics divide by
  // hours: 101 PPVs / 47h18min is 2.14, not 0.0006.
  let denValue = den.value;
  if (denValue != null && producesDuration(ctx, agg.denominator)) {
    denValue = durationToHours(denValue);
  }

  let derived: number | null = null;
  let why = '';
  if (num.value == null) {
    why = num.note ?? `${describe(agg.numerator)} is unavailable.`;
  } else if (denValue == null) {
    why = den.note ?? `${describe(agg.denominator)} is unavailable.`;
  } else if (denValue === 0) {
    // Rule 2. Never Infinity, never NaN, never a fabricated 0.
    why = `${describe(agg.denominator)} is 0, so this rate cannot be computed.`;
  } else {
    derived = agg.as === 'percent' ? (num.value / denValue) * 100 : num.value / denValue;
  }

  // Rule 3. Only for plain rates: a provided column is a number per unit, and
  // silently reading one as a percentage would be a 100x error.
  if (agg.as === 'number') {
    const provided = providedRateColumn(ctx, agg);
    if (provided) {
      const supplied = valuesOf(ctx, rows, provided);
      if (supplied.length === 1) {
        const value = supplied[0]!;
        if (derived == null) {
          // Rule 2 outranks rule 3 when there is nothing to divide by. Dimple's
          // "Sales per hour" reads $0.00 next to 0min clocked and $1,928 sold —
          // printing that as her rate would repeat the tracking gap as a fact.
          // Surface the column's reading in the note; do not report it.
          return {
            value: null,
            note: `${why} The "${provided}" column reads ${trim(value)}, but with no hours to check it against it is not reported as a rate.`,
          };
        }
        if (relativeGap(value, derived) > 0.01) {
          return {
            value,
            note:
              `Provided "${provided}" reads ${trim(value)}; ${describe(agg.numerator)} ÷ ` +
              `${describe(agg.denominator)} derives ${trim(derived)}. ` +
              `Using the provided column — the source computes it on a basis this data does not show.`,
          };
        }
        return { value };
      }
      if (supplied.length > 1 && derived != null) {
        return {
          value: derived,
          note: `"${provided}" is a per-row rate and this covers ${supplied.length} rows, so it was recomputed from the totals.`,
        };
      }
    }
  }

  if (derived == null) return { value: null, note: why };
  return { value: derived };
}

// "Sales" ÷ "Clocked hours" -> is there a "Sales per hour" column already?
function providedRateColumn(
  ctx: Ctx,
  agg: Extract<Aggregation, { op: 'ratio' }>,
): string | null {
  const numCol = aggColumn(agg.numerator);
  const denCol = aggColumn(agg.denominator);
  if (!numCol || !denCol) return null;

  const last = denCol.trim().split(/\s+/).pop() ?? '';
  const unit = last.length > 3 && last.endsWith('s') ? last.slice(0, -1) : last;
  const candidates = [`${numCol} per ${unit}`, `${numCol}/${unit}`, `${numCol} per ${denCol}`];

  const byName = new Map(ctx.table.headers.map((h) => [norm(h), h]));
  for (const c of candidates) {
    const hit = byName.get(norm(c));
    if (hit) return hit;
  }
  return null;
}

function relativeGap(a: number, b: number): number {
  const base = Math.max(Math.abs(a), Math.abs(b));
  return base === 0 ? 0 : Math.abs(a - b) / base;
}

function trim(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

// ---- Metrics ---------------------------------------------------------------

function toValue(raw: number | null, note: string | undefined, metric: Metric): ComputedValue {
  // Belt and braces: nothing non-finite reaches a report.
  if (raw != null && !Number.isFinite(raw)) {
    return { raw: null, formatted: '—', note: note ?? `${metric.label} did not resolve to a finite number.` };
  }
  const value: ComputedValue = { raw, formatted: formatValue(raw, metric.format), note };
  if (metric.target && raw != null) {
    value.meetsTarget =
      metric.target.comparator === '>=' ? raw >= metric.target.value : raw <= metric.target.value;
  }
  return value;
}

function computeMetric(ctx: Ctx, rows: string[][], metric: Metric): ComputedValue {
  try {
    if (metric.agg.op === 'passthrough') return passthrough(ctx, rows, metric, metric.agg.column);
    const { value, note } = evalAgg(ctx, rows, metric.agg);
    return toValue(value, note, metric);
  } catch (err) {
    return { raw: null, formatted: '—', note: errorText(err) };
  }
}

// Verbatim read of a source column — text columns keep their own spelling
// rather than being pushed through a numeric formatter.
function passthrough(ctx: Ctx, rows: string[][], metric: Metric, column: string): ComputedValue {
  const idx = columnIndex(ctx, column);
  const present = rows.map((r) => (r[idx] ?? '').trim()).filter((c) => !isEmptyValue(c));
  if (present.length === 0) {
    return { raw: null, formatted: '—', note: `"${column}" has no value here.` };
  }
  const distinct = new Set(present);
  const cell = present[0]!;
  const note =
    distinct.size > 1
      ? `"${column}" holds ${distinct.size} different values across ${rows.length} rows; showing the first.`
      : undefined;

  const raw = coerce(cell, resolveType(ctx, column, idx));
  if (raw == null || metric.format === 'text') {
    return { raw: raw != null && Number.isFinite(raw) ? raw : null, formatted: cell, note };
  }
  return toValue(raw, note, metric);
}

// ---- Grouping and ordering -------------------------------------------------

function groupRows(ctx: Ctx, rows: string[][], column: string): Array<{ group: string; rows: string[][] }> {
  const idx = columnIndex(ctx, column);
  const groups = new Map<string, string[][]>();
  for (const row of rows) {
    const cell = (row[idx] ?? '').trim();
    const key = isEmptyValue(cell) ? '—' : cell;
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }
  return [...groups].map(([group, groupedRows]) => ({ group, rows: groupedRows }));
}

// Nulls always sink to the bottom: "no data" is not the worst score, it is the
// absence of one, and it must not read as last place either way.
function sortComputed(rows: ComputedRow[], key: string | undefined, dir: 'asc' | 'desc' = 'desc'): ComputedRow[] {
  if (!key) return rows;
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a.values[key]?.raw ?? null;
    const bv = b.values[key]?.raw ?? null;
    if (av == null && bv == null) return a.group.localeCompare(b.group);
    if (av == null) return 1;
    if (bv == null) return -1;
    if (av === bv) return a.group.localeCompare(b.group);
    return (av - bv) * sign;
  });
}

// ---- Sections --------------------------------------------------------------

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function contextFor(tables: RawTable[], tableId: string, columnTypes: ColumnTypeMap): Ctx {
  const table = tables.find((t) => t.id === tableId);
  if (!table) {
    throw new Error(
      `Section refers to table "${tableId}", which is not in this upload. Available: ${
        tables.map((t) => t.id).join(', ') || 'none'
      }`,
    );
  }
  return { table, declared: columnTypes[table.id], resolved: new Map() };
}

function applyFilter(ctx: Ctx, rows: string[][], filter: Predicate | undefined): string[][] {
  return filter ? rows.filter((r) => matchesPredicate(ctx, r, filter)) : rows;
}

function metricRows(ctx: Ctx, rows: string[][], groupBy: string, metrics: Metric[]): ComputedRow[] {
  return groupRows(ctx, rows, groupBy).map(({ group, rows: groupedRows }) => {
    const values: Record<string, ComputedValue> = {};
    for (const metric of metrics) values[metric.key] = computeMetric(ctx, groupedRows, metric);
    return { group, values };
  });
}

function executeSection(tables: RawTable[], section: Section, columnTypes: ColumnTypeMap): ComputedSection {
  const base: ComputedSection = {
    id: section.id,
    kind: section.kind,
    title: section.title,
    spec: section,
  };

  // Rule 4: one bad section is a message inside the report, not a failed report.
  try {
    switch (section.kind) {
      case 'narrative':
      case 'callout':
        return base;

      case 'statCards': {
        const ctx = contextFor(tables, section.tableId, columnTypes);
        const rows = applyFilter(ctx, ctx.table.rows, section.filter);
        const values: Record<string, ComputedValue> = {};
        for (const metric of section.metrics) values[metric.key] = computeMetric(ctx, rows, metric);
        return { ...base, values, columns: section.metrics.map((m) => m.key) };
      }

      case 'scorecard': {
        const ctx = contextFor(tables, section.tableId, columnTypes);
        const rows = applyFilter(ctx, ctx.table.rows, section.filter);
        const computed = metricRows(ctx, rows, section.groupBy, section.metrics);
        return {
          ...base,
          rows: sortComputed(computed, section.sortBy, section.sortDir ?? 'desc'),
          columns: section.metrics.map((m) => m.key),
        };
      }

      case 'ranking': {
        const ctx = contextFor(tables, section.tableId, columnTypes);
        const computed = metricRows(ctx, ctx.table.rows, section.groupBy, [section.metric]);
        const ranked = sortComputed(computed, section.metric.key, 'desc');
        return {
          ...base,
          rows: section.limit > 0 ? ranked.slice(0, section.limit) : ranked,
          columns: [section.metric.key],
        };
      }

      case 'trend': {
        const ctx = contextFor(tables, section.tableId, columnTypes);
        // Buckets keep source order — the file's own sequence is the period
        // order, and re-sorting text dates invents a chronology.
        const computed = metricRows(ctx, ctx.table.rows, section.bucketBy, section.metrics);
        return { ...base, rows: computed, columns: section.metrics.map((m) => m.key) };
      }

      case 'table': {
        const ctx = contextFor(tables, section.tableId, columnTypes);
        const rows = applyFilter(ctx, ctx.table.rows, section.filter);
        const first = section.columns[0];
        if (!first) throw new Error('Table section lists no columns.');
        const indexes: Array<{ name: string; idx: number }> = [];
        const missing: string[] = [];
        for (const name of section.columns) {
          try {
            indexes.push({ name, idx: columnIndex(ctx, name) });
          } catch {
            missing.push(name);
          }
        }
        if (missing.length > 0) {
          throw new Error(
            `Column${missing.length > 1 ? 's' : ''} ${missing.map((m) => `"${m}"`).join(', ')} not in ${ctx.table.sourceFile}.`,
          );
        }
        let computed: ComputedRow[] = rows.map((row) => {
          const values: Record<string, ComputedValue> = {};
          for (const { name, idx } of indexes) {
            const cell = (row[idx] ?? '').trim();
            const empty = isEmptyValue(cell);
            values[name] = {
              raw: empty ? null : coerce(cell, resolveType(ctx, name, idx)),
              formatted: empty ? '—' : cell,
            };
          }
          return { group: values[first]?.formatted ?? '', values };
        });
        computed = sortComputed(computed, section.sortBy, section.sortDir ?? 'desc');
        if (section.limit && section.limit > 0) computed = computed.slice(0, section.limit);
        return { ...base, rows: computed, columns: section.columns };
      }
    }
  } catch (err) {
    return { ...base, error: errorText(err) };
  }
}

// ---- Entry point -----------------------------------------------------------

export function executeSpec(
  tables: RawTable[],
  spec: ReportSpec,
  columnTypes: ColumnTypeMap,
): ComputedReport {
  const sections = spec.sections.map((section) => executeSection(tables, section, columnTypes));

  const used = new Set<string>();
  for (const section of spec.sections) {
    if ('tableId' in section) used.add(section.tableId);
  }
  const consumed = tables.filter((t) => used.has(t.id));

  return {
    spec,
    sections,
    computedAt: new Date().toISOString(),
    sourceFiles: [...new Set(consumed.map((t) => t.sourceFile))],
    rowsConsumed: consumed.reduce((total, t) => total + t.rows.length, 0),
  };
}
