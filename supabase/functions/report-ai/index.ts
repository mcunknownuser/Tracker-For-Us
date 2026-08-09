// =============================================================================
//  report-ai — the only place an Anthropic API key is allowed to exist.
//
//  This app ships as a Tauri desktop binary to users' machines. Everything Vite
//  bundles (VITE_* env vars included) is readable in plain text inside the
//  .app/.exe, so an Anthropic key in the client is a billing credential handed
//  to every user — the same reasoning src/lib/supabase.ts applies to the
//  service-role key. The key lives as a Supabase secret, the app calls this
//  function, this function calls Anthropic.
//
//  Two operations behind one function, switched on `mode`:
//    plan  : UploadProfile  -> ReportSpec    AI says WHAT to compute, never a number
//    write : ComputedReport -> ReportProse   AI writes prose over engine.ts's numbers
//
//  Two rules this file enforces in code, not just in comments:
//
//    1. Only the profile (plan) or computed aggregates (write) leave this
//       function. Payloads are rebuilt field-by-field from a whitelist and then
//       walked by assertNoRawRows() before the fetch. The source rows are fan
//       payment records for a real business; they never go to a third party.
//
//    2. Model output is validated against the ReportSpec grammar — every
//       section kind, every Aggregation.op, every tableId and column name
//       checked against the profile — before it is returned. A malformed spec
//       is a clear error here, not a broken report three stages downstream.
// =============================================================================
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

// ---- Anthropic request shape ----------------------------------------------
// Current as of this writing, and deliberately minimal:
//   - claude-opus-5 rejects temperature / top_p / top_k with HTTP 400.
//   - It also rejects thinking:{type:'enabled',budget_tokens:N}. Thinking is on
//     by default, so the parameter is omitted entirely.
//   - Structured output is output_config.format; the old top-level
//     output_format parameter is deprecated.
// A report is a few cents at ~$5/$25 per million tokens, so there is no caching
// or batching machinery here — it would be complexity bought for nothing.
const MODEL = 'claude-opus-5';
const MAX_TOKENS = 16000;

// ~75k tokens of profile/aggregates. Past this we refuse with an explanation
// rather than silently truncating someone's upload.
const MAX_PAYLOAD_CHARS = 300_000;

// One initial plan plus at most one repair attempt with the validation errors
// fed back. Not a loop: a model that fails the same check twice fails it thrice,
// and each attempt is billed and waited on.
const MAX_PLAN_ATTEMPTS = 2;
const MAX_REPAIR_ERRORS = 40;

// Prose quality does not improve past this many groups, and the payload does.
const MAX_GROUPS_PER_SECTION = 60;
const MAX_LABEL_CHARS = 120;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// =============================================================================
//  Errors
// =============================================================================

// Carries the status and the "what to do about it" detail all the way out.
export class HttpError extends Error {
  status: number;
  details: string[];
  constructor(status: number, message: string, details?: string[]) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details ?? [];
  }
}

// =============================================================================
//  Outbound payload sanitising — rule 1
// =============================================================================

// A source row is a string[]; a table of them is a string[][]. Any array of
// arrays reaching the outbound payload means a RawTable leaked in, so the walk
// below refuses it outright, along with the field names RawTable uses.
const FORBIDDEN_KEYS = new Set(['headers', 'rows', 'rawRows', 'sourceRows', 'cells', 'data']);

export function assertNoRawRows(value: unknown, path = 'payload'): void {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (Array.isArray(value[i])) {
        throw new HttpError(
          500,
          'Refused to send data to the AI provider: the outbound payload contained raw source rows.',
          [`${path}[${i}] is an array of arrays, which is the shape of parsed spreadsheet rows.`],
        );
      }
      assertNoRawRows(value[i], `${path}[${i}]`);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(key)) {
        throw new HttpError(
          500,
          'Refused to send data to the AI provider: the outbound payload contained raw source rows.',
          [`${path}.${key} is a source-row field and must never be sent.`],
        );
      }
      assertNoRawRows(child, `${path}.${key}`);
    }
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const clip = (v: unknown, max = MAX_LABEL_CHARS): string => str(v).slice(0, max);

export type SafeColumn = {
  name: string;
  index: number;
  type: string;
  nonEmpty: number;
  distinct: number;
  samples: string[];
  min: number | null;
  max: number | null;
};

export type SafeTable = {
  id: string;
  sourceFile: string;
  sheetName: string | null;
  rowCount: number;
  columns: SafeColumn[];
};

export type SafeProfile = { tables: SafeTable[] };

// Rebuilt field by field. Anything the client sends that is not named here —
// including RawTable.rows — is structurally dropped rather than filtered out.
// The <=5 samples per column are the one place raw cell values travel, and
// they do so by design: types.ts documents them as "for the planner to read".
export function sanitizeProfile(input: unknown): SafeProfile {
  const tablesIn = (input as { tables?: unknown } | null)?.tables;
  if (!Array.isArray(tablesIn) || tablesIn.length === 0) {
    throw new HttpError(400, 'The upload profile has no tables to plan against.', [
      'Expected body.profile.tables to be a non-empty array. Re-run the parse and profile steps before planning.',
    ]);
  }
  const tables: SafeTable[] = tablesIn.map((t) => {
    const table = (t ?? {}) as Record<string, unknown>;
    const colsIn = Array.isArray(table.columns) ? table.columns : [];
    return {
      id: clip(table.id, 200),
      sourceFile: clip(table.sourceFile, 200),
      sheetName: typeof table.sheetName === 'string' ? clip(table.sheetName, 200) : null,
      rowCount: num(table.rowCount) ?? 0,
      columns: colsIn.map((c) => {
        const col = (c ?? {}) as Record<string, unknown>;
        const samples = Array.isArray(col.samples) ? col.samples : [];
        return {
          name: clip(col.name, 200),
          index: num(col.index) ?? 0,
          type: clip(col.type, 40),
          nonEmpty: num(col.nonEmpty) ?? 0,
          distinct: num(col.distinct) ?? 0,
          samples: samples.slice(0, 5).map((s) => clip(s, 80)),
          min: num(col.min),
          max: num(col.max),
        };
      }),
    };
  });
  for (const table of tables) {
    if (!table.id) {
      throw new HttpError(400, 'The upload profile contains a table with no id.', [
        'Every TableProfile needs a stable `id` — the spec references tables by it.',
      ]);
    }
    if (table.columns.length === 0) {
      throw new HttpError(400, `Table "${table.id}" has no profiled columns.`, [
        'There is nothing to plan against. Check that the parse step found a header row.',
      ]);
    }
  }
  return { tables };
}

type SafeValue = {
  key: string;
  label: string;
  formatted: string;
  raw: number | null;
  meetsTarget: boolean | null;
  note: string | null;
};

// Aggregates only. `kind: 'table'` sections hold near-verbatim source rows, so
// their rows are replaced by a count — the writing stage gets told the section
// exists and how big it is, and nothing else.
export function sanitizeComputed(input: unknown): {
  payload: Record<string, unknown>;
  sectionIds: string[];
} {
  const report = (input ?? {}) as Record<string, unknown>;
  const spec = (report.spec ?? {}) as Record<string, unknown>;
  const sectionsIn = Array.isArray(report.sections) ? report.sections : [];
  if (sectionsIn.length === 0) {
    throw new HttpError(400, 'The computed report has no sections to write about.', [
      'Expected body.computed.sections to be a non-empty array. Run the execute step first.',
    ]);
  }

  const sectionIds: string[] = [];
  const sections = sectionsIn.map((s) => {
    const section = (s ?? {}) as Record<string, unknown>;
    const sectionSpec = (section.spec ?? {}) as Record<string, unknown>;
    const kind = clip(section.kind, 40);
    const id = clip(section.id, 200);
    sectionIds.push(id);

    const metricDefs = Array.isArray(sectionSpec.metrics)
      ? sectionSpec.metrics
      : sectionSpec.metric
        ? [sectionSpec.metric]
        : [];
    const labels = new Map<string, string>();
    const metrics = metricDefs.map((m) => {
      const metric = (m ?? {}) as Record<string, unknown>;
      const key = clip(metric.key, 120);
      const label = clip(metric.label);
      labels.set(key, label);
      const target = (metric.target ?? null) as Record<string, unknown> | null;
      return {
        key,
        label,
        format: clip(metric.format, 40),
        description: typeof metric.description === 'string' ? clip(metric.description, 400) : null,
        target: target
          ? {
              comparator: clip(target.comparator, 4),
              value: num(target.value),
              source: clip(target.source, 20),
            }
          : null,
      };
    });

    const toValues = (values: unknown): SafeValue[] => {
      const map = (values ?? {}) as Record<string, unknown>;
      return Object.entries(map).map(([key, v]) => {
        const val = (v ?? {}) as Record<string, unknown>;
        return {
          key,
          label: labels.get(key) ?? key,
          formatted: clip(val.formatted, 60),
          raw: num(val.raw),
          meetsTarget: typeof val.meetsTarget === 'boolean' ? val.meetsTarget : null,
          note: typeof val.note === 'string' ? clip(val.note, 300) : null,
        };
      });
    };

    const out: Record<string, unknown> = {
      id,
      kind,
      title: clip(section.title, 300),
    };
    if (typeof section.error === 'string' && section.error) out.error = clip(section.error, 300);
    if (typeof sectionSpec.brief === 'string') out.brief = clip(sectionSpec.brief, 1000);
    if (typeof sectionSpec.body === 'string') out.body = clip(sectionSpec.body, 1000);
    if (typeof sectionSpec.tone === 'string') out.tone = clip(sectionSpec.tone, 20);
    if (typeof sectionSpec.groupBy === 'string') out.groupBy = clip(sectionSpec.groupBy, 200);
    if (metrics.length > 0) out.metrics = metrics;
    if (section.values && typeof section.values === 'object') out.totals = toValues(section.values);

    const groupsIn = Array.isArray(section.rows) ? section.rows : [];
    if (kind === 'table') {
      // Deliberately withheld: these are the source rows in disguise.
      out.rowCount = groupsIn.length;
      out.rowsWithheld = true;
    } else if (groupsIn.length > 0) {
      out.groupCount = groupsIn.length;
      out.groups = groupsIn.slice(0, MAX_GROUPS_PER_SECTION).map((r) => {
        const row = (r ?? {}) as Record<string, unknown>;
        return { group: clip(row.group), values: toValues(row.values) };
      });
    }
    return out;
  });

  const payload: Record<string, unknown> = {
    title: clip(spec.title, 300),
    subtitle: typeof spec.subtitle === 'string' ? clip(spec.subtitle, 300) : null,
    dataDescription: clip(spec.dataDescription, 2000),
    warnings: (Array.isArray(spec.warnings) ? spec.warnings : []).map((w) => clip(w, 400)),
    unmappedColumns: (Array.isArray(spec.unmappedColumns) ? spec.unmappedColumns : []).map((c) =>
      clip(c, 200),
    ),
    computedAt: clip(report.computedAt, 40),
    sourceFiles: (Array.isArray(report.sourceFiles) ? report.sourceFiles : []).map((f) =>
      clip(f, 200),
    ),
    rowsConsumed: num(report.rowsConsumed) ?? 0,
    sections,
  };
  return { payload, sectionIds };
}

