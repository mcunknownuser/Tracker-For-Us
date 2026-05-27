// =============================================================================
//  locale.ts
//  Currency + locale settings. Drives formatCents and any other money
//  display in the app. Stored in user_preferences (synced) with a
//  localStorage mirror for synchronous first-render access.
// =============================================================================

import { getPref, setPref, getPrefSync, primePrefsFromLocal } from './preferences';

export type CurrencyCode =
  | 'USD' | 'EUR' | 'GBP' | 'CAD' | 'AUD' | 'CHF' | 'JPY' | 'CNY' | 'INR'
  | 'BRL' | 'MXN' | 'ZAR' | 'PLN' | 'SEK' | 'NOK' | 'DKK' | 'NZD' | 'SGD';

export type LocaleSettings = {
  currency: CurrencyCode;
  locale:   string;   // BCP 47 (e.g. 'en-US', 'de-DE')
};

export const CURRENCY_OPTIONS: { value: CurrencyCode; label: string; locale: string }[] = [
  { value: 'USD', label: 'US Dollar (USD $)',        locale: 'en-US' },
  { value: 'EUR', label: 'Euro (EUR €)',             locale: 'de-DE' },
  { value: 'GBP', label: 'British Pound (GBP £)',    locale: 'en-GB' },
  { value: 'CAD', label: 'Canadian Dollar (CAD $)',  locale: 'en-CA' },
  { value: 'AUD', label: 'Australian Dollar (AUD $)',locale: 'en-AU' },
  { value: 'CHF', label: 'Swiss Franc (CHF)',        locale: 'de-CH' },
  { value: 'JPY', label: 'Japanese Yen (JPY ¥)',     locale: 'ja-JP' },
  { value: 'CNY', label: 'Chinese Yuan (CNY ¥)',     locale: 'zh-CN' },
  { value: 'INR', label: 'Indian Rupee (INR ₹)',     locale: 'en-IN' },
  { value: 'BRL', label: 'Brazilian Real (BRL R$)',  locale: 'pt-BR' },
  { value: 'MXN', label: 'Mexican Peso (MXN $)',     locale: 'es-MX' },
  { value: 'ZAR', label: 'South African Rand (ZAR R)', locale: 'en-ZA' },
  { value: 'PLN', label: 'Polish Złoty (PLN zł)',    locale: 'pl-PL' },
  { value: 'SEK', label: 'Swedish Krona (SEK kr)',   locale: 'sv-SE' },
  { value: 'NOK', label: 'Norwegian Krone (NOK kr)', locale: 'nb-NO' },
  { value: 'DKK', label: 'Danish Krone (DKK kr)',    locale: 'da-DK' },
  { value: 'NZD', label: 'New Zealand Dollar (NZD $)',locale: 'en-NZ' },
  { value: 'SGD', label: 'Singapore Dollar (SGD $)', locale: 'en-SG' },
];

export const DEFAULT_LOCALE: LocaleSettings = {
  currency: 'USD',
  locale:   'en-US',
};

const PREF_KEY  = 'locale';
const LOCAL_KEY = 'voltrisai.locale';

export function getLocaleSync(): LocaleSettings {
  return getPrefSync<LocaleSettings>(PREF_KEY, DEFAULT_LOCALE);
}

export async function loadLocale(): Promise<LocaleSettings> {
  try {
    const fromPrefs = await getPref<LocaleSettings | null>(PREF_KEY, null);
    if (fromPrefs && typeof fromPrefs === 'object' && fromPrefs.currency) {
      try {
        window.localStorage.setItem(LOCAL_KEY, JSON.stringify(fromPrefs));
      } catch { /* ignore */ }
      return fromPrefs;
    }
  } catch { /* fall through */ }
  return { ...DEFAULT_LOCALE };
}

export async function saveLocale(next: LocaleSettings): Promise<void> {
  try {
    window.localStorage.setItem(LOCAL_KEY, JSON.stringify(next));
  } catch { /* ignore */ }
  await setPref(PREF_KEY, next);
}

export function primeLocaleFromLocal(): void {
  if (typeof window === 'undefined') return;
  try {
    const raw = window.localStorage.getItem(LOCAL_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as LocaleSettings;
    if (parsed && typeof parsed === 'object' && parsed.currency) {
      primePrefsFromLocal({ [PREF_KEY]: parsed });
    }
  } catch { /* ignore */ }
}
