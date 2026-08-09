// =============================================================================
//  store.ts
//  Persistence for the report pipeline — the spec cache and the run history.
//
//  Two tables (see supabase/migrations/0020_reports.sql):
//
//    report_specs   one row per upload shape, keyed by UploadProfile.signature.
//                   Look the spec up before planning: if last week's export
//                   comes back with the same columns, reuse its structure
//                   rather than paying for another planning call and getting a
//                   report that no longer lines up with the previous one.
//
//    report_runs    one row per generated report, with the whole
//                   ComputedReport stored intact. The monthly rollup reads
//                   these back and re-aggregates weeks already computed, so
//                   never flatten or trim `computed` on the way in.
//
//  Everything is agency-scoped. RLS enforces that server-side; the explicit
//  .eq('agency_id', …) here keeps queries indexed and keeps the intent visible.
// =============================================================================

import { supabase } from '../supabase';
import { getActiveAgencyId } from '../agency';
import type { ComputedReport, ReportProse, ReportSpec, StoredRun, StoredSpec } from './types';

// Columns selected wherever we read a row. Kept in one place so adding a
// field means touching one constant, not every query.
const SPEC_COLS = 'id, agency_id, signature, spec, pinned, created_at, updated_at';

const RUN_COLS =
  'id, agency_id, spec_id, title, period_label, source_files, computed, prose, ' +
  'created_at, created_by';

// The history list shows title, period and date — pulling `computed` and
// `prose` for every row would drag megabytes of jsonb across the wire for a
// screen that renders none of it.
const RUN_LIST_COLS =
  'id, agency_id, spec_id, title, period_label, source_files, created_at, created_by';

export type StoredRunSummary = Omit<StoredRun, 'computed' | 'prose'>;

// =============================================================================
//  Specs
// =============================================================================

// The spec cached for this upload shape, or null if we've never seen it.
export async function getSpecBySignature(signature: string): Promise<StoredSpec | null> {
  const agencyId = getActiveAgencyId();
  if (!agencyId) return null;
  const { data, error } = await supabase
    .from('report_specs')
    .select(SPEC_COLS)
    .eq('agency_id', agencyId)
    .eq('signature', signature)
    .maybeSingle();
  if (error) throw error;
  return (data ?? null) as StoredSpec | null;
}

// Cache the plan for an upload shape, replacing any previous plan for it.
//
// `pinned` is deliberately absent from the payload: PostgREST only updates the
// columns it is given, so re-planning an upload shape cannot silently unpin a
// spec the agency has locked. Callers are expected to check `pinned` and skip
// re-planning entirely — see getSpecBySignature.
export async function upsertSpec(signature: string, spec: ReportSpec): Promise<StoredSpec> {
  const agencyId = getActiveAgencyId();
  if (!agencyId) throw new Error('No active agency.');
  const { data, error } = await supabase
    .from('report_specs')
    .upsert(
      { agency_id: agencyId, signature, spec },
      { onConflict: 'agency_id,signature' },
    )
    .select(SPEC_COLS)
    .single();
  if (error) throw error;
  return data as StoredSpec;
}

// Pin a spec (reuse it verbatim, never re-plan) or unpin it.
export async function setSpecPinned(id: string, pinned: boolean): Promise<StoredSpec> {
  const agencyId = getActiveAgencyId();
  if (!agencyId) throw new Error('No active agency.');
  const { data, error } = await supabase
    .from('report_specs')
    .update({ pinned })
    .eq('id', id)
    .eq('agency_id', agencyId)
    .select(SPEC_COLS)
    .single();
  if (error) throw error;
  return data as StoredSpec;
}

// =============================================================================
//  Runs
// =============================================================================

export type SaveRunInput = {
  specId: string | null;
  title: string;
  periodLabel: string | null;
  computed: ComputedReport;
  prose: ReportProse;
};

// Store a generated report. source_files comes from the ComputedReport itself
// so the column and the payload can never disagree about what was uploaded.
export async function saveRun(input: SaveRunInput): Promise<StoredRun> {
  const agencyId = getActiveAgencyId();
  if (!agencyId) throw new Error('No active agency.');
  const { data: userResp } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('report_runs')
    .insert({
      agency_id: agencyId,
      spec_id: input.specId,
      title: input.title,
      period_label: input.periodLabel,
      source_files: input.computed.sourceFiles,
      computed: input.computed,
      prose: input.prose,
      created_by: userResp.user?.id ?? null,
    })
    .select(RUN_COLS)
    .single();
  if (error) throw error;
  // `as unknown as` because RUN_COLS is built by concatenation, so supabase-js
  // can't parse it at the type level (same reason as in tracking.ts).
  return data as unknown as StoredRun;
}

// Report history, newest first, without the jsonb payloads.
export async function listRuns(opts?: {
  limit?: number;
  offset?: number;
}): Promise<StoredRunSummary[]> {
  const agencyId = getActiveAgencyId();
  if (!agencyId) return [];
  const limit = opts?.limit ?? 20;
  const offset = opts?.offset ?? 0;
  const { data, error } = await supabase
    .from('report_runs')
    .select(RUN_LIST_COLS)
    .eq('agency_id', agencyId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return (data ?? []) as StoredRunSummary[];
}

// One report in full — computed numbers and prose included. This is what the
// renderer and the monthly rollup read.
export async function getRun(id: string): Promise<StoredRun | null> {
  const agencyId = getActiveAgencyId();
  if (!agencyId) return null;
  const { data, error } = await supabase
    .from('report_runs')
    .select(RUN_COLS)
    .eq('id', id)
    .eq('agency_id', agencyId)
    .maybeSingle();
  if (error) throw error;
  return (data ?? null) as unknown as StoredRun | null;
}

// Hard delete — a discarded report is discarded. The spec it came from stays.
export async function deleteRun(id: string): Promise<void> {
  const agencyId = getActiveAgencyId();
  if (!agencyId) throw new Error('No active agency.');
  const { error } = await supabase
    .from('report_runs')
    .delete()
    .eq('id', id)
    .eq('agency_id', agencyId);
  if (error) throw error;
}