// =============================================================================
//  Formula parser — the wire format for Aggregation and Predicate
//
//  Aggregation and Predicate are recursive discriminated unions, and JSON Schema
//  is bad at both. Expressed as objects they broke two separate structured-output
//  limits in succession: as anyOf unions, 86 union-typed parameters against a cap
//  of 16; flattened to permissive objects, 105 optional parameters against a cap
//  of 24. Unions and optionals are in direct tension for a type like this — one
//  limit is paid to relieve the other.
//
//  So they are not in the schema at all. The model writes a formula string, and
//  this parser lowers it to the exact Aggregation / Predicate objects that
//  types.ts already declares. A Metric on the wire is
//  { key, label, formula, format, target? } — one optional field, no nesting —
//  and everything downstream (engine.ts, store.ts, the renderer) receives the
//  same ReportSpec it always did.
//
//  The grammar, in full:
//
//    count()
//    sum("Total spend")   mean(...)   median(...)   min(...)   max(...)
//    distinctCount("Fan name")
//    shareOfTotal("Total spend", 5)
//    passthrough("Sales per hour")
//    ratio(sum("Sales"), sum("Clocked hours"))          -> as: "number"
//    ratioPercent(sum("Tips"), sum("Total spend"))      -> as: "percent"
//    countWhere("Total spend" > 100)
//
//    predicates:  "Col" > 100    "Col" == "text"    nonEmpty("Col")
//                 isEmpty("Col")   all(p, p)   any(p, p)
//    operators:   ==  !=  >  >=  <  <=
//
//  Column names are ALWAYS quoted. They are not optional quotes and this is not
//  fussiness: real headers contain both spaces and parentheses, as in
//  `Response time (based on clocked hours)`, which is unparseable bare.
// =============================================================================

const COLUMN_AGG_VERBS = new Set(['sum', 'mean', 'median', 'min', 'max']);
const SIMPLE_AGG_VERBS = new Set(['distinctCount', 'passthrough']);
const AGG_VERBS = [
  'count',
  'sum',
  'mean',
  'median',
  'min',
  'max',
  'distinctCount',
  'shareOfTotal',
  'passthrough',
  'ratio',
  'ratioPercent',
  'countWhere',
];
const PRED_VERBS = ['nonEmpty', 'isEmpty', 'all', 'any'];
const COMPARISONS: Array<[string, string]> = [
  ['==', 'eq'],
  ['!=', 'neq'],
  ['>=', 'gte'],
  ['<=', 'lte'],
  ['>', 'gt'],
  ['<', 'lt'],
];
const MAX_FORMULA_DEPTH = 4;

type Cursor = { src: string; i: number };

// Thrown by the parser, caught by the validator, which prefixes the field path.
// The message always names a position so the planner can be told exactly where
// it went wrong.
export class FormulaError extends Error {
  position: number;
  constructor(message: string, position: number) {
    super(message);
    this.name = 'FormulaError';
    this.position = position;
  }
}

function fail(c: Cursor, expected: string): never {
  const rest = c.src.slice(c.i, c.i + 16);
  const where = rest ? `near ${JSON.stringify(rest)}` : 'at the end of the formula';
  throw new FormulaError(`${expected} at position ${c.i}, ${where}`, c.i);
}

function skipSpace(c: Cursor): void {
  while (c.i < c.src.length && /\s/.test(c.src[c.i])) c.i++;
}

function peek(c: Cursor): string {
  skipSpace(c);
  return c.src[c.i] ?? '';
}

function expect(c: Cursor, ch: string): void {
  skipSpace(c);
  if (c.src[c.i] !== ch) fail(c, `expected ${JSON.stringify(ch)}`);
  c.i++;
}

function readVerb(c: Cursor): string {
  skipSpace(c);
  const start = c.i;
  while (c.i < c.src.length && /[A-Za-z]/.test(c.src[c.i])) c.i++;
  if (c.i === start) fail(c, 'expected a function name');
  return c.src.slice(start, c.i);
}

// Always quoted — real column names contain spaces and parentheses.
function readColumn(c: Cursor): string {
  skipSpace(c);
  if (c.src[c.i] !== '"') {
    fail(c, 'expected a quoted column name such as "Total spend"');
  }
  const open = c.i;
  c.i++;
  let out = '';
  while (c.i < c.src.length) {
    const ch = c.src[c.i];
    if (ch === '\\' && c.src[c.i + 1] === '"') {
      out += '"';
      c.i += 2;
      continue;
    }
    if (ch === '"') {
      c.i++;
      if (out === '') throw new FormulaError(`empty column name at position ${open}`, open);
      return out;
    }
    out += ch;
    c.i++;
  }
  c.i = open;
  fail(c, 'unterminated column name — expected a closing double quote');
}

function readNumber(c: Cursor): number {
  skipSpace(c);
  const start = c.i;
  if (c.src[c.i] === '-') c.i++;
  while (c.i < c.src.length && /[0-9.]/.test(c.src[c.i])) c.i++;
  const raw = c.src.slice(start, c.i);
  const n = Number(raw);
  if (raw === '' || raw === '-' || !Number.isFinite(n)) {
    c.i = start;
    fail(c, 'expected a number');
  }
  return n;
}

function parseAggregation(c: Cursor, depth: number): Record<string, unknown> {
  if (depth > MAX_FORMULA_DEPTH) {
    fail(c, `formula nested more than ${MAX_FORMULA_DEPTH} levels deep`);
  }
  skipSpace(c);
  const verbAt = c.i;
  const verb = readVerb(c);
  if (!AGG_VERBS.includes(verb)) {
    throw new FormulaError(
      `unknown function ${JSON.stringify(verb)} at position ${verbAt} — expected one of ${AGG_VERBS.join(', ')}`,
      verbAt,
    );
  }
  expect(c, '(');

  if (verb === 'count') {
    expect(c, ')');
    return { op: 'count' };
  }
  if (COLUMN_AGG_VERBS.has(verb) || SIMPLE_AGG_VERBS.has(verb)) {
    const column = readColumn(c);
    expect(c, ')');
    return { op: verb, column };
  }
  if (verb === 'shareOfTotal') {
    const column = readColumn(c);
    expect(c, ',');
    const topN = readNumber(c);
    expect(c, ')');
    if (!Number.isInteger(topN) || topN < 1) {
      fail(c, `shareOfTotal needs a whole number of rows, got ${topN}`);
    }
    return { op: 'shareOfTotal', column, topN };
  }
  if (verb === 'countWhere') {
    const predicate = parsePredicate(c, depth + 1);
    expect(c, ')');
    return { op: 'countWhere', predicate };
  }
  // ratio / ratioPercent — two separate verbs so `as` need not be a field.
  const numerator = parseAggregation(c, depth + 1);
  expect(c, ',');
  const denominator = parseAggregation(c, depth + 1);
  expect(c, ')');
  return {
    op: 'ratio',
    numerator,
    denominator,
    as: verb === 'ratioPercent' ? 'percent' : 'number',
  };
}

