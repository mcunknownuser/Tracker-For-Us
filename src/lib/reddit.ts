// =============================================================================
//  reddit.ts
//  Reddit accounts CRUD + monthly income tracking. Payments to Reddit VAs
//  go through the unified payments table (see ofm.ts createPayment).
// =============================================================================

import { supabase } from './supabase';
import { getActiveAgencyId } from './agency';
import type { TeamMember } from './teamMembers';
import type { Payment } from './ofm';
import { monthRange } from './ofm';

// =============================================================================
//  Types
// =============================================================================
export type RedditAccount = {
  id: string;
  agency_id: string;
  label: string;
  client_notes: string | null;
  team_member_id: string | null;
  created_at: string;
  updated_at: string;
};

export type RedditAccountIncome = {
  id: string;
  agency_id: string;
  account_id: string;
  amount_cents: number;
  month_start: string; // YYYY-MM-01
  created_at: string;
};

const ACCOUNT_COLS =
  'id, agency_id, label, client_notes, team_member_id, created_at, updated_at';
const INCOME_COLS =
  'id, agency_id, account_id, amount_cents, month_start, created_at';

// =============================================================================
//  Accounts
// =============================================================================
export async function listAccounts(): Promise<RedditAccount[]> {
  const agencyId = getActiveAgencyId();
  if (!agencyId) return [];
  const { data, error } = await supabase
    .from('reddit_accounts')
    .select(ACCOUNT_COLS)
    .eq('agency_id', agencyId)
    .is('deleted_at', null)
    .order('label', { ascending: true });
  if (error) throw error;
  return (data ?? []) as RedditAccount[];
}

// Includes soft-deleted accounts. Used wherever we need to resolve a
// label/VA assignment for income rows whose underlying account was
// later removed — so the UI can still show "juicy · Run by xo" instead
// of "Unknown · Unassigned" for historical entries.
export async function listAllAccountsIncludingDeleted(): Promise<RedditAccount[]> {
  const agencyId = getActiveAgencyId();
  if (!agencyId) return [];
  const { data, error } = await supabase
    .from('reddit_accounts')
    .select(ACCOUNT_COLS)
    .eq('agency_id', agencyId)
    .order('label', { ascending: true });
  if (error) throw error;
  return (data ?? []) as RedditAccount[];
}

export async function createAccount(input: {
  label: string;
  team_member_id: string | null;
  client_notes?: string | null;
}): Promise<RedditAccount> {
  const agencyId = getActiveAgencyId();
  if (!agencyId) throw new Error('No active agency.');
  const { data, error } = await supabase
    .from('reddit_accounts')
    .insert({
      agency_id: agencyId,
      label: input.label.trim(),
      team_member_id: input.team_member_id,
      client_notes: input.client_notes?.trim() || null,
    })
    .select(ACCOUNT_COLS)
    .single();
  if (error) throw error;
  return data as RedditAccount;
}

export async function updateAccount(
  id: string,
  patch: { label?: string; team_member_id?: string | null; client_notes?: string | null },
): Promise<RedditAccount> {
  const cleaned: Record<string, unknown> = {};
  if (patch.label !== undefined) cleaned.label = patch.label.trim();
  if (patch.team_member_id !== undefined) cleaned.team_member_id = patch.team_member_id;
  if (patch.client_notes !== undefined) cleaned.client_notes = patch.client_notes?.trim() || null;
  const { data, error } = await supabase
    .from('reddit_accounts')
    .update(cleaned)
    .eq('id', id)
    .select(ACCOUNT_COLS)
    .single();
  if (error) throw error;
  return data as RedditAccount;
}

