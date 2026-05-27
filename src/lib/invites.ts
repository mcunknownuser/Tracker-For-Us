// =============================================================================
//  invites.ts
//  Client helpers for the agency_invite flow. Wraps the SECURITY DEFINER
//  RPCs in migration 0016 + a direct list/delete via RLS for admin views.
// =============================================================================

import { supabase } from './supabase';

export type AgencyRole = 'admin' | 'staff';

// Mirrors the agency_invite table row that the RPCs return.
export type Invite = {
  id: string;
  agency_id: string;
  email: string;
  role: AgencyRole;
  token: string;
  expires_at: string;
  invited_by: string | null;
  accepted_at: string | null;
  created_at: string;
  // Position picked at invite time. Required when role='staff', null for admins.
  staff_role_id: string | null;
};

// Small projection returned by peek_agency_invite — safe to show to a
// caller holding the token (the token IS the access control).
export type InvitePeek = {
  invite_id:       string;
  agency_id:       string;
  agency_name:     string;
  email:           string;
  invite_role:     AgencyRole;
  staff_role_id:   string | null;
  staff_role_name: string | null;
  department_name: string | null;
  expires_at:      string;
  accepted:        boolean;
};

// Augmented row used by the Settings team list — adds a derived status
// so the UI doesn't have to recompute it.
export type InviteWithStatus = Invite & {
  status: 'pending' | 'expired' | 'accepted';
};

function statusOf(i: Invite): InviteWithStatus['status'] {
  if (i.accepted_at) return 'accepted';
  if (new Date(i.expires_at).getTime() <= Date.now()) return 'expired';
  return 'pending';
}

// -----------------------------------------------------------------------------
//  List invites for an agency. RLS already restricts this to admins, so a
//  staff member calling this just gets an empty array.
// -----------------------------------------------------------------------------
export async function listInvites(agencyId: string): Promise<InviteWithStatus[]> {
  const { data, error } = await supabase
    .from('agency_invite')
    .select('*')
    .eq('agency_id', agencyId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map((i) => ({ ...(i as Invite), status: statusOf(i as Invite) }));
}

// -----------------------------------------------------------------------------
//  Create a new invite. Returns the row including the new token, so the
//  caller can immediately build the join URL.
// -----------------------------------------------------------------------------
export async function createInvite(
  agencyId: string,
  email: string,
  role: AgencyRole = 'staff',
  staffRoleId: string | null = null,
): Promise<Invite> {
  const { data, error } = await supabase.rpc('create_agency_invite', {
    p_agency_id:     agencyId,
    p_email:         email,
    p_role:          role,
    p_staff_role_id: staffRoleId,
  });
  if (error) throw error;
  return data as Invite;
}

// -----------------------------------------------------------------------------
//  Rotate the token + reset the expiry on an existing pending invite.
//  Useful when an admin wants a fresh URL to send to the same person.
// -----------------------------------------------------------------------------
export async function regenerateInvite(inviteId: string): Promise<Invite> {
  const { data, error } = await supabase.rpc('regenerate_agency_invite', {
    p_invite_id: inviteId,
  });
  if (error) throw error;
  return data as Invite;
}

// -----------------------------------------------------------------------------
//  Cancel (hard-delete) a pending invite. RLS allows admins only.
// -----------------------------------------------------------------------------
export async function cancelInvite(inviteId: string): Promise<void> {
  const { error } = await supabase
    .from('agency_invite')
    .delete()
    .eq('id', inviteId);
  if (error) throw error;
}

// -----------------------------------------------------------------------------
//  Look up an invite by its token. Anyone holding the token can peek —
//  this is how the AcceptInvite page knows what agency to display.
//  Returns null if the token isn't found.
// -----------------------------------------------------------------------------
export async function peekInvite(token: string): Promise<InvitePeek | null> {
  const { data, error } = await supabase.rpc('peek_agency_invite', {
    p_token: token,
  });
  if (error) throw error;
  const rows = (data ?? []) as InvitePeek[];
  return rows[0] ?? null;
}

// -----------------------------------------------------------------------------
//  Accept an invite. Caller must be signed in with the matching email.
//  Returns the agency_id so the client can switch context.
// -----------------------------------------------------------------------------
export async function acceptInvite(token: string): Promise<string> {
  const { data, error } = await supabase.rpc('accept_agency_invite', {
    p_token: token,
  });
  if (error) throw error;
  return data as string;
}

// -----------------------------------------------------------------------------
//  Build the absolute join URL for a token. Centralized so the AcceptInvite
//  page and the Settings "copy link" button agree on the format.
// -----------------------------------------------------------------------------
export function buildInviteUrl(token: string): string {
  return `${window.location.origin}/invite/${encodeURIComponent(token)}`;
}

// -----------------------------------------------------------------------------
//  Pending member: someone who accepted an invite but doesn't yet have a
//  team_members row. The admin sees these on the Employees page and can
//  promote them with a single click (pre-filled with the suggested position).
// -----------------------------------------------------------------------------
export type UnlinkedMember = {
  user_id:             string;
  email:               string;
  joined_at:           string;
  membership_role:     AgencyRole;
  suggested_role_id:   string | null;
  suggested_role_name: string | null;
  suggested_dept_id:   string | null;
  suggested_dept_name: string | null;
};

export async function listUnlinkedMembers(
  agencyId: string,
): Promise<UnlinkedMember[]> {
  const { data, error } = await supabase.rpc('list_unlinked_members', {
    p_agency_id: agencyId,
  });
  if (error) throw error;
  return (data ?? []) as UnlinkedMember[];
}
