// =============================================================================
//  ofm.ts
//  Sales + withdrawals + payments queries, plus per-member monthly summary.
// =============================================================================

import { supabase } from './supabase';
import { getActiveAgencyId } from './agency';
import type { TeamMember } from './teamMembers';

// =============================================================================
//  Types
// =============================================================================

export type ChatterSale = {
  id: string;
  agency_id: string;
  team_member_id: string;
  amount_cents: number;
  description: string | null;
  occurred_on: string; // YYYY-MM-DD
  created_at: string;
};

export type ModelWithdrawal = {
  id: string;
  agency_id: string;
  team_member_id: string;
  amount_cents: number;
  description: string | null;
  occurred_on: string;
  created_at: string;
};

export type Payment = {
  id: string;
  agency_id: string;
  team_member_id: string;
  amount_cents: number;
  note: string | null;
  paid_on: string;
  created_at: string;
};

// =============================================================================
//  Sales (chatter_sales)
// =============================================================================
const SALE_COLS =
  'id, agency_id, team_member_id, amount_cents, description, occurred_on, created_at';

export async function listSales(monthKey: string): Promise<ChatterSale[]> {
  const agencyId = getActiveAgencyId();
  if (!agencyId) return [];
  const [start, endExclusive] = monthRange(monthKey);
  const { data, error } = await supabase
    .from('chatter_sales')
    .select(SALE_COLS)
    .eq('agency_id', agencyId)
    .is('deleted_at', null)
    .gte('occurred_on', start)
    .lt('occurred_on', endExclusive)
    .order('occurred_on', { ascending: false });
  if (error) throw error;
  return (data ?? []) as ChatterSale[];
}

export async function createSale(input: {
  team_member_id: string;
  amount_cents: number;
  occurred_on: string;
  description?: string | null;
}): Promise<ChatterSale> {
  const agencyId = getActiveAgencyId();
  if (!agencyId) throw new Error('No active agency.');
  const { data, error } = await supabase
    .from('chatter_sales')
    .insert({
      agency_id: agencyId,
      team_member_id: input.team_member_id,
      amount_cents: input.amount_cents,
      occurred_on: input.occurred_on,
      description: input.description?.trim() || null,
    })
    .select(SALE_COLS)
    .single();
  if (error) throw error;
  return data as ChatterSale;
}

export async function updateSale(
  id: string,
  patch: { amount_cents?: number; occurred_on?: string; description?: string | null },
): Promise<ChatterSale> {
  const cleaned: Record<string, unknown> = {};
  if (patch.amount_cents !== undefined) cleaned.amount_cents = patch.amount_cents;
  if (patch.occurred_on !== undefined) cleaned.occurred_on = patch.occurred_on;
  if (patch.description !== undefined) cleaned.description = patch.description?.trim() || null;
  const { data, error } = await supabase
    .from('chatter_sales')
    .update(cleaned)
    .eq('id', id)
    .select(SALE_COLS)
    .single();
  if (error) throw error;
  return data as ChatterSale;
}

