// =============================================================================
//  theme.ts
//  Pick-a-theme support. Five appearance modes, stored in user_preferences
//  (synced across devices) with a localStorage fallback for the
//  pre-sign-in / sign-up flow.
// =============================================================================

import { getPref, setPref } from './preferences';

export type Theme = 'dark' | 'light' | 'nighttime' | 'sepia' | 'high-contrast';

export const THEMES: { value: Theme; label: string; hint: string }[] = [
  { value: 'dark',          label: 'Dark',          hint: 'The original. Dim neutral grays.'        },
  { value: 'light',          label: 'Light',         hint: 'Clean white. Easier in bright rooms.'    },
  { value: 'nighttime',      label: 'Nighttime',     hint: 'Pitch black with warm text. Low blue.'   },
  { value: 'sepia',          label: 'Sepia',         hint: 'Warm cream + brown. Paper-like.'         },
  { value: 'high-contrast',  label: 'High contrast', hint: 'Stark black/white for accessibility.'    },
];

const PREF_KEY = 'theme';
const LOCAL_KEY = 'voltrisai.theme'; // mirrored locally for sign-in screen, pre-prefs

const VALID = new Set<Theme>(THEMES.map((t) => t.value));

function isTheme(s: unknown): s is Theme {
  return typeof s === 'string' && VALID.has(s as Theme);
}

// Apply a theme to <html> by setting the data-theme attribute. CSS in
// themes.css listens for this attribute and rewrites the neutral palette.
// "dark" is the bare-Tailwind default, so we clear the attribute for it.
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  if (theme === 'dark') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}

// Local cache so the app doesn't flash dark before prefs arrive after login.
export function getLocalTheme(): Theme {
  if (typeof window === 'undefined') return 'dark';
  const raw = window.localStorage.getItem(LOCAL_KEY);
  return isTheme(raw) ? raw : 'dark';
}

export function setLocalTheme(theme: Theme): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(LOCAL_KEY, theme);
}

// Load from the synced preferences blob. Falls back to local if not set.
export async function loadTheme(): Promise<Theme> {
  try {
    const fromPrefs = await getPref<Theme | null>(PREF_KEY, null);
    if (isTheme(fromPrefs)) return fromPrefs;
  } catch {
    /* fall through to local cache */
  }
  return getLocalTheme();
}

// Save to prefs (synced) AND local cache (for instant boot next visit).
export async function saveTheme(theme: Theme): Promise<void> {
  setLocalTheme(theme);
  applyTheme(theme);
  await setPref(PREF_KEY, theme);
}
