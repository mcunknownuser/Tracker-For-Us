// =============================================================================
//  teamMembers.ts
//  Unified employees CRUD. Replaces lib/employees.ts, lib/redditEmployees.ts,
//  and lib/staff.ts.
// =============================================================================

import { supabase } from './supabase';
import { getActiveAgencyId } from './agency';
import type { PayStructure } from './staffRoles';

export type TeamMember = {
  id: string;
  agency_id: string;
  department_id: string;
  role_id: string | null;
  role_label: string | null;
  name: string;
  pay_structure: PayStructure;
  flat_amount_cents: number | null;
  flat_period_days: number | null;
  rate: number | null;
  phone: string | null;
  email: string | null;
  start_date: string | null;  // YYYY-MM-DD, optional
  end_date: string | null;    // YYYY-MM-DD, optional — set when they leave
  // Auth user this employee record is linked to. Null for team_members who
  // don't (yet) have a login — e.g. payment-only contractors, or rows
  // added before the user accepted their invite.
  user_id: string | null;
  created_at: string;
  updated_at: string;
};

// Input for create. Use one of the union shapes depending on pay structure.
export type CreateTeamMemberInput = {
  department_id: string;
  role_id: string | null;
  role_label: string | null;
  name: string;
  phone?: string | null;
  email?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  // Optional — set when converting a pending agency_membership into an
  // employee record. Lets us link the team_member to the auth user so
  // future sign-ins resolve to the same employee.
  user_id?: string | null;
} & (
  | { pay_structure: 'flat'; flat_amount_cents: number; flat_period_days: number }
  | { pay_structure: 'commission'; rate: number }
  | { pay_structure: 'share'; rate: number }
);

export type UpdateTeamMemberInput = {
  department_id?: string;
  role_id?: string | null;
  role_label?: string | null;
  name?: string;
  phone?: string | null;
  email?: string | null;
  pay_structure?: PayStructure;
  flat_amount_cents?: number | null;
  flat_period_days?: number | null;
  rate?: number | null;
  start_date?: string | null;
  end_date?: string | null;
};

const SELECT =
  'id, agency_id, department_id, role_id, role_label, name, pay_structure, ' +
  'flat_amount_cents, flat_period_days, rate, phone, email, ' +
  'start_date, end_date, user_id, created_at, updated_at';

// -----------------------------------------------------------------------------
//  listTeamMembers — all active team members in current agency.
//  Filters by the active agency_id explicitly; RLS alone would also return
//  rows from every other agency the user belongs to.
// -----------------------------------------------------------------------------
export async function listTeamMembers(): Promise<TeamMember[]> {
  const agencyId = getActiveAgencyId();
  if (!agencyId) return [];
  const { data, error } = await supabase
    .from('team_members')
    .select(SELECT)
    .eq('agency_id', agencyId)
    .is('deleted_at', null)
    .order('name', { ascending: true });
  if (error) throw error;
  return (data ?? []) as unknown as TeamMember[];
}

// -----------------------------------------------------------------------------
//  listMemberNameMap — id → display name for EVERY team_member in the
//  agency, including ones who have left. A member is considered "former"
//  if either:
//
//      deleted_at IS NOT NULL                              (hard soft-delete)
//   or end_date    IS NOT NULL AND end_date <= today       (employment ended)
//
//  Former members come back as "<name> · former" so that breakdowns showing
//  historical activity make it visually clear which entries belong to
//  someone no longer on the team. Active members come back as just "<name>".
// -----------------------------------------------------------------------------
// -----------------------------------------------------------------------------
//  listMemberDeptMap — id → department_id for EVERY team_member in the
//  agency, including soft-deleted ones. Used by dept-scoped pages so they
//  can still attribute historical transactions to the right department
//  even when the member has been removed from the active roster.
// -----------------------------------------------------------------------------
export async function listMemberDeptMap(): Promise<Map<string, string | null>> {
  const agencyId = getActiveAgencyId();
  if (!agencyId) return new Map();
  const { data, error } = await supabase
    .from('team_members')
    .select('id, department_id')
    .eq('agency_id', agencyId);
  if (error) throw error;
  return new Map(
    (data ?? []).map((r) => [r.id as string, (r.department_id as string | null) ?? null]),
  );
}

export async function listMemberNameMap(): Promise<Map<string, string>> {
  const agencyId = getActiveAgencyId();
  if (!agencyId) return new Map();
  const { data, error } = await supabase
    .from('team_members')
    .select('id, name, deleted_at, end_date')
    .eq('agency_id', agencyId);
  if (error) throw error;

  const todayIso = new Date().toISOString().slice(0, 10);
  return new Map(
    (data ?? []).map((r) => {
      const name = r.name as string;
      const endDate = r.end_date as string | null;
      const isFormer =
        r.deleted_at != null ||
        (endDate != null && endDate <= todayIso);
      return [r.id as string, isFormer ? `${name} · former` : name];
    }),
  );
}

