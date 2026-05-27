// =============================================================================
//  expenses.ts
//  CRUD for the expenses table. Always RLS-scoped to the current agency.
// =============================================================================

import { supabase } from './supabase';
import { getActiveAgencyId } from './agency';

export type RecurrenceKind = 'weekly' | 'biweekly' | 'monthly' | 'yearly';

export type Expense = {
  id: string;
  agency_id: string;
  name: string;
  amount_cents: number;
  incurred_on: string; // YYYY-MM-DD
  category_id: string | null;
  payment_method_id: string | null;
  note: string | null;
  is_recurring: boolean;
  recurrence_kind: RecurrenceKind | null;
  next_due_on: string | null; // YYYY-MM-DD, only on the head of a recurring stream
  created_at: string;
  updated_at: string;
};

export type CreateExpenseInput = {
  name: string;
  amount_cents: number;
  incurred_on: string;
  category_id: string | null;
  payment_method_id: string | null;
  note?: string | null;
  is_recurring?: boolean;
  recurrence_kind?: RecurrenceKind | null;
  next_due_on?: string | null;
};

export type UpdateExpenseInput = Partial<CreateExpenseInput>;

const SELECT =
  'id, agency_id, name, amount_cents, incurred_on, category_id, payment_method_id, note, is_recurring, recurrence_kind, next_due_on, created_at, updated_at';

export async function listExpenses(): Promise<Expense[]> {
  const agencyId = getActiveAgencyId();
  if (!agencyId) return [];
  const { data, error } = await supabase
    .from('expenses')
    .select(SELECT)
    .eq('agency_id', agencyId)
    .is('deleted_at', null)
    .order('incurred_on', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as Expense[];
}

export async function createExpense(input: CreateExpenseInput): Promise<Expense> {
  const agencyId = getActiveAgencyId();
  if (!agencyId) throw new Error('No active agency.');

  const isRecurring = input.is_recurring ?? false;
  const recurrenceKind = isRecurring ? input.recurrence_kind ?? null : null;
  // If recurring and no next_due_on supplied, compute it from incurred_on.
  const nextDueOn = recurrenceKind
    ? input.next_due_on ?? calcNextDue(input.incurred_on, recurrenceKind)
    : null;

  const { data, error } = await supabase
    .from('expenses')
    .insert({
      agency_id: agencyId,
      name: input.name.trim(),
      amount_cents: input.amount_cents,
      incurred_on: input.incurred_on,
      category_id: input.category_id,
      payment_method_id: input.payment_method_id,
      note: input.note?.trim() || null,
      is_recurring: isRecurring,
      recurrence_kind: recurrenceKind,
      next_due_on: nextDueOn,
    })
    .select(SELECT)
    .single();
  if (error) throw error;
  return data as Expense;
}

export async function updateExpense(
  id: string,
  patch: UpdateExpenseInput,
): Promise<Expense> {
  const cleaned: Record<string, unknown> = {};
  if (patch.name !== undefined) cleaned.name = patch.name.trim();
  if (patch.amount_cents !== undefined) cleaned.amount_cents = patch.amount_cents;
  if (patch.incurred_on !== undefined) cleaned.incurred_on = patch.incurred_on;
  if (patch.category_id !== undefined) cleaned.category_id = patch.category_id;
  if (patch.payment_method_id !== undefined)
    cleaned.payment_method_id = patch.payment_method_id;
  if (patch.note !== undefined) cleaned.note = patch.note?.trim() || null;
  if (patch.is_recurring !== undefined) cleaned.is_recurring = patch.is_recurring;
  if (patch.recurrence_kind !== undefined) cleaned.recurrence_kind = patch.recurrence_kind;
  if (patch.next_due_on !== undefined) cleaned.next_due_on = patch.next_due_on;

  const { data, error } = await supabase
    .from('expenses')
    .update(cleaned)
    .eq('id', id)
    .select(SELECT)
    .single();
  if (error) throw error;
  return data as Expense;
}

export async function softDeleteExpense(id: string): Promise<void> {
  const { error } = await supabase
    .from('expenses')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

// -----------------------------------------------------------------------------
//  Helpers
// -----------------------------------------------------------------------------

// Returns the "YYYY-MM" key for grouping expenses by month.
export function monthKey(date: string): string {
  return date.slice(0, 7);
}

// Returns a long-form month label for a YYYY-MM key.
export function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y!, (m! - 1));
  return d.toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

// -----------------------------------------------------------------------------
//  Recurrence helpers
// -----------------------------------------------------------------------------

// Compute the next due date for a recurring expense, given the most recent
// occurrence date and the recurrence kind. Returns YYYY-MM-DD.
export function calcNextDue(fromIso: string, kind: RecurrenceKind): string {
  const [y, m, d] = fromIso.split('-').map(Number);
  const date = new Date(y!, m! - 1, d!);
  switch (kind) {
    case 'weekly':
      date.setDate(date.getDate() + 7);
      break;
    case 'biweekly':
      date.setDate(date.getDate() + 14);
      break;
    case 'monthly':
      addMonthsCapped(date, 1);
      break;
    case 'yearly':
      addMonthsCapped(date, 12);
      break;
  }
  return formatISO(date);
}

// In-place month addition that caps the day at the last day of the target month.
// E.g. Jan 31 + 1 month -> Feb 28 (or 29 in leap years).
function addMonthsCapped(date: Date, months: number): void {
  const targetMonth = date.getMonth() + months;
  const originalDay = date.getDate();
  // Set to day 1 first to avoid month overflow, then jump to target month.
  date.setDate(1);
  date.setMonth(targetMonth);
  // Cap day at end-of-target-month.
  const lastDayOfTarget = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(originalDay, lastDayOfTarget));
}

function formatISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Returns today's date as YYYY-MM-DD (local time).
function todayISO(): string {
  return formatISO(new Date());
}

// -----------------------------------------------------------------------------
//  listDueRecurring — recurring expenses whose next_due_on is today or earlier.
//  These are the heads that the "Due now" banner shows.
// -----------------------------------------------------------------------------
export async function listDueRecurring(): Promise<Expense[]> {
  const agencyId = getActiveAgencyId();
  if (!agencyId) return [];
  const { data, error } = await supabase
    .from('expenses')
    .select(SELECT)
    .eq('agency_id', agencyId)
    .is('deleted_at', null)
    .not('next_due_on', 'is', null)
    .lte('next_due_on', todayISO())
    .order('next_due_on', { ascending: true });
  if (error) throw error;
  return (data ?? []) as Expense[];
}

// -----------------------------------------------------------------------------
//  logNextOccurrence — user clicks "Log it" on the banner.
//  Creates a new expense row dated next_due_on, advances the head, and
//  clears next_due_on on the previous head so it stops appearing as due.
// -----------------------------------------------------------------------------
export async function logNextOccurrence(head: Expense): Promise<Expense> {
  if (!head.recurrence_kind || !head.next_due_on) {
    throw new Error('Not a recurring expense head.');
  }
  const occurrenceDate = head.next_due_on;
  const nextAfter = calcNextDue(occurrenceDate, head.recurrence_kind);

  // 1. Create the new occurrence as the new head.
  const created = await createExpense({
    name: head.name,
    amount_cents: head.amount_cents,
    incurred_on: occurrenceDate,
    category_id: head.category_id,
    payment_method_id: head.payment_method_id,
    note: head.note,
    is_recurring: true,
    recurrence_kind: head.recurrence_kind,
    next_due_on: nextAfter,
  });

  // 2. Clear next_due_on on the previous head so it stops appearing as due.
  const { error } = await supabase
    .from('expenses')
    .update({ next_due_on: null })
    .eq('id', head.id);
  if (error) throw error;

  return created;
}

// -----------------------------------------------------------------------------
//  stopRecurring — user clicks "Stop recurring" on the banner.
//  Clears the recurrence fields on the head so it stops generating new
//  occurrences. The historical rows remain untouched.
// -----------------------------------------------------------------------------
export async function stopRecurring(head: Expense): Promise<void> {
  const { error } = await supabase
    .from('expenses')
    .update({
      is_recurring: false,
      recurrence_kind: null,
      next_due_on: null,
    })
    .eq('id', head.id);
  if (error) throw error;
}

// -----------------------------------------------------------------------------
//  skipNextOccurrence — user clicks "Skip" on the banner.
//  Advances the head's next_due_on by one period without creating a row.
// -----------------------------------------------------------------------------
export async function skipNextOccurrence(head: Expense): Promise<void> {
  if (!head.recurrence_kind || !head.next_due_on) {
    throw new Error('Not a recurring expense head.');
  }
  const nextAfter = calcNextDue(head.next_due_on, head.recurrence_kind);
  const { error } = await supabase
    .from('expenses')
    .update({ next_due_on: nextAfter })
    .eq('id', head.id);
  if (error) throw error;
}