export async function softDeleteSale(id: string): Promise<void> {
  const { error } = await supabase
    .from('chatter_sales')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

// =============================================================================
//  Withdrawals (model_withdrawals)
// =============================================================================
const WD_COLS =
  'id, agency_id, team_member_id, amount_cents, description, occurred_on, created_at';

export async function listWithdrawals(monthKey: string): Promise<ModelWithdrawal[]> {
  const agencyId = getActiveAgencyId();
  if (!agencyId) return [];
  const [start, endExclusive] = monthRange(monthKey);
  const { data, error } = await supabase
    .from('model_withdrawals')
    .select(WD_COLS)
    .eq('agency_id', agencyId)
    .is('deleted_at', null)
    .gte('occurred_on', start)
    .lt('occurred_on', endExclusive)
    .order('occurred_on', { ascending: false });
  if (error) throw error;
  return (data ?? []) as ModelWithdrawal[];
}

export async function createWithdrawal(input: {
  team_member_id: string;
  amount_cents: number;
  occurred_on: string;
  description?: string | null;
}): Promise<ModelWithdrawal> {
  const agencyId = getActiveAgencyId();
  if (!agencyId) throw new Error('No active agency.');
  const { data, error } = await supabase
    .from('model_withdrawals')
    .insert({
      agency_id: agencyId,
      team_member_id: input.team_member_id,
      amount_cents: input.amount_cents,
      occurred_on: input.occurred_on,
      description: input.description?.trim() || null,
    })
    .select(WD_COLS)
    .single();
  if (error) throw error;
  return data as ModelWithdrawal;
}

export async function updateWithdrawal(
  id: string,
  patch: { amount_cents?: number; occurred_on?: string; description?: string | null },
): Promise<ModelWithdrawal> {
  const cleaned: Record<string, unknown> = {};
  if (patch.amount_cents !== undefined) cleaned.amount_cents = patch.amount_cents;
  if (patch.occurred_on !== undefined) cleaned.occurred_on = patch.occurred_on;
  if (patch.description !== undefined) cleaned.description = patch.description?.trim() || null;
  const { data, error } = await supabase
    .from('model_withdrawals')
    .update(cleaned)
    .eq('id', id)
    .select(WD_COLS)
    .single();
  if (error) throw error;
  return data as ModelWithdrawal;
}

export async function softDeleteWithdrawal(id: string): Promise<void> {
  const { error } = await supabase
    .from('model_withdrawals')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

// =============================================================================
//  Payments (paying anyone)
// =============================================================================
const PAY_COLS =
  'id, agency_id, team_member_id, amount_cents, note, paid_on, created_at';

export async function listPayments(monthKey: string): Promise<Payment[]> {
  const agencyId = getActiveAgencyId();
  if (!agencyId) return [];
  const [start, endExclusive] = monthRange(monthKey);
  const { data, error } = await supabase
    .from('payments')
    .select(PAY_COLS)
    .eq('agency_id', agencyId)
    .is('deleted_at', null)
    .gte('paid_on', start)
    .lt('paid_on', endExclusive)
    .order('paid_on', { ascending: false });
  if (error) throw error;
  return (data ?? []) as Payment[];
}

export async function createPayment(input: {
  team_member_id: string;
  amount_cents: number;
  paid_on: string;
  note?: string | null;
}): Promise<Payment> {
  const agencyId = getActiveAgencyId();
  if (!agencyId) throw new Error('No active agency.');
  const { data, error } = await supabase
    .from('payments')
    .insert({
      agency_id: agencyId,
      team_member_id: input.team_member_id,
      amount_cents: input.amount_cents,
      paid_on: input.paid_on,
      note: input.note?.trim() || null,
      client_ref: crypto.randomUUID(),
    })
    .select(PAY_COLS)
    .single();
  if (error) throw error;
  return data as Payment;
}

export async function updatePayment(
  id: string,
  patch: { amount_cents?: number; paid_on?: string; note?: string | null },
): Promise<Payment> {
  const cleaned: Record<string, unknown> = {};
  if (patch.amount_cents !== undefined) cleaned.amount_cents = patch.amount_cents;
  if (patch.paid_on !== undefined) cleaned.paid_on = patch.paid_on;
  if (patch.note !== undefined) cleaned.note = patch.note?.trim() || null;
  const { data, error } = await supabase
    .from('payments')
    .update(cleaned)
    .eq('id', id)
    .select(PAY_COLS)
    .single();
  if (error) throw error;
  return data as Payment;
}

export async function softDeletePayment(id: string): Promise<void> {
  const { error } = await supabase
    .from('payments')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

// =============================================================================
//  Per-member monthly summary
// =============================================================================
export type MemberSummary = {
  member: TeamMember;
  // For commission members: gross sales attributed this month.
  salesCents: number;
  // For share members: gross withdrawals this month.
  withdrawalsCents: number;
  // What they earned (commission/share %, or flat × periods in the month).
  earnedCents: number;
  // What we've paid them this month.
  paidCents: number;
  // What's outstanding (earned − paid; never negative).
  owedCents: number;
};

export function buildSummaries(
  members: TeamMember[],
  sales: ChatterSale[],
  withdrawals: ModelWithdrawal[],
  payments: Payment[],
  _monthKey: string,
): MemberSummary[] {
  // Pre-aggregate by team_member_id.
  const salesByMember = sumBy(sales, (s) => s.team_member_id, (s) => s.amount_cents);
  const wdByMember = sumBy(withdrawals, (w) => w.team_member_id, (w) => w.amount_cents);
  const paidByMember = sumBy(payments, (p) => p.team_member_id, (p) => p.amount_cents);

  return members.map((m) => {
    const salesCents = salesByMember.get(m.id) ?? 0;
    const withdrawalsCents = wdByMember.get(m.id) ?? 0;
    const paidCents = paidByMember.get(m.id) ?? 0;

    let earnedCents = 0;
    if (m.pay_structure === 'commission') {
      earnedCents = Math.round(salesCents * (m.rate ?? 0));
    } else if (m.pay_structure === 'share') {
      earnedCents = Math.round(withdrawalsCents * (m.rate ?? 0));
    } else if (m.pay_structure === 'flat') {
      // Standard payroll convention: a month contains a fixed number of
      // periods regardless of calendar drift.
      //   weekly  -> 4 periods/month
      //   biweekly -> 2 periods/month
      //   monthly -> 1 period/month
      //   yearly  -> 1/12 of a year
      //   custom  -> prorate as (30 / period_days)
      const period = m.flat_period_days ?? 0;
      const amount = m.flat_amount_cents ?? 0;
      if (period > 0) {
        let perMonth: number;
        if (period === 7) perMonth = 4;
        else if (period === 14) perMonth = 2;
        else if (period === 30) perMonth = 1;
        else if (period >= 360) perMonth = 1 / 12;
        else perMonth = 30 / period;
        earnedCents = Math.round(amount * perMonth);
      }
    }

    const owedCents = Math.max(0, earnedCents - paidCents);

    return {
      member: m,
      salesCents,
      withdrawalsCents,
      earnedCents,
      paidCents,
      owedCents,
    };
  });
}

// =============================================================================
//  Helpers
// =============================================================================

// monthKey: YYYY-MM string.
export function monthRange(monthKey: string): [string, string] {
  // [first day of month, first day of next month)
  const [y, m] = monthKey.split('-').map(Number);
  const startDate = new Date(y!, (m! - 1), 1);
  const endDate = new Date(y!, m!, 1);
  return [isoDate(startDate), isoDate(endDate)];
}

export function lengthOfMonth(monthKey: string): number {
  const [y, m] = monthKey.split('-').map(Number);
  return new Date(y!, m!, 0).getDate(); // day 0 of next month = last day of this month
}

export function currentMonthKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function shiftMonthKey(key: string, delta: number): string {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y!, (m! - 1) + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function monthLongLabel(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return new Date(y!, m! - 1, 1).toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
  });
}

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function sumBy<T>(
  arr: T[],
  keyFn: (t: T) => string,
  valFn: (t: T) => number,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of arr) {
    const k = keyFn(item);
    out.set(k, (out.get(k) ?? 0) + valFn(item));
  }
  return out;
}
