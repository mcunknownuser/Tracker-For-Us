// =============================================================================
//  Report pipeline — shared contracts.
//
//  The whole feature hangs off this file. Six stages, and the boundary between
//  them is the point:
//
//    parse    → RawTable[]        what was in the file
//    profile  → UploadProfile     what the columns look like (no values leaked)
//    plan     → ReportSpec        AI: WHAT to compute (never a number)
//    execute  → ComputedReport    code: HOW to compute it (every number here)
//    write    → ReportProse       AI: prose about the computed results
//    render   → HTML              code: sections composed per the spec
//
//  The rule that makes this safe: the model emits a description of a
//  calculation, never its result. If a figure appears in a report, it came out
//  of engine.ts and can be re-derived from the source rows.
// =============================================================================

// ---- Stage 1: parse --------------------------------------------------------

// One sheet (xlsx) or one section (multi-section Infloww CSV). Values stay as
// raw strings — coercion is profile.ts's job, so parsing stays lossless.
export type RawTable = {
  id: string;                  // stable within an upload, e.g. "topfans-teddy#0"
  sourceFile: string;
  sheetName: string | null;    // null for CSV
  headers: string[];
  rows: string[][];
};

// ---- Stage 2: profile ------------------------------------------------------

export type ColumnType =
  | 'string'
  | 'number'
  | 'currency'
  | 'percent'
  | 'date'
  | 'duration'   // "47h 18min", "2m 53s", "3 months", "22 days"
  | 'empty';

export type ColumnProfile = {
  name: string;
  index: number;
  type: ColumnType;
  nonEmpty: number;
  distinct: number;
  samples: string[];           // <= 5 raw values, for the planner to read
  min?: number;
  max?: number;
};

export type TableProfile = {
  id: string;
  sourceFile: string;
  sheetName: string | null;
  rowCount: number;
  columns: ColumnProfile[];
  signature: string;           // hash of normalized headers — keys spec reuse
};

export type UploadProfile = {
  tables: TableProfile[];
  signature: string;           // hash over table signatures, sorted
};

// ---- Stage 3: plan (AI output — validate before trusting) ------------------

export type Predicate =
  | { column: string; op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'; value: string | number }
  | { column: string; op: 'nonEmpty' | 'isEmpty' }
  | { all: Predicate[] }
  | { any: Predicate[] };

// Recursive so derived metrics work: PPVs/hour is
// ratio(sum "Direct PPVs sent", sum "Clocked hours").
export type Aggregation =
  | { op: 'sum' | 'mean' | 'median' | 'min' | 'max'; column: string }
  | { op: 'count' }
  | { op: 'countWhere'; predicate: Predicate }
  | { op: 'distinctCount'; column: string }
  | { op: 'ratio'; numerator: Aggregation; denominator: Aggregation; as: 'percent' | 'number' }
  | { op: 'shareOfTotal'; column: string; topN: number }   // top-5 fan concentration
  | { op: 'passthrough'; column: string };                 // use the source column verbatim

export type MetricFormat = 'currency' | 'percent' | 'number' | 'integer' | 'duration' | 'text';

export type Metric = {
  key: string;
  label: string;
  agg: Aggregation;
  format: MetricFormat;
  // Targets are judgement, not data. The planner may propose one; the user
  // owns it. Never present a proposed target as derived from the upload.
  target?: { comparator: '>=' | '<='; value: number; source: 'proposed' | 'user' };
  description?: string;
};

export type Section =
  // Headline figures across a whole table.
  | { id: string; kind: 'statCards'; title: string; tableId: string; metrics: Metric[]; filter?: Predicate }
  // One row per group, one column per metric, optional pass/fail badges.
  | { id: string; kind: 'scorecard'; title: string; tableId: string; groupBy: string;
      metrics: Metric[]; sortBy?: string; sortDir?: 'asc' | 'desc'; filter?: Predicate }
  // Raw-ish rows, selected columns.
  | { id: string; kind: 'table'; title: string; tableId: string; columns: string[];
      sortBy?: string; sortDir?: 'asc' | 'desc'; limit?: number; filter?: Predicate }
  // Top-N by a single metric.
  | { id: string; kind: 'ranking'; title: string; tableId: string; groupBy: string;
      metric: Metric; limit: number }
  // Period-over-period, one bucket per column.
  | { id: string; kind: 'trend'; title: string; tableId: string; bucketBy: string; metrics: Metric[] }
  // Prose only — no data access. Body is written at stage 5.
  | { id: string; kind: 'narrative'; title: string; brief: string }
  // Fixed text the planner wants surfaced (data limitations, caveats).
  | { id: string; kind: 'callout'; tone: 'info' | 'warn'; title: string; body: string };

export type ReportSpec = {
  version: 1;
  title: string;
  subtitle?: string;
  dataDescription: string;      // the planner's read of what was uploaded
  sections: Section[];
  unmappedColumns: string[];    // columns it could not place — surfaced, not hidden
  warnings: string[];           // e.g. "no clocked hours, so per-hour metrics are unavailable"
};

// ---- Stage 4: execute (code only — the only source of numbers) -------------

export type ComputedValue = {
  raw: number | null;           // null = not computable (missing/zero denominator)
  formatted: string;            // "$43.23", "44.6%", "—"
  meetsTarget?: boolean;
  note?: string;                // why it's null, or a provided-vs-derived mismatch
};

export type ComputedRow = {
  group: string;
  values: Record<string, ComputedValue>;   // keyed by Metric.key
};

export type ComputedSection = {
  id: string;
  kind: Section['kind'];
  title: string;
  spec: Section;
  values?: Record<string, ComputedValue>;  // statCards
  rows?: ComputedRow[];                    // scorecard / ranking / trend / table
  columns?: string[];                      // display order for row-shaped sections
  error?: string;                          // section failed; report still renders
};

export type ComputedReport = {
  spec: ReportSpec;
  sections: ComputedSection[];
  computedAt: string;                      // ISO
  sourceFiles: string[];
  rowsConsumed: number;
};

// ---- Stage 5: write (AI prose over computed results) -----------------------

export type ReportProse = {
  headline: { title: string; body: string };
  sectionCommentary: Record<string, string>;              // Section.id -> prose
  perGroupNotes?: Record<string, { win: string; fix: string }>;  // coach notes
  recommendations: { rank: number; title: string; body: string; target?: string }[];
};

export type Report = {
  computed: ComputedReport;
  prose: ReportProse;
};

// ---- Persistence -----------------------------------------------------------

export type StoredSpec = {
  id: string;
  agency_id: string;
  signature: string;            // UploadProfile.signature
  spec: ReportSpec;
  pinned: boolean;              // pinned specs are reused verbatim, never re-planned
  created_at: string;
  updated_at: string;
};

export type StoredRun = {
  id: string;
  agency_id: string;
  spec_id: string | null;
  title: string;
  period_label: string | null;
  source_files: string[];
  computed: ComputedReport;
  prose: ReportProse;
  created_at: string;
  created_by: string | null;
};
