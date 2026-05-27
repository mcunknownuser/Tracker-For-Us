// =============================================================================
//  expenseCategories.ts
//  User-editable buckets for organizing expenses (Subscriptions, Misc, etc.).
// =============================================================================

import { supabase } from './supabase';
import { getActiveAgencyId } from './agency';

export type ExpenseCategory = {
  id: string;
  agency_id: string;
  name: string;
  color: string;
  sort_order: number;
  created_at: string;
};

const SELECT = 'id, agency_id, name, color, sort_order, created_at';

export async function listExpenseCategories(): Promise<ExpenseCategory[]> {
  const agencyId = getActiveAgencyId();
  if (!agencyId) return [];
  const { data, error } = await supabase
    .from('expense_categories')
    .select(SELECT)
    .eq('agency_id', agencyId)
    .is('deleted_at', null)
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return (data ?? []) as ExpenseCategory[];
}

export async function createExpenseCategory(input: {
  name: string;
  color?: string;
}): Promise<ExpenseCategory> {
  const agencyId = getActiveAgencyId();
  if (!agencyId) throw new Error('No active agency.');

  const { data: existing } = await supabase
    .from('expense_categories')
    .select('sort_order')
    .eq('agency_id', agencyId)
    .order('sort_order', { ascending: false })
    .limit(1);
  const nextSort = (existing?.[0]?.sort_order ?? -1) + 1;

  const { data, error } = await supabase
    .from('expense_categories')
    .insert({
      agency_id: agencyId,
      name: input.name.trim(),
      color: input.color ?? '#6366f1',
      sort_order: nextSort,
    })
    .select(SELECT)
    .single();
  if (error) throw error;
  return data as ExpenseCategory;
}

export async function updateExpenseCategory(
  id: string,
  patch: { name?: string; color?: string },
): Promise<ExpenseCategory> {
  const cleaned: Record<string, unknown> = {};
  if (patch.name !== undefined) cleaned.name = patch.name.trim();
  if (patch.color !== undefined) cleaned.color = patch.color;

  const { data, error } = await supabase
    .from('expense_categories')
    .update(cleaned)
    .eq('id', id)
    .select(SELECT)
    .single();
  if (error) throw error;
  return data as ExpenseCategory;
}

export async function softDeleteExpenseCategory(id: string): Promise<void> {
  const { error } = await supabase
    .from('expense_categories')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}
