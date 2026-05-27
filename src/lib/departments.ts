// =============================================================================
//  departments.ts
//  User-editable departments. Each agency has its own list.
// =============================================================================

import { supabase } from './supabase';
import { getActiveAgencyId } from './agency';

// Broadcast that the departments list changed (created/renamed/deleted) so
// the Sidebar and any other listeners can re-fetch. No-op outside a browser.
function notifyDepartmentsChanged() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('voltrisai:departments-changed'));
}

// Each department is one of two layouts. The layout determines which page
// format the department's tab uses:
//   models    — chatter sales + model withdrawals
//   marketing — accounts + monthly income
export type DepartmentLayout = 'models' | 'marketing';

export type Department = {
  id: string;
  agency_id: string;
  name: string;
  layout_type: DepartmentLayout;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

const SELECT =
  'id, agency_id, name, layout_type, sort_order, created_at, updated_at';

export async function listDepartments(): Promise<Department[]> {
  // Always filter by the active agency. RLS would let us see departments
  // in *any* agency we're a member of, which causes duplicates in the UI
  // when a user belongs to more than one agency.
  const agencyId = getActiveAgencyId();
  if (!agencyId) return [];
  const { data, error } = await supabase
    .from('departments')
    .select(SELECT)
    .eq('agency_id', agencyId)
    .is('deleted_at', null)
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return (data ?? []) as Department[];
}

export async function createDepartment(
  name: string,
  layoutType: DepartmentLayout = 'models',
): Promise<Department> {
  const agencyId = getActiveAgencyId();
  if (!agencyId) throw new Error('No active agency.');

  // Place new departments at the bottom.
  const { data: existing } = await supabase
    .from('departments')
    .select('sort_order')
    .eq('agency_id', agencyId)
    .order('sort_order', { ascending: false })
    .limit(1);
  const nextSort = (existing?.[0]?.sort_order ?? -1) + 1;

  const { data, error } = await supabase
    .from('departments')
    .insert({
      agency_id: agencyId,
      name: name.trim(),
      layout_type: layoutType,
      sort_order: nextSort,
    })
    .select(SELECT)
    .single();
  if (error) throw error;
  notifyDepartmentsChanged();
  return data as Department;
}

export async function updateDepartment(
  id: string,
  patch: { name?: string; layout_type?: DepartmentLayout },
): Promise<Department> {
  const cleaned: Record<string, unknown> = {};
  if (patch.name !== undefined) cleaned.name = patch.name.trim();
  if (patch.layout_type !== undefined) cleaned.layout_type = patch.layout_type;

  const { data, error } = await supabase
    .from('departments')
    .update(cleaned)
    .eq('id', id)
    .select(SELECT)
    .single();
  if (error) throw error;
  notifyDepartmentsChanged();
  return data as Department;
}

export async function softDeleteDepartment(id: string): Promise<void> {
  // The DB has on delete restrict for team_members.department_id, so
  // deleting a department that still has members will fail. Soft-delete
  // sidesteps that by setting deleted_at instead.
  const { error } = await supabase
    .from('departments')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
  notifyDepartmentsChanged();
}
