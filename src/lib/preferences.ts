// =============================================================================
//  preferences.ts
//  Per-user UI preferences, backed by the user_preferences table (one row
//  per auth user, prefs stored as a single jsonb blob). RLS scopes reads
//  and writes to the calling user, so we can fetch without filters.
//
//  This is also a tiny in-memory cache so consumers don't have to await
//  the DB on every render. After the first load the cached value is used
//  and a refresh() can be triggered by listeners.
// =============================================================================

import { supabase } from './supabase';

type PrefsBlob = Record<string, unknown>;

let cache: PrefsBlob | null = null;
let inflight: Promise<PrefsBlob> | null = null;

async function loadPrefs(): Promise<PrefsBlob> {
  if (cache) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    const { data, error } = await supabase
      .from('user_preferences')
      .select('prefs')
      .maybeSingle();
    if (error) throw error;
    cache = (data?.prefs as PrefsBlob | undefined) ?? {};
    return cache;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

export async function getPref<T>(key: string, fallback: T): Promise<T> {
  const prefs = await loadPrefs();
  const v = prefs[key];
  return v === undefined || v === null ? fallback : (v as T);
}

// Synchronous read of an already-loaded pref. Used by code that needs a
// value during render (formatCents, label lookups) and can't await. Returns
// the fallback if the cache hasn't been primed yet.
export function getPrefSync<T>(key: string, fallback: T): T {
  if (!cache) return fallback;
  const v = cache[key];
  return v === undefined || v === null ? fallback : (v as T);
}

// Prime the in-memory cache from localStorage. Lets synchronous reads work
// before the DB round-trip completes — important for currency/label prefs
// that the UI needs to format the very first render.
export function primePrefsFromLocal(local: PrefsBlob): void {
  cache = { ...(cache ?? {}), ...local };
}

export async function setPref(key: string, value: unknown): Promise<void> {
  const { data: { user }, error: userErr } = await supabase.auth.getUser();
  if (userErr) throw userErr;
  if (!user) throw new Error('Not signed in.');

  // Merge with whatever's cached / on disk.
  const current = await loadPrefs();
  const next = { ...current, [key]: value };

  const { error } = await supabase
    .from('user_preferences')
    .upsert({ user_id: user.id, prefs: next }, { onConflict: 'user_id' });
  if (error) throw error;

  cache = next;
  // Notify the rest of the app that a pref changed.
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('voltrisai:prefs-changed', { detail: { key } }),
    );
  }
}

// Force a refresh from the DB. Useful after sign-in / sign-out, or when a
// stale cache is suspected.
export function invalidatePrefs(): void {
  cache = null;
}
