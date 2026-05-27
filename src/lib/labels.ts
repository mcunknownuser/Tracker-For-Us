// =============================================================================
//  labels.ts
//  User-customizable labels. Lets each agency rename built-in terminology
//  so the app reads naturally for non-OFM verticals:
//    * Income source labels (OFM, Reddit) — for the dashboard cards
//    * Terminology (chatter, model, withdrawal, sale, payout) — for buttons
//      and column headers throughout the app
//
//  Stored in user_preferences as a single object so it syncs across devices.
//  Mirrored to localStorage so the UI can format synchronously on first
//  render without waiting for the DB.
// =============================================================================

import { getPref, setPref, getPrefSync, primePrefsFromLocal } from './preferences';

// Terminology only — income source names come from the user's
// departments (Settings > Departments), so they no longer need to
// be configured here.
export type LabelKey =
  | 'chatter'    // Person who logs sales
  | 'model'      // Person whose earnings you track
  | 'sale'       // The sale entry
  | 'withdrawal' // The payout collected from a platform
  | 'payout';    // Paying out an owed balance to a team member

export type Labels = Record<LabelKey, string>;

export const DEFAULT_LABELS: Labels = {
  chatter:    'Chatter',
  model:      'Model',
  sale:       'Sale',
  withdrawal: 'Withdrawal',
  payout:     'Payout',
};

const PREF_KEY  = 'labels';
const LOCAL_KEY = 'voltrisai.labels';

// Read a single label synchronously. Returns the default if no override
// has been set or if the cache hasn't been primed.
export function getLabel(key: LabelKey): string {
  const overrides = getPrefSync<Partial<Labels>>(PREF_KEY, {});
  return overrides[key] ?? DEFAULT_LABELS[key];
}

// Full label set with overrides applied. Useful when a component needs
// several labels at once.
export function getAllLabels(): Labels {
  const overrides = getPrefSync<Partial<Labels>>(PREF_KEY, {});
  return { ...DEFAULT_LABELS, ...overrides };
}

// Async load from prefs, mirrored to localStorage for next-boot sync reads.
export async function loadLabels(): Promise<Labels> {
  try {
    const fromPrefs = await getPref<Partial<Labels> | null>(PREF_KEY, null);
    if (fromPrefs && typeof fromPrefs === 'object') {
      try {
        window.localStorage.setItem(LOCAL_KEY, JSON.stringify(fromPrefs));
      } catch { /* localStorage may be unavailable */ }
      return { ...DEFAULT_LABELS, ...fromPrefs };
    }
  } catch { /* fall through */ }
  return { ...DEFAULT_LABELS };
}

// Save patched overrides. Empty strings are treated as "reset to default".
export async function saveLabels(patch: Partial<Labels>): Promise<void> {
  const current = getPrefSync<Partial<Labels>>(PREF_KEY, {});
  const next: Partial<Labels> = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    const key = k as LabelKey;
    const trimmed = (v ?? '').trim();
    if (!trimmed || trimmed === DEFAULT_LABELS[key]) {
      delete next[key];
    } else {
      next[key] = trimmed;
    }
  }
  try {
    window.localStorage.setItem(LOCAL_KEY, JSON.stringify(next));
  } catch { /* ignore */ }
  await setPref(PREF_KEY, next);
}

// Prime the synchronous cache from localStorage during module load so the
// first render of any page already has the user's overrides applied.
export function primeLabelsFromLocal(): void {
  if (typeof window === 'undefined') return;
  try {
    const raw = window.localStorage.getItem(LOCAL_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<Labels>;
    if (parsed && typeof parsed === 'object') {
      primePrefsFromLocal({ [PREF_KEY]: parsed });
    }
  } catch { /* ignore malformed local data */ }
}