function parsePredicate(c: Cursor, depth: number): Record<string, unknown> {
  if (depth > MAX_FORMULA_DEPTH) {
    fail(c, `predicate nested more than ${MAX_FORMULA_DEPTH} levels deep`);
  }
  if (peek(c) === '"') {
    const column = readColumn(c);
    skipSpace(c);
    let op = '';
    for (const [symbol, name] of COMPARISONS) {
      if (c.src.startsWith(symbol, c.i)) {
        op = name;
        c.i += symbol.length;
        break;
      }
    }
    if (!op) fail(c, 'expected a comparison operator (==, !=, >, >=, <, <=)');
    skipSpace(c);
    const value = c.src[c.i] === '"' ? readColumn(c) : readNumber(c);
    return { column, op, value };
  }

  const verbAt = c.i;
  const verb = readVerb(c);
  if (!PRED_VERBS.includes(verb)) {
    throw new FormulaError(
      `unknown condition ${JSON.stringify(verb)} at position ${verbAt} — expected a quoted column name or one of ${PRED_VERBS.join(', ')}`,
      verbAt,
    );
  }
  expect(c, '(');
  if (verb === 'nonEmpty' || verb === 'isEmpty') {
    const column = readColumn(c);
    expect(c, ')');
    return { column, op: verb };
  }
  const list = [parsePredicate(c, depth + 1)];
  while (peek(c) === ',') {
    c.i++;
    list.push(parsePredicate(c, depth + 1));
  }
  expect(c, ')');
  if (list.length < 2) {
    throw new FormulaError(
      `${verb}() needs at least two conditions separated by commas, got ${list.length}`,
      verbAt,
    );
  }
  return verb === 'all' ? { all: list } : { any: list };
}

function parseComplete(
  src: unknown,
  what: string,
  parse: (c: Cursor) => Record<string, unknown>,
): Record<string, unknown> {
  if (typeof src !== 'string' || src.trim() === '') {
    throw new FormulaError(`expected a ${what} string, got ${describe(src)}`, 0);
  }
  const c: Cursor = { src, i: 0 };
  const result = parse(c);
  skipSpace(c);
  if (c.i < c.src.length) fail(c, 'unexpected text after the end of the formula');
  return result;
}

// "ratio(sum("Sales"), sum("Clocked hours"))" -> the Aggregation object.
export function parseFormula(src: unknown): Record<string, unknown> {
  return parseComplete(src, 'formula', (c) => parseAggregation(c, 0));
}

// `"Total spend" > 100` -> the Predicate object.
export function parseCondition(src: unknown): Record<string, unknown> {
  return parseComplete(src, 'condition', (c) => parsePredicate(c, 0));
}

// =============================================================================
//  Validation — rule 2
//
//  Hand-written against the ReportSpec type in src/lib/reports/types.ts. It is
//  deliberately a whole-spec check that collects every problem rather than
//  failing on the first: a re-plan costs a few cents, so telling the caller all
//  six things that are wrong beats six round trips.
// =============================================================================

const SECTION_KINDS = new Set([
  'statCards',
  'scorecard',
  'table',
  'ranking',
  'trend',
  'narrative',
  'callout',
]);
const AGG_OPS = new Set([
  'sum',
  'mean',
  'median',
  'min',
  'max',
  'count',
  'countWhere',
  'distinctCount',
  'ratio',
  'shareOfTotal',
  'passthrough',
]);
const NUMERIC_AGG_OPS = new Set(['sum', 'mean', 'median', 'min', 'max']);
const METRIC_FORMATS = new Set([
  'currency',
  'percent',
  'number',
  'integer',
  'duration',
  'text',
]);
const CMP_OPS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte']);
const PRESENCE_OPS = new Set(['nonEmpty', 'isEmpty']);

// Which fields each op and each section kind is allowed to carry. The wire
// schema used to encode this as a discriminated union, which made a mismatch
// unrepresentable — but it also blew past the API's 16-union-parameter limit
// (see the schema section below). The pairing is checked here instead.
const AGG_FIELDS: Record<string, string[]> = {
  sum: ['column'],
  mean: ['column'],
  median: ['column'],
  min: ['column'],
  max: ['column'],
  count: [],
  countWhere: ['predicate'],
  distinctCount: ['column'],
  ratio: ['numerator', 'denominator', 'as'],
  shareOfTotal: ['column', 'topN'],
  passthrough: ['column'],
};
const SECTION_COMMON_FIELDS = ['id', 'kind', 'title'];
const SECTION_FIELDS: Record<string, string[]> = {
  statCards: ['tableId', 'metrics', 'filter'],
  scorecard: ['tableId', 'groupBy', 'metrics', 'sortBy', 'filter'],
  table: ['tableId', 'columns', 'sortBy', 'filter'],
  // Singular: a ranking ranks by exactly one metric, and since maxItems is not
  // a supported keyword, a one-element array could not be enforced by the schema.
  ranking: ['tableId', 'groupBy', 'metric'],
  trend: ['tableId', 'bucketBy', 'metrics'],
  narrative: ['brief'],
  callout: ['tone', 'body'],
};

// Kept out of the wire schema and applied in code instead. Every optional
// property counts against a hard cap of 24 across the whole schema (see the
// schema section), and these are all things code can decide as well as a model.
const DEFAULT_SORT_DIR = 'desc';
const DEFAULT_RANKING_LIMIT = 10;
const DEFAULT_TABLE_LIMIT = 25;
const PRED_CMP_FIELDS = ['column', 'op', 'value'];
const PRED_PRESENCE_FIELDS = ['column', 'op'];
// Types coerce.ts can turn into a number. Everything else is text.
const NUMERIC_TYPES = new Set(['number', 'currency', 'percent', 'duration']);
const ORDERABLE_TYPES = new Set(['number', 'currency', 'percent', 'duration', 'date']);

type Bag = { errors: string[] };
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
// Optional fields: the model's JSON schema emits explicit null rather than
// omitting a key, so both spellings mean "absent".
const absent = (v: unknown): boolean => v === undefined || v === null;

function describe(v: unknown): string {
  if (v === undefined) return 'nothing';
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  if (typeof v === 'number') return `the number ${v}`;
  if (typeof v === 'string') return `the string ${JSON.stringify(v.slice(0, 40))}`;
  return `a ${typeof v}`;
}