export async function softDeleteAccount(id: string): Promise<void> {
  const { error } = await supabase
    .from('reddit_accounts')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

// =============================================================================
//  Monthly income
// =============================================================================

// monthKey: YYYY-MM. Returns one row per account that has income this month.
export async function listIncomeForMonth(monthKey: string): Promise<RedditAccountIncome[]> {
  const agencyId = getActiveAgencyId();
  if (!agencyId) return [];
  const [start] = monthRange(monthKey);
  const { data, error } = await supabase
    .from('reddit_account_income')
    .select(INCOME_COLS)
    .eq('agency_id', agencyId)
    .eq('month_start', start);
  if (error) throw error;
  return (data ?? []) as RedditAccountIncome[];
}

// Upsert income for (account, month). amountCents = 0 deletes the row so
// the unique constraint stays clean. Returns the new row, or null on delete.
export async function setIncome(
  accountId: string,
  monthKey: string,
  amountCents: number,
): Promise<RedditAccountIncome | null> {
  const agencyId = getActiveAgencyId();
  if (!agencyId) throw new Error('No active agency.');
  const [monthStart] = monthRange(monthKey);

  if (amountCents <= 0) {
    const { error } = await supabase
      .from('reddit_account_income')
      .delete()
      .eq('account_id', accountId)
      .eq('month_start', monthStart);
    if (error) throw error;
    return null;
  }

  const { data, error } = await supabase
    .from('reddit_account_income')
    .upsert(
      {
        agency_id: agencyId,
        account_id: accountId,
        amount_cents: amountCents,
        month_start: monthStart,
      },
      { onConflict: 'account_id,month_start' },
    )
    .select(INCOME_COLS)
    .single();
  if (error) throw error;
  return data as RedditAccountIncome;
}

// =============================================================================
//  Per-VA aggregation
// =============================================================================
export type VASummary = {
  member: TeamMember;
  accounts: RedditAccount[];
  incomeCents: number;   // sum of income across this VA's accounts this month
  paidCents: number;     // money paid to this VA this month
  earnedCents: number;   // what they accrued this month per their pay structure
  owedCents: number;     // max(earned - paid, 0)
};

// Build per-VA rollups. Only includes members who have at least one assigned
// Reddit account — other team members aren't relevant on this page.
export function buildVASummaries(
  accounts: RedditAccount[],
  incomes: RedditAccountIncome[],
  members: TeamMember[],
  payments: Payment[],
  _monthKey: string,
): VASummary[] {
  const incomeByAccount = new Map<string, number>();
  for (const i of incomes) incomeByAccount.set(i.account_id, i.amount_cents);

  const paidByMember = new Map<string, number>();
  for (const p of payments) {
    paidByMember.set(p.team_member_id, (paidByMember.get(p.team_member_id) ?? 0) + p.amount_cents);
  }

  // Group accounts by VA.
  const accountsByVA = new Map<string, RedditAccount[]>();
  for (const a of accounts) {
    if (!a.team_member_id) continue;
    const list = accountsByVA.get(a.team_member_id) ?? [];
    list.push(a);
    accountsByVA.set(a.team_member_id, list);
  }

  const out: VASummary[] = [];
  for (const [memberId, accts] of accountsByVA.entries()) {
    const member = members.find((m) => m.id === memberId);
    if (!member) continue;
    const incomeCents = accts.reduce(
      (n, a) => n + (incomeByAccount.get(a.id) ?? 0),
      0,
    );
    const paidCents = paidByMember.get(memberId) ?? 0;
    const earnedCents = earnedForMember(member, incomeCents);
    const owedCents = Math.max(0, earnedCents - paidCents);
    out.push({ member, accounts: accts, incomeCents, paidCents, earnedCents, owedCents });
  }
  // Sort by income desc so the highest-earning VAs surface first.
  out.sort((a, b) => b.incomeCents - a.incomeCents);
  return out;
}

// What did this VA accrue this month?
//
//   flat        - the usual prorated wage (e.g. $X every 7 days = 4 per month).
//   commission  - rate% of their account income for the month.
//   share       - same as commission on the marketing side. Both modes
//                 collapse to "% of income" because there's no separate
//                 sales-vs-withdrawals distinction here.
function earnedForMember(m: TeamMember, incomeCents: number): number {
  if (m.pay_structure === 'flat') {
    const period = m.flat_period_days ?? 0;
    const amount = m.flat_amount_cents ?? 0;
    if (period <= 0) return 0;
    let perMonth: number;
    if (period === 7) perMonth = 4;
    else if (period === 14) perMonth = 2;
    else if (period === 30) perMonth = 1;
    else if (period >= 360) perMonth = 1 / 12;
    else perMonth = 30 / period;
    return Math.round(amount * perMonth);
  }
  // commission and share both mean "rate% of this VA's income this month".
  return Math.round(incomeCents * (m.rate ?? 0));
}
