// =============================================================================
//  audit.ts
//  Tamper-evidence trail for money changes. Every payment create/edit/delete
//  writes a row here (who, when, before → after) so payouts are auditable,
//  not just displayed.
//
//  Best-effort: a failed audit write must never block the user's action, so
//  callers fire-and-forget and we swallow errors here.
// =============================================================================
import { supabase } from './supabase';
import { getActiveAgencyId } from './agency';

export type AuditEntry = {
  id: string;
  entity_type: string;
  entity_id: string | null;
  action: 'create' | 'update' | 'delete';
  description: string | null;
  prev_value: unknown;
  next_value: unknown;
  user_id: string | null;
  created_at: string;
};

export async function logAudit(input: {
  entityType: string;
  entityId: string;
  action: 'create' | 'update' | 'delete';
  description?: string | null;
  prev?: unknown;
  next?: unknown;
}): Promise<void> {
  try {
    const agencyId = getActiveAgencyId();
    if (!agencyId) return;
    const { data: userResp } = await supabase.auth.getUser();
    await supabase.from('audit_log').insert({
      agency_id: agencyId,
      user_id: userResp.user?.id ?? null,
      entity_type: input.entityType,
      entity_id: input.entityId,
      action: input.action,
      description: input.description ?? null,
      prev_value: input.prev ?? null,
      next_value: input.next ?? null,
    });
  } catch {
    // Never let audit logging break the underlying action.
  }
}

const AUDIT_COLS =
  'id, entity_type, entity_id, action, description, prev_value, next_value, user_id, created_at';

// All audit entries for one entity (e.g. a payment), newest first.
export async function listAuditFor(
  entityType: string,
  entityId: string,
): Promise<AuditEntry[]> {
  const agencyId = getActiveAgencyId();
  if (!agencyId) return [];
  const { data, error } = await supabase
    .from('audit_log')
    .select(AUDIT_COLS)
    .eq('agency_id', agencyId)
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as AuditEntry[];
}

// Every payment change event for one team member (across all their payments),
// newest first. Powers the change-log view in the ledger.
export async function listMemberPaymentAudit(memberId: string): Promise<AuditEntry[]> {
  const agencyId = getActiveAgencyId();
  if (!agencyId) return [];
  const { data: pays } = await supabase
    .from('payments')
    .select('id')
    .eq('agency_id', agencyId)
    .eq('team_member_id', memberId);
  const ids = (pays ?? []).map((p) => p.id);
  if (ids.length === 0) return [];
  const { data, error } = await supabase
    .from('audit_log')
    .select(AUDIT_COLS)
    .eq('agency_id', agencyId)
    .eq('entity_type', 'payment')
    .in('entity_id', ids)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as AuditEntry[];
}