// Rejects a field that this op or kind has no meaning for. A present-but-null
// field is just absence and passes.
function checkFields(
  bag: Bag,
  path: string,
  value: Record<string, unknown>,
  allowed: string[],
  what: string,
): void {
  for (const key of Object.keys(value)) {
    if (allowed.includes(key) || absent(value[key])) continue;
    bag.errors.push(`${path}.${key}: ${what} does not take a "${key}".`);
  }
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

type TableIndex = Map<string, Map<string, string>>;

function indexProfile(profile: SafeProfile): {
  byTable: TableIndex;
  allColumns: Set<string>;
} {
  const byTable: TableIndex = new Map();
  const allColumns = new Set<string>();
  for (const table of profile.tables) {
    const cols = new Map<string, string>();
    for (const col of table.columns) {
      cols.set(col.name, col.type);
      allColumns.add(col.name);
    }
    byTable.set(table.id, cols);
  }
  return { byTable, allColumns };
}

function checkColumn(
  bag: Bag,
  path: string,
  value: unknown,
  cols: Map<string, string> | null,
  tableId: string,
): string | null {
  if (!isStr(value)) {
    bag.errors.push(`${path}: expected a column name, got ${describe(value)}.`);
    return null;
  }
  if (cols && !cols.has(value)) {
    bag.errors.push(
      `${path}: column ${JSON.stringify(value)} does not exist in table "${tableId}".`,
    );
    return null;
  }
  return value;
}

function checkPredicate(
  bag: Bag,
  path: string,
  value: unknown,
  cols: Map<string, string> | null,
  tableId: string,
  depth = 0,
): void {
  if (depth > 4) {
    bag.errors.push(`${path}: predicate nested too deeply (max 4 levels).`);
    return;
  }
  if (!isObj(value)) {
    bag.errors.push(`${path}: expected a predicate object, got ${describe(value)}.`);
    return;
  }
  const hasAll = !absent(value.all);
  const hasAny = !absent(value.any);
  if (hasAll || hasAny) {
    if (hasAll && hasAny) {
      bag.errors.push(`${path}: a predicate takes either "all" or "any", never both.`);
      return;
    }
    const key = hasAll ? 'all' : 'any';
    checkFields(bag, path, value, [key], `an "${key}" predicate`);
    const list = value[key];
    if (!Array.isArray(list) || list.length === 0) {
      bag.errors.push(`${path}.${key}: expected a non-empty array of predicates.`);
      return;
    }
    list.forEach((child, i) =>
      checkPredicate(bag, `${path}.${key}[${i}]`, child, cols, tableId, depth + 1),
    );
    return;
  }
  const op = value.op;
  if (!isStr(op) || (!CMP_OPS.has(op) && !PRESENCE_OPS.has(op))) {
    bag.errors.push(
      `${path}.op: expected one of ${[...CMP_OPS, ...PRESENCE_OPS].join(', ')}, got ${describe(op)}.`,
    );
    return;
  }
  const isCmp = CMP_OPS.has(op);
  checkFields(
    bag,
    path,
    value,
    isCmp ? PRED_CMP_FIELDS : PRED_PRESENCE_FIELDS,
    `predicate op "${op}"`,
  );
  const column = checkColumn(bag, `${path}.column`, value.column, cols, tableId);
  if (!isCmp) return;

  const v = value.value;
  if (typeof v === 'number') return;
  if (typeof v !== 'string') {
    bag.errors.push(`${path}.value: expected a string or number, got ${describe(v)}.`);
    return;
  }
  // The parser already yields a number for a bare numeric literal, so this only
  // catches a quoted one — `"Total spend" > "100"`. Convert against the column's
  // profiled type, the same way coerce.ts reads the data side, so the engine
  // compares a number with a number rather than silently never matching.
  const type = column && cols ? cols.get(column) : undefined;
  if (type && NUMERIC_TYPES.has(type)) {
    const cleaned = v.trim().replace(/[$£€,%\s]/g, '');
    const n = Number(cleaned);
    if (cleaned !== '' && Number.isFinite(n)) {
      value.value = n;
    } else {
      bag.errors.push(
        `${path}.value: column ${JSON.stringify(column)} is numeric, so the comparison value must be a number; got ${describe(v)}.`,
      );
    }
  }
}

function checkAggregation(
  bag: Bag,
  path: string,
  value: unknown,
  cols: Map<string, string> | null,
  tableId: string,
  depth = 0,
): void {
  if (depth > 3) {
    bag.errors.push(`${path}: aggregation nested too deeply (max 3 levels).`);
    return;
  }
  if (!isObj(value)) {
    // The failure this whole pipeline is built to prevent: the model computing
    // the answer instead of describing the calculation.
    const extra =
      typeof value === 'number'
        ? ' The planner must describe the calculation, not perform it.'
        : '';
    bag.errors.push(
      `${path}: expected an aggregation object such as {"op":"sum","column":"..."}, got ${describe(value)}.${extra}`,
    );
    return;
  }
  const op = value.op;
  if (!isStr(op) || !AGG_OPS.has(op)) {
    bag.errors.push(
      `${path}.op: expected one of ${[...AGG_OPS].join(', ')}, got ${describe(op)}.`,
    );
    return;
  }
  checkFields(bag, path, value, ['op', ...(AGG_FIELDS[op] ?? [])], `aggregation op "${op}"`);
  if (NUMERIC_AGG_OPS.has(op)) {
    const name = checkColumn(bag, `${path}.column`, value.column, cols, tableId);
    if (name && cols) {
      const type = cols.get(name) ?? '';
      const allowed = op === 'min' || op === 'max' ? ORDERABLE_TYPES : NUMERIC_TYPES;
      if (!allowed.has(type)) {
        bag.errors.push(
          `${path}: cannot ${op} column ${JSON.stringify(name)} — the profile types it as "${type}", not a number.`,
        );
      }
    }
    return;
  }
  if (op === 'count') return;
  if (op === 'countWhere') {
    checkPredicate(bag, `${path}.predicate`, value.predicate, cols, tableId, depth + 1);
    return;
  }
  if (op === 'distinctCount' || op === 'passthrough') {
    checkColumn(bag, `${path}.column`, value.column, cols, tableId);
    return;
  }
  if (op === 'shareOfTotal') {
    const name = checkColumn(bag, `${path}.column`, value.column, cols, tableId);
    if (name && cols && !NUMERIC_TYPES.has(cols.get(name) ?? '')) {
      bag.errors.push(
        `${path}: shareOfTotal needs a numeric column; ${JSON.stringify(name)} is typed "${cols.get(name)}".`,
      );
    }
    if (!isInt(value.topN) || (value.topN as number) < 1) {
      bag.errors.push(`${path}.topN: expected a positive integer, got ${describe(value.topN)}.`);
    }
    return;
  }
  // ratio
  checkAggregation(bag, `${path}.numerator`, value.numerator, cols, tableId, depth + 1);
  checkAggregation(bag, `${path}.denominator`, value.denominator, cols, tableId, depth + 1);
  if (value.as !== 'percent' && value.as !== 'number') {
    bag.errors.push(`${path}.as: expected "percent" or "number", got ${describe(value.as)}.`);
  }
}

// Parses a metric's formula, validates the result against the profile, and
// returns the Metric that types.ts declares — `formula` in, `agg` out.
function buildMetric(
  bag: Bag,
  path: string,
  value: unknown,
  cols: Map<string, string> | null,
  tableId: string,
  seenKeys: Set<string>,
): Record<string, unknown> | null {
  if (!isObj(value)) {
    bag.errors.push(`${path}: expected a metric object, got ${describe(value)}.`);
    return null;
  }
  let ok = true;
  if (!isStr(value.key)) {
    bag.errors.push(`${path}.key: expected a non-empty string, got ${describe(value.key)}.`);
    ok = false;
  } else if (seenKeys.has(value.key)) {
    bag.errors.push(`${path}.key: duplicate metric key ${JSON.stringify(value.key)} in this section.`);
    ok = false;
  } else {
    seenKeys.add(value.key);
  }
  if (!isStr(value.label)) {
    bag.errors.push(`${path}.label: expected a non-empty string, got ${describe(value.label)}.`);
    ok = false;
  }
  if (!isStr(value.format) || !METRIC_FORMATS.has(value.format)) {
    bag.errors.push(
      `${path}.format: expected one of ${[...METRIC_FORMATS].join(', ')}, got ${describe(value.format)}.`,
    );
    ok = false;
  }

  const agg = parseField(bag, `${path}.formula`, value.formula, parseFormula);
  if (agg) {
    // The parser guarantees op/field pairing by construction; this re-checks it
    // against the profile — that the columns exist and are the right type — and
    // doubles as a self-check on the parser.
    checkAggregation(bag, `${path}.formula`, agg, cols, tableId);
  } else {
    ok = false;
  }

  const metric: Record<string, unknown> = {
    key: value.key,
    label: value.label,
    agg,
    format: value.format,
  };

  if (!absent(value.target)) {
    const t = value.target;
    if (!isObj(t)) {
      bag.errors.push(`${path}.target: expected a target object, got ${describe(t)}.`);
      ok = false;
    } else {
      if (t.comparator !== '>=' && t.comparator !== '<=') {
        bag.errors.push(`${path}.target.comparator: expected ">=" or "<=", got ${describe(t.comparator)}.`);
        ok = false;
      }
      if (typeof t.value !== 'number' || !Number.isFinite(t.value)) {
        bag.errors.push(`${path}.target.value: expected a finite number, got ${describe(t.value)}.`);
        ok = false;
      }
      // The user owns targets. A benchmark is judgement, not something one week
      // of data implies, so anything the planner proposes must say so.
      if (t.source !== 'proposed') {
        bag.errors.push(
          `${path}.target.source: must be "proposed" — the planner may suggest a target but never claim the user set one. Got ${describe(t.source)}.`,
        );
        ok = false;
      }
      if (ok) metric.target = { comparator: t.comparator, value: t.value, source: 'proposed' };
    }
  }
  return ok ? metric : null;
}

// Runs one of the formula parsers, turning a FormulaError into a validation
// error carrying the field path.
function parseField(
  bag: Bag,
  path: string,
  src: unknown,
  parse: (s: unknown) => Record<string, unknown>,
): Record<string, unknown> | null {
  try {
    return parse(src);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    bag.errors.push(`${path}: ${message}.`);
    return null;
  }
}

// =============================================================================
//  Validates model output against the ReportSpec grammar AND against the profile
//  it was planned from, and lowers the wire format to the contract in types.ts:
//  formula strings become Aggregation objects, condition strings become
//  Predicates, and the fields kept out of the schema to stay inside the
//  optional-parameter limit (sortDir, limit) are defaulted here.
//
//  Returns every problem it found, not just the first — a re-plan costs a few
//  cents, so one round trip listing six faults beats six round trips.
// =============================================================================
export function validateReportSpec(
  raw: unknown,
  profile: SafeProfile,
): ValidationResult<Record<string, unknown>> {
  const bag: Bag = { errors: [] };
  const { byTable, allColumns } = indexProfile(profile);
  const tableIds = [...byTable.keys()];

  if (!isObj(raw)) {
    return { ok: false, errors: [`spec: expected an object, got ${describe(raw)}.`] };
  }
  if (raw.version !== 1) {
    bag.errors.push(`spec.version: expected 1, got ${describe(raw.version)}.`);
  }
  if (!isStr(raw.title)) {
    bag.errors.push(`spec.title: expected a non-empty string, got ${describe(raw.title)}.`);
  }
  if (!isStr(raw.dataDescription)) {
    bag.errors.push(
      `spec.dataDescription: expected a non-empty string, got ${describe(raw.dataDescription)}.`,
    );
  }

  for (const field of ['unmappedColumns', 'warnings'] as const) {
    const list = raw[field];
    if (!Array.isArray(list)) {
      bag.errors.push(`spec.${field}: expected an array, got ${describe(list)}.`);
      continue;
    }
    list.forEach((entry, i) => {
      if (!isStr(entry)) {
        bag.errors.push(`spec.${field}[${i}]: expected a non-empty string, got ${describe(entry)}.`);
      } else if (field === 'unmappedColumns' && !allColumns.has(entry)) {
        bag.errors.push(
          `spec.unmappedColumns[${i}]: ${JSON.stringify(entry)} is not a column in this upload.`,
        );
      }
    });
  }

  const rawSections = raw.sections;
  if (!Array.isArray(rawSections) || rawSections.length === 0) {
    bag.errors.push('spec.sections: expected a non-empty array of sections.');
    return { ok: false, errors: bag.errors };
  }

  const seenIds = new Set<string>();
  const built: Array<Record<string, unknown>> = [];

  rawSections.forEach((s, i) => {
    const path = `spec.sections[${i}]`;
    if (!isObj(s)) {
      bag.errors.push(`${path}: expected a section object, got ${describe(s)}.`);
      return;
    }
    if (!isStr(s.id)) {
      bag.errors.push(`${path}.id: expected a non-empty string, got ${describe(s.id)}.`);
    } else if (seenIds.has(s.id)) {
      bag.errors.push(`${path}.id: duplicate section id ${JSON.stringify(s.id)}.`);
    } else {
      seenIds.add(s.id);
    }

    const kind = s.kind;
    if (!isStr(kind) || !SECTION_KINDS.has(kind)) {
      bag.errors.push(
        `${path}.kind: expected one of ${[...SECTION_KINDS].join(', ')}, got ${describe(kind)}.`,
      );
      return;
    }
    checkFields(
      bag,
      path,
      s,
      [...SECTION_COMMON_FIELDS, ...(SECTION_FIELDS[kind] ?? [])],
      `a "${kind}" section`,
    );
    if (!isStr(s.title)) {
      bag.errors.push(`${path}.title: expected a non-empty string, got ${describe(s.title)}.`);
    }

    if (kind === 'narrative') {
      if (!isStr(s.brief)) {
        bag.errors.push(
          `${path}.brief: a narrative section needs a brief for the writing stage, got ${describe(s.brief)}.`,
        );
        return;
      }
      built.push({ id: s.id, kind, title: s.title, brief: s.brief });
      return;
    }
    if (kind === 'callout') {
      if (s.tone !== 'info' && s.tone !== 'warn') {
        bag.errors.push(`${path}.tone: expected "info" or "warn", got ${describe(s.tone)}.`);
        return;
      }
      if (!isStr(s.body)) {
        bag.errors.push(`${path}.body: expected a non-empty string, got ${describe(s.body)}.`);
        return;
      }
      built.push({ id: s.id, kind, tone: s.tone, title: s.title, body: s.body });
      return;
    }

    // Everything below reads data, so it must name a real table.
    let cols: Map<string, string> | null = null;
    const tableId = isStr(s.tableId) ? s.tableId : '';
    if (!tableId) {
      bag.errors.push(`${path}.tableId: expected a table id, got ${describe(s.tableId)}.`);
    } else {
      cols = byTable.get(tableId) ?? null;
      if (!cols) {
        bag.errors.push(
          `${path}.tableId: ${JSON.stringify(tableId)} is not in this upload. Known tables: ${tableIds.join(', ')}.`,
        );
      }
    }

    const section: Record<string, unknown> = { id: s.id, kind, title: s.title, tableId };

    if (!absent(s.filter)) {
      const predicate = parseField(bag, `${path}.filter`, s.filter, parseCondition);
      if (predicate) {
        checkPredicate(bag, `${path}.filter`, predicate, cols, tableId);
        section.filter = predicate;
      }
    }

    const buildMetrics = (): { metrics: Array<Record<string, unknown>>; keys: Set<string> } => {
      const keys = new Set<string>();
      const metrics: Array<Record<string, unknown>> = [];
      const list = s.metrics;
      if (!Array.isArray(list) || list.length === 0) {
        bag.errors.push(`${path}.metrics: expected a non-empty array of metrics.`);
        return { metrics, keys };
      }
      list.forEach((m, j) => {
        const metric = buildMetric(bag, `${path}.metrics[${j}]`, m, cols, tableId, keys);
        if (metric) metrics.push(metric);
      });
      return { metrics, keys };
    };

    if (kind === 'statCards') {
      section.metrics = buildMetrics().metrics;
      built.push(section);
      return;
    }
    if (kind === 'scorecard') {
      checkColumn(bag, `${path}.groupBy`, s.groupBy, cols, tableId);
      const { metrics, keys } = buildMetrics();
      section.groupBy = s.groupBy;
      section.metrics = metrics;
      if (!absent(s.sortBy)) {
        if (!isStr(s.sortBy)) {
          bag.errors.push(`${path}.sortBy: expected a string, got ${describe(s.sortBy)}.`);
        } else if (!keys.has(s.sortBy) && cols && !cols.has(s.sortBy)) {
          bag.errors.push(
            `${path}.sortBy: ${JSON.stringify(s.sortBy)} is neither a metric key in this section nor a column in "${tableId}".`,
          );
        } else {
          section.sortBy = s.sortBy;
        }
      } else if (metrics.length > 0) {
        // Defaulted here rather than asked for: an unsorted scorecard is never
        // what anyone wants, and every optional field costs schema budget.
        section.sortBy = metrics[0].key;
      }
      section.sortDir = DEFAULT_SORT_DIR;
      built.push(section);
      return;
    }
    if (kind === 'ranking') {
      checkColumn(bag, `${path}.groupBy`, s.groupBy, cols, tableId);
      section.groupBy = s.groupBy;
      // Singular on the wire and singular in types.ts — no lowering needed.
      const metric = buildMetric(bag, `${path}.metric`, s.metric, cols, tableId, new Set<string>());
      if (metric) section.metric = metric;
      section.limit = DEFAULT_RANKING_LIMIT;
      built.push(section);
      return;
    }
    if (kind === 'trend') {
      checkColumn(bag, `${path}.bucketBy`, s.bucketBy, cols, tableId);
      section.bucketBy = s.bucketBy;
      section.metrics = buildMetrics().metrics;
      built.push(section);
      return;
    }
    // table
    const columns = s.columns;
    if (!Array.isArray(columns) || columns.length === 0) {
      bag.errors.push(`${path}.columns: expected a non-empty array of column names.`);
    } else {
      columns.forEach((c, j) => checkColumn(bag, `${path}.columns[${j}]`, c, cols, tableId));
      section.columns = columns;
    }
    if (!absent(s.sortBy)) {
      const sortBy = checkColumn(bag, `${path}.sortBy`, s.sortBy, cols, tableId);
      if (sortBy) {
        section.sortBy = sortBy;
        section.sortDir = DEFAULT_SORT_DIR;
      }
    }
    // A "raw-ish rows" section with no limit renders the whole sheet.
    section.limit = DEFAULT_TABLE_LIMIT;
    built.push(section);
  });

  if (bag.errors.length) return { ok: false, errors: bag.errors };
  return {
    ok: true,
    value: {
      version: 1,
      title: raw.title,
      dataDescription: raw.dataDescription,
      sections: built,
      unmappedColumns: raw.unmappedColumns,
      warnings: raw.warnings,
    },
  };
}

// The prose wire format uses arrays where ReportProse uses Records — a JSON
// schema cannot describe an arbitrarily-keyed map, so the model emits pairs and
// this function turns them back into the shape src/lib/reports/types.ts declares.
export function validateReportProse(
  raw: unknown,
  sectionIds: string[],
): ValidationResult<Record<string, unknown>> {
  const bag: Bag = { errors: [] };
  const known = new Set(sectionIds);
  if (!isObj(raw)) {
    return { ok: false, errors: [`prose: expected an object, got ${describe(raw)}.`] };
  }

  const headline = raw.headline;
  if (!isObj(headline) || !isStr(headline.title) || !isStr(headline.body)) {
    bag.errors.push('prose.headline: expected { title, body } with non-empty strings.');
  }

  const commentary: Record<string, string> = {};
  const list = raw.sectionCommentary;
  if (!Array.isArray(list)) {
    bag.errors.push(`prose.sectionCommentary: expected an array, got ${describe(list)}.`);
  } else {
    list.forEach((entry, i) => {
      const p = `prose.sectionCommentary[${i}]`;
      if (!isObj(entry) || !isStr(entry.sectionId) || !isStr(entry.text)) {
        bag.errors.push(`${p}: expected { sectionId, text } with non-empty strings.`);
        return;
      }
      if (!known.has(entry.sectionId)) {
        bag.errors.push(
          `${p}.sectionId: ${JSON.stringify(entry.sectionId)} is not a section in this report.`,
        );
        return;
      }
      commentary[entry.sectionId] = entry.text;
    });
  }

  const notes: Record<string, { win: string; fix: string }> = {};
  const notesIn = raw.perGroupNotes;
  if (!absent(notesIn)) {
    if (!Array.isArray(notesIn)) {
      bag.errors.push(`prose.perGroupNotes: expected an array, got ${describe(notesIn)}.`);
    } else {
      notesIn.forEach((entry, i) => {
        const p = `prose.perGroupNotes[${i}]`;
        if (!isObj(entry) || !isStr(entry.group) || !isStr(entry.win) || !isStr(entry.fix)) {
          bag.errors.push(`${p}: expected { group, win, fix } with non-empty strings.`);
          return;
        }
        notes[entry.group] = { win: entry.win, fix: entry.fix };
      });
    }
  }

  const recommendations: Array<Record<string, unknown>> = [];
  const recsIn = raw.recommendations;
  if (!Array.isArray(recsIn)) {
    bag.errors.push(`prose.recommendations: expected an array, got ${describe(recsIn)}.`);
  } else {
    recsIn.forEach((entry, i) => {
      const p = `prose.recommendations[${i}]`;
      if (!isObj(entry)) {
        bag.errors.push(`${p}: expected a recommendation object, got ${describe(entry)}.`);
        return;
      }
      if (!isInt(entry.rank) || (entry.rank as number) < 1) {
        bag.errors.push(`${p}.rank: expected a positive integer, got ${describe(entry.rank)}.`);
      }
      if (!isStr(entry.title) || !isStr(entry.body)) {
        bag.errors.push(`${p}: title and body must both be non-empty strings.`);
        return;
      }
      const rec: Record<string, unknown> = {
        rank: entry.rank,
        title: entry.title,
        body: entry.body,
      };
      if (isStr(entry.target)) rec.target = entry.target;
      recommendations.push(rec);
    });
  }

  if (bag.errors.length) return { ok: false, errors: bag.errors };
  const head = headline as Record<string, unknown>;
  const value: Record<string, unknown> = {
    headline: { title: head.title, body: head.body },
    sectionCommentary: commentary,
    recommendations: recommendations.sort(
      (a, b) => (a.rank as number) - (b.rank as number),
    ),
  };
  if (Object.keys(notes).length > 0) value.perGroupNotes = notes;
  return { ok: true, value };
}

// =============================================================================
//  JSON schemas for structured output
//
//  Small on purpose, because this schema has broken two separate limits already
//  and they pull against each other:
//
//    anyOf unions          -> "too many parameters with union types (86 ...
//                             limit: 16 parameters with unions)"
//    flattened to objects  -> "too many optional parameters (105) ... limit: 24"
//
//  A discriminated union costs unions; flattening it to one permissive object
//  converts every variant field into an optional one. For a recursive union like
//  Aggregation, unrolled to depth, neither side fits.
//
//  So Aggregation and Predicate are not in the schema at all — they travel as
//  formula strings and the parser above lowers them (see that section for the
//  grammar). A Metric is { key, label, formula, format, target? }: one optional
//  field and no nesting. That took the schema to 0 unions and 11 optionals.
//
//  Rules for anyone editing this:
//    1. No anyOf, oneOf, allOf, and no `type: [...]` arrays. Budget is 16; the
//       count is 0 and there is no good reason to spend any of it.
//    2. Optional properties are the scarce resource. Budget is 24. Before adding
//       one, ask whether code can default it — sortDir, limit, subtitle and
//       description were all removed on exactly that basis and are applied in
//       validateReportSpec instead.
//    3. No recursion, and no `additionalProperties` other than false. Both are
//       rejected outright by structured outputs.
//    4. Records like ReportProse.sectionCommentary cannot be expressed at all,
//       since additionalProperties may only be false. They travel as arrays of
//       pairs and validateReportProse maps them back.
//
//  countUnions() and countOptionalParams() at the bottom are the regression
//  guard. The test suite asserts both stay under their limits.
// =============================================================================

const S_STRING = { type: 'string' } as const;

// `required` defaults to every property. Pass an explicit list to make fields
// optional — by absence, never by a union with null.
const obj = (properties: Record<string, unknown>, required?: string[]) => {
  const schema: Record<string, unknown> = {
    type: 'object',
    properties,
    additionalProperties: false,
  };
  const req = required ?? Object.keys(properties);
  if (req.length > 0) schema.required = req;
  return schema;
};

const TARGET = obj({
  comparator: { type: 'string', enum: ['>=', '<='] },
  value: { type: 'number' },
  // Locked to "proposed" here as well as in the validator: the user owns targets.
  source: { type: 'string', enum: ['proposed'] },
});

const METRIC = obj(
  {
    key: S_STRING,
    label: S_STRING,
    // The Aggregation, as a formula string. See the parser section for the grammar.
    formula: S_STRING,
    format: {
      type: 'string',
      enum: ['currency', 'percent', 'number', 'integer', 'duration', 'text'],
    },
    target: TARGET,
  },
  ['key', 'label', 'formula', 'format'],
);

// Seven closed shapes, not one grab-bag. The flattened version listed every
// kind-specific field as optional on a single object, which told the model that
// a ranking may carry `columns` and a scorecard may carry `tone` — and it did
// exactly that, twice, in spite of a prompt saying otherwise. Structure beats
// prose: inside a branch the wrong field is unrepresentable, so no instruction
// is needed.
//
// This is affordable now only because Aggregation and Predicate became formula
// strings. They were the 86 unions; a discriminated union on Section alone is 1.
const METRIC_LIST = { type: 'array', items: METRIC, minItems: 1 };

const sectionBranch = (
  kind: string,
  fields: Record<string, unknown>,
  optional: string[] = [],
) => {
  const properties = {
    id: S_STRING,
    kind: { type: 'string', enum: [kind] },
    title: S_STRING,
    ...fields,
  };
  return obj(
    properties,
    Object.keys(properties).filter((k) => !optional.includes(k)),
  );
};

const SECTION = {
  anyOf: [
    sectionBranch(
      'statCards',
      { tableId: S_STRING, metrics: METRIC_LIST, filter: S_STRING },
      ['filter'],
    ),
    sectionBranch(
      'scorecard',
      {
        tableId: S_STRING,
        groupBy: S_STRING,
        metrics: METRIC_LIST,
        sortBy: S_STRING,
        filter: S_STRING,
      },
      ['sortBy', 'filter'],
    ),
    sectionBranch(
      'table',
      {
        tableId: S_STRING,
        columns: { type: 'array', items: S_STRING, minItems: 1 },
        sortBy: S_STRING,
        filter: S_STRING,
      },
      ['sortBy', 'filter'],
    ),
    // Singular and required: types.ts gives a ranking exactly one metric, and
    // maxItems is not supported, so a one-element array could not be enforced.
    sectionBranch('ranking', { tableId: S_STRING, groupBy: S_STRING, metric: METRIC }),
    sectionBranch('trend', { tableId: S_STRING, bucketBy: S_STRING, metrics: METRIC_LIST }),
    sectionBranch('narrative', { brief: S_STRING }),
    sectionBranch('callout', { tone: { type: 'string', enum: ['info', 'warn'] }, body: S_STRING }),
  ],
};

export const REPORT_SPEC_SCHEMA = obj({
  version: { type: 'integer', enum: [1] },
  title: S_STRING,
  dataDescription: S_STRING,
  sections: { type: 'array', items: SECTION },
  unmappedColumns: { type: 'array', items: S_STRING },
  warnings: { type: 'array', items: S_STRING },
});

export const REPORT_PROSE_SCHEMA = obj(
  {
    headline: obj({ title: S_STRING, body: S_STRING }),
    sectionCommentary: {
      type: 'array',
      items: obj({ sectionId: S_STRING, text: S_STRING }),
    },
    perGroupNotes: {
      type: 'array',
      items: obj({ group: S_STRING, win: S_STRING, fix: S_STRING }),
    },
    recommendations: {
      type: 'array',
      items: obj(
        { rank: { type: 'integer' }, title: S_STRING, body: S_STRING, target: S_STRING },
        ['rank', 'title', 'body'],
      ),
    },
  },
  ['headline', 'sectionCommentary', 'recommendations'],
);

// ---- Regression guards -----------------------------------------------------
// Both limits are counted per OCCURRENCE in the expanded schema, not per unique
// node: an object reused in three places is paid for three times. That is why
// the old Predicate, inlined 21 times, was so expensive.

// Nodes the API counts against its 16-parameter union budget.
export function countUnions(schema: unknown): number {
  if (Array.isArray(schema)) {
    return schema.reduce((n: number, child) => n + countUnions(child), 0);
  }
  if (!schema || typeof schema !== 'object') return 0;
  let count = 0;
  for (const [key, child] of Object.entries(schema as Record<string, unknown>)) {
    if (key === 'anyOf' || key === 'oneOf' || key === 'allOf') count++;
    if (key === 'type' && Array.isArray(child)) count++;
    count += countUnions(child);
  }
  return count;
}

// Properties absent from their object's `required` list, counted against the
// 24-parameter optional budget.
export function countOptionalParams(schema: unknown): number {
  if (Array.isArray(schema)) {
    return schema.reduce((n: number, child) => n + countOptionalParams(child), 0);
  }
  if (!schema || typeof schema !== 'object') return 0;
  const node = schema as Record<string, unknown>;
  let count = 0;
  if (node.type === 'object' && node.properties && typeof node.properties === 'object') {
    const required = new Set(Array.isArray(node.required) ? (node.required as string[]) : []);
    for (const key of Object.keys(node.properties as Record<string, unknown>)) {
      if (!required.has(key)) count++;
    }
  }
  for (const child of Object.values(node)) count += countOptionalParams(child);
  return count;
}

// =============================================================================
//  Prompts
// =============================================================================

const PLAN_SYSTEM = `You are the planning stage of a reporting pipeline for an agency that manages OnlyFans creators.

You are given a PROFILE of an uploaded spreadsheet: table ids, column names, the inferred type of each column, and up to five sample values per column. You never see the data itself, and you never will.

Answer three questions and return them as a ReportSpec:
  1. What is this data? (dataDescription — say it plainly, e.g. "one row per chatter per shift, with sales, PPVs sent and clocked hours")
  2. What report does it support?
  3. Which sections, metrics and groupings should that report contain?

THE RULE THAT MATTERS MOST: you describe calculations, you never perform them. Every metric carries a "formula" string that a separate program parses and executes against the real rows. Emit

  ratio(sum("Direct PPVs sent"), sum("Clocked hours"))

never

  2.14

You have not seen a single number and cannot compute one. A literal value where a formula belongs is a hard failure and the entire spec is rejected.

FORMULA SYNTAX. Column names are ALWAYS in double quotes — real headers contain spaces and parentheses, so bare names cannot be parsed. The complete list of functions:

  count()                                 how many rows
  sum("Total spend")                      also mean, median, min, max
  distinctCount("Fan name")               how many different values
  shareOfTotal("Total spend", 5)          the top 5 rows' share of the column total
  passthrough("Sales per hour")           use the sheet's own value verbatim
  ratio(A, B)                             A divided by B, shown as a number
  ratioPercent(A, B)                      A divided by B, shown as a percentage
  countWhere(condition)                   how many rows match

Conditions, used by countWhere and by a section's "filter":

  "Total spend" > 100                     also  ==  !=  >=  <  <=
  "Status" == "active"                    text compares need quotes too
  nonEmpty("Clocked hours")               isEmpty(...) is the opposite
  all(cond, cond)                         every condition must hold
  any(cond, cond)                         at least one must hold

Worked examples:

  PPVs per hour, over a duration column. Clocked hours are stored as durations
  like "47h 18min"; the ratio handles the conversion, you just name the columns:
    ratio(sum("Direct PPVs sent"), sum("Clocked hours"))          format: "number"

  Average revenue per fan, as money:
    ratio(sum("Total spend"), distinctCount("Fan name"))          format: "currency"

  Revenue concentration — what share of all spending comes from the top 5 fans.
  This is the one to reach for when the question is "how exposed are we":
    shareOfTotal("Total spend", 5)                                format: "percent"

  Share of fans who are paying at all, as a percentage of the roster:
    ratioPercent(countWhere("Total spend" > 0), count())          format: "percent"

  Sales made during logged shifts only, excluding rows with no timekeeping:
    countWhere(all("Total sales" > 0, nonEmpty("Clocked hours"))) format: "integer"

Rules on formulas: a ratio's two arguments may not themselves be ratios. sum, mean and median need a numeric, currency, percent or duration column; min and max also accept dates. Every column named in a formula must exist in the profile, spelled exactly.

How to read the profile — this decides which columns are usable:
  - Judge a column by "type" and "nonEmpty", never by what is in "samples". The sample list tops up with empty markers when there are fewer than five distinct real values, so a column can show "-" in its samples and still be entirely usable.
  - A column with type "empty" or nonEmpty 0 has no data at all. Never build a metric on it. Put it in unmappedColumns and say so in warnings — e.g. "Response time (based on scheduled hours) is empty in every row, so response-time reporting is unavailable".
  - "distinct" counts non-empty values only, so it is a reliable read of how many groups a groupBy would produce. distinct 0 means no usable groups; distinct 1 means the column is a constant (a single period label, say) and is not a grouping dimension.
  - min/max on a duration column are in SECONDS. A clocked-hours max of 195900 is 54.4 hours. Convert before you reason about magnitude.
  - A present zero is data; "-" is not. Someone with 0 minutes clocked has a real zero, which makes them a legitimate zero denominator. Do not attach a target to a per-hour metric whose denominator can be zero; put the caveat in warnings instead.
  - Plan against the columns, not the file. Two uploads of the same export share a spec, so nothing in the plan may depend on a file name, a sheet name or a row count.
  - The leading "Source" column (or "Source file") names the entity each set of rows came from — a creator, a model, a CSV section. Tables with matching headers are unioned before you see them, so when Source has more than one distinct value it is a real grouping dimension and is often the ONLY one: a Fan Report has no creator column, so per-creator sections are expressible solely as groupBy "Source". Use it whenever a per-entity view is the point of the report. When Source has exactly one distinct value it is a constant — skip it and do not group by it.

SECTION KINDS — this is the rulebook, enforced by a validator that rejects the whole plan on any violation. Every section carries exactly "id", "kind", "title" plus the fields of its kind and NOTHING else:

  statCards   headline figures across a whole table          + tableId, metrics          (optional: filter)
  scorecard   one row per group, one column per metric       + tableId, groupBy, metrics (optional: filter, sortBy)
  table       selected columns, near-verbatim rows           + tableId, columns          (optional: filter, sortBy)
  ranking     top N by a single metric                       + tableId, groupBy, metric  (ONE metric object, not a list)
  trend       one bucket per period                          + tableId, bucketBy, metrics
  narrative   prose only, written at the next stage          + brief   (an instruction to the writer — the reader never sees it)
  callout     fixed text the reader must be told             + tone ("info" or "warn"), body  (finished text the reader DOES see)

Hard rules: metrics arrays are never empty. A field from one kind on another kind (columns on a ranking, tone on a scorecard, tableId on a narrative) rejects the plan. "sortBy" must name a metric key from that same section or a column in that section's table — never invent one. Sorting, row limits and subtitles are filled in for you: rankings show the top 10, tables the first 25 rows, sorts run descending.

OUTPUT FORMAT. Respond with ONLY a JSON object — no markdown fences, no commentary before or after. The exact shape:

{
  "version": 1,
  "title": "...",
  "dataDescription": "...",
  "sections": [
    { "id": "team", "kind": "statCards", "title": "This week", "tableId": "<a table id from the profile>",
      "metrics": [ { "key": "sales", "label": "Team sales", "formula": "sum(\\"Sales\\")", "format": "currency" } ] },
    { "id": "chatters", "kind": "scorecard", "title": "Chatter scorecard", "tableId": "...", "groupBy": "Employees",
      "metrics": [ { "key": "ppvhr", "label": "PPVs/hr", "formula": "ratio(sum(\\"Direct PPVs sent\\"), sum(\\"Clocked hours\\"))", "format": "number",
                    "target": { "comparator": ">=", "value": 4, "source": "proposed" } } ] },
    { "id": "why", "kind": "narrative", "title": "What this week shows", "brief": "Explain the single biggest gap between the team's activity and its targets." }
  ],
  "unmappedColumns": [],
  "warnings": []
}

Metric fields: "key" (short, unique in its section), "label", "formula", "format" (one of currency, percent, number, integer, duration, text), optional "target" ({ "comparator": ">=" or "<=", "value": <number>, "source": "proposed" } — always "proposed"; you may suggest a benchmark, never claim the user set one).

The two kinds worth reading twice are the two with no table behind them. A narrative carries only a "brief", and that brief is an INSTRUCTION to the writing stage — the reader never sees it. A callout carries "tone" and "body", and the body IS the finished text the reader sees, so write it as a complete sentence and never as a note to yourself:

  {"id":"context","kind":"narrative","title":"What changed this week",
   "brief":"Explain the drop in PPV throughput and say whether it tracks the drop in clocked hours or is separate from it."}

  {"id":"no_response_times","kind":"callout","tone":"warn","title":"Response times are missing",
   "body":"The response-time column is empty in every row, so nothing in this report speaks to reply speed."}

A worked data section, for the shape of a metric in context:

  {"id":"per_chatter","kind":"scorecard","title":"Per chatter","tableId":"employees#0","groupBy":"Employee","sortBy":"total_sales",
   "metrics":[{"key":"total_sales","label":"Sales","formula":"sum(\"Total sales\")","format":"currency"}]}

If a section would have no metric worth showing, drop the section and put the reason in warnings. An empty report section is worse than an absent one.

Hard requirements:
  - The schema lists nearly every section field as optional, because one object shape has to carry all seven kinds. That is a limitation of the schema, not permission — the table above is what is actually enforced.
  - Every tableId must be a table id from the profile. Every column name must be spelled exactly as the profile spells it — do not correct, pluralise, trim or tidy a header.
  - Metric keys are lowercase snake_case, unique within their section, and stable enough to mean the same thing next week.
  - "format" is display only (currency, percent, number, integer, duration, text). It never changes how a figure is computed. Use "percent" with ratioPercent and shareOfTotal, "currency" for money, "duration" for time.
  - Targets are judgement, not data. You may propose one, and it must carry "source":"proposed". You may never mark a target as the user's. One upload is not a benchmark, so most metrics should carry no target at all — omit the field.
  - Every column you could not place in any section goes in unmappedColumns. Surfacing it is correct; hiding it is not.
  - Every figure you would want to report but cannot compute from these columns goes in warnings, saying plainly what is missing — e.g. "no clocked-hours column, so per-hour productivity is unavailable".
  - Prefer a short report that is entirely computable over a long one with guesses in it.`;

const WRITE_SYSTEM = `You are the writing stage of a reporting pipeline for an agency that manages OnlyFans creators. The numbers are already computed. You are given the finished report: sections, metric definitions, and per-group values, each with the exact string the reader will see on the page.

THE RULE THAT MATTERS MOST: quote the computed figures, never produce new ones. Do not re-derive, re-average, add two numbers together, convert a currency, annualise, or estimate. Every number in your prose must be copied from a "formatted" value you were given. If a figure you want is not in the input, say you cannot see it, or leave it out.

"—" MEANS NOT COMPUTABLE. It does not mean zero. A missing denominator is missing, not zero. A chatter with $1,928 in sales and no clocked hours logged shows "—" for sales per hour: that is a timekeeping gap, not zero productivity, and writing "0 sales per hour" about them is a false accusation about a real person's work. Say something like "hours weren't logged this period, so we can't rate throughput" instead. Never rank, praise, criticise or draw a conclusion from a "—". Where a value carries a "note", it explains why the figure is missing — use it.

A section with an "error" failed to compute. Say so briefly and move on; do not guess what it would have said.
A section marked "rowsWithheld" is a detail table whose rows are not shown to you. Refer to it by title only.

Deliver:
  - headline: the single most important finding, as a title plus two to four sentences.
  - sectionCommentary: one entry per section id you were given, explaining what the section shows and what it means for the business. Use the exact section ids; never invent one.
  - perGroupNotes: for each group in a scorecard, one genuine strength and one specific fix. The strength must be real — do not manufacture praise; if someone is behind on everything, name the thing they are closest to fixing. The fix must name a behaviour and a figure, not "try harder".
  - recommendations: ranked from 1, most valuable first, each a concrete action someone could take on Monday. Set "target" only when the input actually carries a target for the metric you are discussing; otherwise null.

Write plainly. Short sentences, no hype, no emoji, no decorative dashes. Address the agency owner, who knows the business and does not need the metrics explained back to them.`;

// =============================================================================
//  Anthropic call
// =============================================================================

function anthropicClient(): Anthropic {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    throw new HttpError(500, 'The report AI is not configured on the server.', [
      'ANTHROPIC_API_KEY is not set for this Edge Function.',
      'Run: supabase secrets set ANTHROPIC_API_KEY=sk-ant-... --project-ref <your-project-ref>',
      'Then redeploy: supabase functions deploy report-ai',
    ]);
  }
  return new Anthropic({ apiKey });
}