// -----------------------------------------------------------------------------
//  createTeamMember
// -----------------------------------------------------------------------------
export async function createTeamMember(input: CreateTeamMemberInput): Promise<TeamMember> {
  const agencyId = getActiveAgencyId();
  if (!agencyId) throw new Error('No active agency.');

  // Build a single row with the appropriate fields nulled.
  const row: Record<string, unknown> = {
    agency_id: agencyId,
    department_id: input.department_id,
    role_id: input.role_id,
    role_label: input.role_label?.trim() || null,
    name: input.name.trim(),
    phone: input.phone?.trim() || null,
    email: input.email?.trim() || null,
    pay_structure: input.pay_structure,
    flat_amount_cents: input.pay_structure === 'flat' ? input.flat_amount_cents : null,
    flat_period_days:  input.pay_structure === 'flat' ? input.flat_period_days  : null,
    rate:              input.pay_structure === 'flat' ? null : input.rate,
    start_date: input.start_date ?? null,
    end_date:   input.end_date ?? null,
    user_id:    input.user_id ?? null,
  };

  const { data, error } = await supabase
    .from('team_members')
    .insert(row)
    .select(SELECT)
    .single();
  if (error) throw error;
  return data as unknown as TeamMember;
}

// -----------------------------------------------------------------------------
//  updateTeamMember
// -----------------------------------------------------------------------------
export async function updateTeamMember(
  id: string,
  patch: UpdateTeamMemberInput,
): Promise<TeamMember> {
  const cleaned: Record<string, unknown> = {};
  if (patch.department_id !== undefined) cleaned.department_id = patch.department_id;
  if (patch.role_id !== undefined)       cleaned.role_id = patch.role_id;
  if (patch.role_label !== undefined)    cleaned.role_label = patch.role_label?.trim() || null;
  if (patch.name !== undefined)          cleaned.name = patch.name.trim();
  if (patch.phone !== undefined)         cleaned.phone = patch.phone?.trim() || null;
  if (patch.email !== undefined)         cleaned.email = patch.email?.trim() || null;
  if (patch.pay_structure !== undefined) cleaned.pay_structure = patch.pay_structure;
  if (patch.flat_amount_cents !== undefined) cleaned.flat_amount_cents = patch.flat_amount_cents;
  if (patch.flat_period_days !== undefined)  cleaned.flat_period_days = patch.flat_period_days;
  if (patch.rate !== undefined)              cleaned.rate = patch.rate;
  if (patch.start_date !== undefined)        cleaned.start_date = patch.start_date;
  if (patch.end_date !== undefined)          cleaned.end_date = patch.end_date;

  const { data, error } = await supabase
    .from('team_members')
    .update(cleaned)
    .eq('id', id)
    .select(SELECT)
    .single();
  if (error) throw error;
  return data as unknown as TeamMember;
}

// -----------------------------------------------------------------------------
//  softDeleteTeamMember
// -----------------------------------------------------------------------------
export async function softDeleteTeamMember(id: string): Promise<void> {
  const { error } = await supabase
    .from('team_members')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

// -----------------------------------------------------------------------------
//  Display helpers
// -----------------------------------------------------------------------------

// Is this member "former" — i.e. their end_date is set and on/before today?
export function isFormer(m: Pick<TeamMember, 'end_date'>): boolean {
  if (!m.end_date) return false;
  const today = new Date();
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return m.end_date <= todayIso;
}

// Does this member's employment overlap with the given month (YYYY-MM)?
// Used by the OFM page to filter members per the selected month.
export function isActiveInMonth(
  m: Pick<TeamMember, 'start_date' | 'end_date'>,
  monthKey: string,
): boolean {
  const [y, mNum] = monthKey.split('-').map(Number);
  const startOfMonth = `${y}-${String(mNum!).padStart(2, '0')}-01`;
  // Last day of month — using "day 0 of next month" trick.
  const lastDayDate = new Date(y!, mNum!, 0);
  const lastDay = `${y}-${String(mNum!).padStart(2, '0')}-${String(lastDayDate.getDate()).padStart(2, '0')}`;

  // Member's start must be on or before the last day of the month.
  if (m.start_date && m.start_date > lastDay) return false;
  // Member's end must be on or after the first day of the month.
  if (m.end_date && m.end_date < startOfMonth) return false;
  return true;
}

// Format pay info as a readable line for cards.
export function formatPayLine(
  member: TeamMember,
  opts?: { commissionLabel?: string; shareLabel?: string },
): string {
  if (member.pay_structure === 'flat') {
    const dollars = (member.flat_amount_cents ?? 0) / 100;
    const periodDays = member.flat_period_days ?? 7;
    const formatted = `$${dollars.toFixed(2)}`;
    if (periodDays === 7)  return `${formatted} / wk`;
    if (periodDays === 14) return `${formatted} / 2 wk`;
    if (periodDays === 30) return `${formatted} / mo`;
    return `${formatted} / ${periodDays}d`;
  }
  const pct = (member.rate ?? 0) * 100;
  const pctStr = Number.isInteger(pct) ? pct.toFixed(0) : pct.toFixed(1);
  const label =
    member.pay_structure === 'commission'
      ? (opts?.commissionLabel ?? 'commission')
      : (opts?.shareLabel ?? 'share');
  return `${pctStr}% ${label}`;
}
