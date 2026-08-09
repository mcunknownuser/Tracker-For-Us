// =============================================================================
//  ai.ts — the app's side of the two AI stages.
//
//  There is no Anthropic SDK in this file and no API key anywhere near it, on
//  purpose. This app ships as a Tauri binary, so anything Vite bundles — VITE_*
//  env vars included — is plain text inside the .app/.exe. An Anthropic key is
//  a billing credential; the same reasoning src/lib/supabase.ts applies to the
//  service-role key applies here. The key lives as a Supabase secret and only
//  supabase/functions/report-ai ever sees it.
//
//  So both stages are one HTTP call each, made through the shared supabase
//  client so the user's access token rides along and the function can refuse
//  anyone who is not signed in.
//
//    planReport(profile)      -> ReportSpec    what to compute
//    writeReportProse(report) -> ReportProse   prose about what was computed
//
//  The function validates the model's output before returning it, so anything
//  that arrives here is already known to match the contract in types.ts. What
//  is left for this file is turning a failure into a sentence that says what
//  went wrong and what to do about it.
// =============================================================================
import { supabase } from '../supabase';
import type { UploadProfile, ReportSpec, ComputedReport, ReportProse } from './types';

const FUNCTION_NAME = 'report-ai';

// `retried` is true when the function's first plan failed validation and was
// regenerated with the errors fed back to the model.
type PlanResponse = { spec: ReportSpec; retried?: boolean };
type WriteResponse = { prose: ReportProse };
type ErrorResponse = { error?: string; details?: string[] };

// AI: what to compute. Takes the profile — never the parsed rows, which stay on
// this machine.
export async function planReport(profile: UploadProfile): Promise<ReportSpec> {
  const data = await invoke<PlanResponse>({ mode: 'plan', profile });
  if (!data?.spec) {
    throw new Error(
      'The report planner returned nothing. Try again, and check the report-ai function logs in Supabase if it keeps happening.',
    );
  }
  // Surfaced rather than swallowed. A retry is invisible to the user and the
  // spec is valid either way, but if this starts appearing routinely the
  // planner prompt needs work — so it should be visible somewhere.
  if (data.retried) {
    console.warn(
      '[report-ai] The first report plan failed validation and was regenerated. ' +
        'The spec below is valid; see the report-ai function logs for what was wrong.',
    );
  }
  return data.spec;
}

// AI: prose about numbers engine.ts already computed. Every figure in the
// result was quoted from `computed`; none of it was calculated by the model.
export async function writeReportProse(computed: ComputedReport): Promise<ReportProse> {
  const data = await invoke<WriteResponse>({ mode: 'write', computed });
  if (!data?.prose) {
    throw new Error(
      'The report writer returned nothing. The numbers are unaffected — try generating the commentary again.',
    );
  }
  return data.prose;
}

async function invoke<T>(body: Record<string, unknown>): Promise<T> {
  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData.session) {
    throw new Error('You are signed out. Sign back in, then generate the report again.');
  }

  const { data, error } = await supabase.functions.invoke<T>(FUNCTION_NAME, { body });
  if (error) throw new Error(await describeError(error));
  return data as T;
}

// supabase-js hands back a generic "Edge Function returned a non-2xx status
// code" and hides the real reason inside error.context, which is the raw
// Response. That reason is the whole point — it is the list of things the AI
// got wrong, or the missing-secret instruction — so dig it out.
async function describeError(error: unknown): Promise<string> {
  const context = (error as { context?: unknown } | null)?.context;
  if (context instanceof Response) {
    let payload: ErrorResponse | null = null;
    try {
      payload = (await context.clone().json()) as ErrorResponse;
    } catch {
      payload = null;
    }
    if (payload?.error) {
      const details = (payload.details ?? []).filter(Boolean);
      return details.length > 0 ? `${payload.error}\n\n${details.join('\n')}` : payload.error;
    }
    if (context.status === 404) {
      return (
        'The report-ai function is not deployed to this Supabase project. ' +
        'Deploy it with: supabase functions deploy report-ai'
      );
    }
    if (context.status === 401) {
      return 'Your session has expired. Sign out and back in, then try again.';
    }
    return `The report AI failed with HTTP ${context.status}. Check the report-ai function logs in Supabase.`;
  }

  const message = error instanceof Error ? error.message : String(error);
  if (/failed to fetch|network/i.test(message)) {
    return 'Could not reach the report AI. Check your internet connection and try again.';
  }
  return `The report AI failed: ${message}`;
}