type Turn = { role: 'user' | 'assistant'; content: string };

// Pull a JSON object out of model text that may carry markdown fences or a
// stray sentence around it. Tries strict parse first, then the fenced block,
// then the outermost brace span. Returns undefined only when nothing parses.
function extractJson(text: string): unknown | undefined {
  const attempts: string[] = [text];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) attempts.push(fence[1]);
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) attempts.push(text.slice(first, last + 1));
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate.trim());
    } catch {
      // fall through to the next candidate
    }
  }
  return undefined;
}

// `schema: null` means no constrained decoding: the prompt carries the output
// contract and the validator enforces it. Grammar compilation of the plan
// schema hit three different undocumented API limits (union count, optional
// count, compiled grammar size) — the validator+retry loop was the layer
// actually catching bad plans every time, so the plan call now relies on it
// outright. The prose schema is tiny and stays strict.
async function callModel(
  system: string,
  messages: Turn[],
  schema: unknown | null,
): Promise<unknown> {
  const client = anthropicClient();
  const request = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system,
    messages,
    ...(schema === null
      ? {}
      : { output_config: { format: { type: 'json_schema', schema } } }),
  };

  let response: {
    stop_reason?: string;
    stop_details?: { category?: string } | null;
    content?: Array<{ type?: string; text?: string }>;
  };
  try {
    // The SDK's published types lag output_config; the wire format is correct.
    // deno-lint-ignore no-explicit-any
    response = (await client.messages.create(request as any)) as any;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new HttpError(502, 'The AI provider rejected the request.', [
      message,
      'If this mentions authentication, the ANTHROPIC_API_KEY secret is wrong or revoked.',
      'If it mentions rate limits or overload, wait a moment and try again.',
    ]);
  }

  // A refusal is HTTP 200 with empty or partial content. Reading content[0]
  // without this check crashes instead of explaining itself.
  if (response.stop_reason === 'refusal') {
    const category = response.stop_details?.category ?? 'unspecified';
    throw new HttpError(422, 'The AI declined to process this upload.', [
      `The model returned a refusal (category: ${category}).`,
      'Check the column headers and sample values for anything the safety filters would flag, then try again.',
    ]);
  }
  if (response.stop_reason === 'max_tokens') {
    throw new HttpError(502, 'The AI ran out of room before finishing the report.', [
      'The response hit the output limit. Split the upload into fewer tables or fewer columns and try again.',
    ]);
  }

  const blocks = Array.isArray(response.content) ? response.content : [];
  const text = blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
  if (!text.trim()) {
    throw new HttpError(502, 'The AI returned an empty response.', [
      `stop_reason was "${response.stop_reason ?? 'unknown'}" with no text content. Try again.`,
    ]);
  }
  const parsed = extractJson(text);
  if (parsed === undefined) {
    throw new HttpError(502, 'The AI returned something that was not valid JSON.', [
      `First 200 characters: ${text.slice(0, 200)}`,
      'Try again — this is a transient model formatting slip, not a data problem.',
    ]);
  }
  return parsed;
}

