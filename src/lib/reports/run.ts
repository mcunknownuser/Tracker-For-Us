// =============================================================================
//  Report orchestration — the one place the six stages are chained.
//
//    parse → merge → profile → plan → execute → write → save
//
//  Two behaviours here are worth stating plainly, because both are the
//  difference between a tool you can run weekly and one you can't:
//
//  1. SPEC REUSE. The planner runs the first time an upload shape is seen, and
//     the resulting spec is stored against the profile signature. Every later
//     upload of that same shape reuses it. So the weekly report keeps the same
//     structure with new numbers, chatters can compare against last week, and
//     the planning call isn't paid for twice. Re-planning is opt-in.
//
//  2. PROSE IS OPTIONAL, NUMBERS ARE NOT. If the writing call fails, you still
//     get the full report with every figure in it — the commentary is simply
//     missing, and the failure is reported rather than swallowed. A failed
//     planning call is fatal, because without a spec there is nothing to
//     compute.
// =============================================================================

import type {
  ColumnType, ComputedReport, Report, ReportProse, ReportSpec, UploadProfile,
} from './types';
import type { ColumnTypeMap } from './engine';
import { mergeTables } from './merge';
import { profileUpload } from './profile';
import { executeSpec } from './engine';
import { planReport, writeReportProse } from './ai';
import { getSpecBySignature, upsertSpec, saveRun } from './store';

export type RunStage =
  | 'parsing' | 'profiling' | 'planning' | 'computing' | 'writing' | 'saving' | 'done';

export type RunOptions = {
  files: { name: string; bytes: ArrayBuffer }[];
  title?: string;
  periodLabel?: string;
  /** Ignore any stored spec for this shape and plan afresh. */
  replan?: boolean;
  /** Default true. False is for previewing without writing history. */
  save?: boolean;
  onProgress?: (stage: RunStage, detail?: string) => void;
};

export type RunResult = {
  report: Report;
  spec: ReportSpec;
  profile: UploadProfile;
  /** True when a stored spec was reused, i.e. no planning call was made. */
  specReused: boolean;
  runId: string | null;
  /** Non-fatal problems worth showing the user. Never silently dropped. */
  warnings: string[];
};

const EMPTY_PROSE: ReportProse = {
  headline: { title: '', body: '' },
  sectionCommentary: {},
  recommendations: [],
};

function columnTypeMap(profile: UploadProfile): ColumnTypeMap {
  const map: Record<string, Record<string, ColumnType>> = {};
  for (const table of profile.tables) {
    map[table.id] = Object.fromEntries(table.columns.map((c) => [c.name, c.type]));
  }
  return map;
}

export async function runReport(opts: RunOptions): Promise<RunResult> {
  const { files, onProgress } = opts;
  const warnings: string[] = [];
  const notify = (s: RunStage, d?: string) => onProgress?.(s, d);

  if (files.length === 0) {
    throw new Error('No files to read. Add at least one .xlsx or .csv export and try again.');
  }

  // Loaded on demand: the xlsx reader is ~320KB minified, and nobody who
  // isn't generating a report should pay for it in the initial bundle.
  notify('parsing', `${files.length} file${files.length === 1 ? '' : 's'}`);
  const { parseUpload } = await import('./parse');
  const merged = mergeTables(await parseUpload(files));
  if (merged.length === 0) {
    throw new Error(
      'Nothing readable in those files — every sheet was empty. Check the export ' +
      'came out of Infloww with data rows, not just headers.',
    );
  }

  notify('profiling');
  const profile = profileUpload(merged);

  // Re-key every table to a STABLE id derived from its column signature, not
  // its file name. Infloww names every download with a fresh UUID, so
  // file-derived ids ("merged:6fec17e0-…#0") break the entire spec-reuse
  // mechanism: last week's saved spec matches this week's upload by signature
  // and then fails on every section because no table has last week's id.
  // Signature-derived ids ("t-147060da") are identical for identical column
  // layouts, whatever the files are called — which is the reuse contract.
  {
    const idMap = new Map<string, string>();
    const taken = new Set<string>();
    for (const t of profile.tables) {
      let stable = `t-${t.signature}`;
      for (let n = 2; taken.has(stable); n++) stable = `t-${t.signature}-${n}`;
      taken.add(stable);
      idMap.set(t.id, stable);
      t.id = stable;
    }
    for (const t of merged) t.id = idMap.get(t.id) ?? t.id;
  }

  // Reuse before planning. A pinned spec is never re-planned, even when the
  // caller asks — pinning exists precisely to freeze a report's shape.
  notify('planning');
  const stored = await getSpecBySignature(profile.signature);
  let spec: ReportSpec;
  let specId: string | null = null;
  let specReused = false;

  if (stored && (stored.pinned || !opts.replan)) {
    spec = stored.spec;
    specId = stored.id;
    specReused = true;
    if (opts.replan && stored.pinned) {
      warnings.push('This report shape is pinned, so it was reused rather than re-planned. Unpin it first to re-plan.');
    }
  } else {
    spec = await planReport(profile);
    const savedSpec = await upsertSpec(profile.signature, spec);
    specId = savedSpec.id;
  }

  if (spec.warnings.length > 0) warnings.push(...spec.warnings);
  if (spec.unmappedColumns.length > 0) {
    warnings.push(
      `${spec.unmappedColumns.length} column${spec.unmappedColumns.length === 1 ? '' : 's'} ` +
      `could not be placed and ${spec.unmappedColumns.length === 1 ? 'is' : 'are'} not in this report: ` +
      spec.unmappedColumns.join(', '),
    );
  }

  notify('computing');
  const computed: ComputedReport = executeSpec(merged, spec, columnTypeMap(profile));

  const failed = computed.sections.filter((s) => s.error);
  for (const s of failed) warnings.push(`Section "${s.title}" could not be computed: ${s.error}`);

  // The numbers are already in hand. Losing the provider here costs commentary,
  // not the report — so degrade instead of throwing away work the user paid for.
  notify('writing');
  let prose = EMPTY_PROSE;
  try {
    prose = await writeReportProse(computed);
  } catch (err) {
    warnings.push(
      `The written commentary could not be generated (${err instanceof Error ? err.message : String(err)}). ` +
      'All figures below are complete — you can retry the commentary without re-uploading.',
    );
  }

  let runId: string | null = null;
  if (opts.save !== false) {
    notify('saving');
    const run = await saveRun({
      specId,
      title: opts.title ?? spec.title,
      periodLabel: opts.periodLabel ?? null,
      computed,
      prose,
    });
    runId = run.id;
  }

  notify('done');
  return { report: { computed, prose }, spec, profile, specReused, runId, warnings };
}
