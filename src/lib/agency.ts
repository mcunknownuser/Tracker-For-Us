// =============================================================================
//  agency.ts
//  Helpers for creating an agency on first signup, listing the agencies the
//  current user belongs to, and tracking which one is "active" in the UI.
// =============================================================================

import { useEffect, useState } from 'react';
import { supabase } from './supabase';

// Shape of an agency row returned to the app. Mirrors the public.agency table.
export type Agency = {
  id: string;
  agency_number: number;
  name: string;
  owner_user_id: string;
  created_at: string;
  // Null until the owner finishes the first-run wizard. The app uses this
  // to decide whether to show Onboarding or the routed app.
  onboarding_completed_at: string | null;
};

// Columns selected wherever we read an agency row. Kept in one place so
// adding fields to Agency doesn't mean hunting for every select.
const AGENCY_COLS =
  'id, agency_number, name, owner_user_id, created_at, onboarding_completed_at';

// The key we use in localStorage to remember which agency the user last
// switched to (for users who belong to multiple agencies).
const ACTIVE_AGENCY_KEY = 'voltrisai.active_agency_id';

// -----------------------------------------------------------------------------
//  createAgencyForCurrentUser
//
//  Calls the SECURITY DEFINER function create_agency_for_current_user() in
//  the database, which atomically:
//    1. Inserts a new row into public.agency
//    2. Inserts an owner membership for the current user
//    3. Seeds per-agency default categories, methods, and roles
//
//  Returns the full agency row.
// -----------------------------------------------------------------------------
export async function createAgencyForCurrentUser(name: string): Promise<Agency> {
  // The RPC returns just the new agency's UUID; we fetch the full row after.
  const { data: newAgencyId, error: rpcErr } = await supabase
    .rpc('create_agency_for_current_user', { agency_name: name });
  if (rpcErr) throw rpcErr;
  if (!newAgencyId) throw new Error('Agency creation returned no id.');

  // Fetch the full row so the caller has the agency_number, created_at, etc.
  const { data: agency, error: selectErr } = await supabase
    .from('agency')
    .select(AGENCY_COLS)
    .eq('id', newAgencyId)
    .single();
  if (selectErr) throw selectErr;
  if (!agency) throw new Error('Failed to read the newly created agency.');

  setActiveAgencyId(agency.id);
  return agency as Agency;
}

// -----------------------------------------------------------------------------
//  listMyAgencies
//
//  Returns all agencies the current user is a member of. Used for the
//  agency switcher in the UI (most users only have one).
// -----------------------------------------------------------------------------
export async function listMyAgencies(): Promise<Agency[]> {
  const { data, error } = await supabase
    .from('agency')
    .select(AGENCY_COLS)
    .is('deleted_at', null)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as Agency[];
}

// -----------------------------------------------------------------------------
//  completeOnboarding
//
//  Stamps onboarding_completed_at = now() so the wizard never shows again
//  for this agency. Owner-only at the RLS level (agency_update policy
//  requires is_agency_admin, and the owner is an admin).
// -----------------------------------------------------------------------------
export async function completeOnboarding(agencyId: string): Promise<Agency> {
  const { data, error } = await supabase
    .from('agency')
    .update({ onboarding_completed_at: new Date().toISOString() })
    .eq('id', agencyId)
    .select(AGENCY_COLS)
    .single();
  if (error) throw error;
  return data as Agency;
}

// -----------------------------------------------------------------------------
//  getMyAgencyRole
//
//  Returns the calling user's role within an agency, or null if not a member.
// -----------------------------------------------------------------------------
export async function getMyAgencyRole(
  agencyId: string,
): Promise<'owner' | 'admin' | 'staff' | null> {
  const { data: userResp } = await supabase.auth.getUser();
  const userId = userResp.user?.id;
  if (!userId) return null;
  const { data, error } = await supabase
    .from('agency_membership')
    .select('role')
    .eq('agency_id', agencyId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return (data?.role ?? null) as 'owner' | 'admin' | 'staff' | null;
}

// -----------------------------------------------------------------------------
//  Active agency tracking (localStorage)
//
//  For users who belong to multiple agencies, we remember which one they
//  most recently viewed. Stored in localStorage so it persists across
//  tabs and reloads.
// -----------------------------------------------------------------------------
export function getActiveAgencyId(): string | null {
  return localStorage.getItem(ACTIVE_AGENCY_KEY);
}

export function setActiveAgencyId(agencyId: string) {
  localStorage.setItem(ACTIVE_AGENCY_KEY, agencyId);
}

export function clearActiveAgencyId() {
  localStorage.removeItem(ACTIVE_AGENCY_KEY);
}

// -----------------------------------------------------------------------------
//  React hook: useActiveAgency
//
//  Resolves the current user's active agency. If they have no agencies yet,
//  returns null (and the UI shows the "create your first agency" wizard).
//  If they have one or more but no active one is selected, defaults to
//  the first.
// -----------------------------------------------------------------------------
export function useActiveAgency() {
  const [agency, setAgency] = useState<Agency | null>(null);
  const [allAgencies, setAllAgencies] = useState<Agency[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  // Bump to force a refetch (e.g. after accepting an invite or completing
  // onboarding — the row in `agency` changed, we want the latest).
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      try {
        const agencies = await listMyAgencies();
        if (cancelled) return;
        setAllAgencies(agencies);

        if (agencies.length === 0) {
          setAgency(null);
        } else {
          const savedId = getActiveAgencyId();
          const found = savedId
            ? agencies.find((a) => a.id === savedId)
            : undefined;
          const chosen = found ?? agencies[0]!;
          setActiveAgencyId(chosen.id);
          setAgency(chosen);
        }
      } catch (e) {
        if (!cancelled) setError(e as Error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [tick]);

  function switchAgency(agencyId: string) {
    const found = allAgencies.find((a) => a.id === agencyId);
    if (!found) return;
    setActiveAgencyId(agencyId);
    setAgency(found);
  }

  function refresh() {
    setTick((n) => n + 1);
  }

  return { agency, allAgencies, loading, error, switchAgency, refresh };
}