function guardSize(payload: unknown, what: string): string {
  const json = JSON.stringify(payload);
  if (json.length > MAX_PAYLOAD_CHARS) {
    throw new HttpError(413, `This ${what} is too large to send to the AI in one request.`, [
      `The prepared payload is ${json.length.toLocaleString('en-US')} characters; the limit is ${MAX_PAYLOAD_CHARS.toLocaleString('en-US')}.`,
      'Split the upload into separate files, or drop sheets that are not part of this report.',
    ]);
  }
  return json;
}

// =============================================================================
//  Modes
// =============================================================================

// The validator's messages name the field, the problem and the fix, which is
// exactly what a model needs to correct itself — so a rejected plan is handed
// straight back rather than thrown away.
function repairTurn(errors: string[]): string {
  const shown = errors.slice(0, MAX_REPAIR_ERRORS);
  const omitted = errors.length - shown.length;
  return [
    `That plan failed validation. ${errors.length} problem${errors.length === 1 ? '' : 's'}:`,
    '',
    ...shown.map((e, i) => `${i + 1}. ${e}`),
    ...(omitted > 0 ? ['', `(and ${omitted} more of the same kind)`] : []),
    '',
    'Return a corrected plan for the same profile. Fix exactly these problems and change nothing else — keep every section, metric and formula that was not named above. Remember that each section kind accepts only its own fields, that every data section needs at least one metric, and that column names must be spelled exactly as the profile spells them.',
  ].join('\n');
}

