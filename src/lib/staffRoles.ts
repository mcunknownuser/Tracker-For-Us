// =============================================================================
//  staffRoles.ts
//  Named roles inside each department. Each role has a fixed pay_structure
//  that drives the form when adding team members.
// =============================================================================

import { supabase } from './supabase';
import { getActiveAgencyId } from './agency';

export type PayStructure = 'flat' | 'commission' | 'share';

// User-facing label for a pay structure. 'flat' is shown as 'Wage' since
// that's how the user types it. The DB enum value stays 'flat' though.
export function payStructureLabel(p: PayStructure): string {
  switch (p) {
    case 'flat':       return 'Wage';
    case 'commission': return 'Commission';
    case 'share':      return 'Share';
  }
}

export type StaffRole = {
  id: string;
  agency_id: string;
  department_id: string;
  name: string;
  pay_structure: PayStructure;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

const SELECT =
  'id, agency_id, department_id, name, pay_structure, sort_order, created_at, updated_at';

export async function listStaffRoles(): Promise<StaffRole[]> {
  // Filter by active agency — RLS alone returns roles from every agency
  // the user belongs to, which causes duplicates in the UI.
  const agencyId = getActiveAgencyId();
  if (!agencyId) return [];
  const { data, error } = await supabase
    .from('staff_roles')
    .select(SELECT)
    .eq('agency_id', agencyId)
    .is('deleted_at', null)
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return (data ?? []) as StaffRole[];
}

export async function createStaffRole(input: {
  department_id: string;
  name: string;
  pay_structure: PayStructure;
}): Promise<StaffRole> {
  const agencyId = getActiveAgencyId();
  if (!agencyId) throw new Error('No active agency.');

  // Bottom of the department's list.
  const { data: existing } = await supabase
    .from('staff_roles')
    .select('sort_order')
    .eq('department_id', input.department_id)
    .order('sort_order', { ascending: false })
    .limit(1);
  const nextSort = (existing?.[0]?.sort_order ?? -1) + 1;

  const { data, error } = await supabase
    .from('staff_roles')
    .insert({
      agency_id: agencyId,
      department_id: input.department_id,
      name: input.name.trim(),
      pay_structure: input.pay_structure,
      sort_order: nextSort,
    })
    .select(SELECT)
    .single();
  if (error) throw error;
  return data as StaffRole;
}

export async function updateStaffRole(
  id: string,
  patch: { name?: string; pay_structure?: PayStructure; department_id?: string },
): Promise<StaffRole> {
  const cleaned: Record<string, unknown> = {};
  if (patch.name !== undefined) cleaned.name = patch.name.trim();
  if (patch.pay_structure !== undefined) cleaned.pay_structure = patch.pay_structure;
  if (patch.department_id !== undefined) cleaned.department_id = patch.department_id;

  const { data, error } = await supabase
    .from('staff_roles')
    .update(cleaned)
    .eq('id', id)
    .select(SELECT)
    .single();
  if (error) throw error;
  return data as StaffRole;
}

export async function softDeleteStaffRole(id: string): Promise<void> {
  const { error } = await supabase
    .from('staff_roles')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}