async function runPlan(body: Record<string, unknown>): Promise<Response> {
  const profile = sanitizeProfile(body.profile);
  assertNoRawRows(profile);
  const json = guardSize(profile, 'upload profile');

  const messages: Turn[] = [
    { role: 'user', content: `Here is the profile of the upload. Plan the report.\n\n${json}` },
  ];
  let errors: string[] = [];
  let retried = false;

  // Two attempts, never more. A model that fails the same validation twice will
  // fail it a third time, and every attempt costs the user money and latency.
  for (let attempt = 1; attempt <= MAX_PLAN_ATTEMPTS; attempt++) {
    const raw = await callModel(PLAN_SYSTEM, messages, null);
    const result = validateReportSpec(raw, profile);
    if (result.ok) {
      if (retried) console.log('report-ai: plan accepted on retry after validation errors');
      return json200({ spec: result.value, retried });
    }
    errors = result.errors;
    if (attempt >= MAX_PLAN_ATTEMPTS) break;
    // Logged, not hidden: if retries become routine, the prompt needs work and
    // that should be visible in the function logs.
    console.log(
      `report-ai: plan attempt ${attempt} failed validation with ${errors.length} error(s), retrying once`,
    );
    retried = true;
    messages.push({ role: 'assistant', content: JSON.stringify(raw) });
    messages.push({ role: 'user', content: repairTurn(errors) });
  }

  // Errors from the final attempt, in the same shape as a single-attempt failure.
  throw new HttpError(502, 'The AI produced a report plan that does not match the report format.', [
    ...errors.slice(0, 25),
    `Nothing was saved. The plan was regenerated once with these errors fed back and still did not validate.`,
  ]);
}

async function runWrite(body: Record<string, unknown>): Promise<Response> {
  const { payload, sectionIds } = sanitizeComputed(body.computed);
  assertNoRawRows(payload);
  const json = guardSize(payload, 'computed report');

  const raw = await callModel(
    WRITE_SYSTEM,
    [{ role: 'user', content: `Here is the computed report. Write the prose.\n\n${json}` }],
    REPORT_PROSE_SCHEMA,
  );

  const result = validateReportProse(raw, sectionIds);
  if (!result.ok) {
    throw new HttpError(502, 'The AI produced commentary that does not match the report format.', [
      ...result.errors.slice(0, 25),
      'The numbers are unaffected. Try generating the commentary again.',
    ]);
  }
  return json200({ prose: result.value });
}

// =============================================================================
//  HTTP
// =============================================================================

function json200(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function jsonError(status: number, message: string, details: string[]): Response {
  return new Response(JSON.stringify({ error: message, details }), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// Verifies the caller's Supabase JWT. Without this the function URL is an open
// relay onto someone else's Anthropic bill.
async function requireUser(req: Request): Promise<void> {
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    throw new HttpError(401, 'You need to be signed in to generate a report.', [
      'The request carried no Authorization header. Sign out and back in, then retry.',
    ]);
  }
  const url = Deno.env.get('SUPABASE_URL');
  const anonKey =
    Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY');
  if (!url || !anonKey) {
    throw new HttpError(500, 'The report AI is not configured on the server.', [
      'SUPABASE_URL / SUPABASE_ANON_KEY are missing from the function environment.',
    ]);
  }
  const supabase = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user) {
    throw new HttpError(401, 'Your session has expired.', [
      'Sign out and back in, then try generating the report again.',
    ]);
  }
}

export async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') {
    return jsonError(405, 'This endpoint only accepts POST.', [
      `Received ${req.method}.`,
    ]);
  }
  try {
    await requireUser(req);

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      throw new HttpError(400, 'The request body was not valid JSON.', [
        'This is a bug in the app, not something you did. Please report it.',
      ]);
    }

    if (body?.mode === 'plan') return await runPlan(body);
    if (body?.mode === 'write') return await runWrite(body);
    throw new HttpError(400, 'Unknown report AI mode.', [
      `Expected mode "plan" or "write", got ${describe(body?.mode)}.`,
    ]);
  } catch (e) {
    if (e instanceof HttpError) return jsonError(e.status, e.message, e.details);
    const message = e instanceof Error ? e.message : String(e);
    // Never echo anything that could carry the key or the payload.
    console.error('report-ai unexpected failure:', message);
    return jsonError(500, 'The report AI hit an unexpected error.', [
      'Try again. If it keeps happening, check the report-ai function logs in Supabase.',
    ]);
  }
}

Deno.serve(handler);
