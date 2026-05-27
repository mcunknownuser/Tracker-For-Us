// =============================================================================
//  money.ts
//  Money is stored as BIGINT cents everywhere in the database. The UI deals
//  in dollars (strings) for display + input. These helpers keep the
//  conversion + formatting in one place.
//
//  Display currency + locale come from lib/locale.ts (user preference,
//  synced across devices). Storage is still always integer "cents" — we
//  don't try to do real FX conversion, the user simply picks how their
//  numbers are displayed.
// =============================================================================

import { getLocaleSync } from './locale';

// Currencies with no minor units (yen, etc.) need 0 fraction digits.
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP']);

// Format cents as a display string in the user's chosen currency + locale.
// 1234567 -> "$12,345.67" (USD/en-US) or "12.345,67 €" (EUR/de-DE).
// Pass withSymbol=false to get just the numeric part.
export function formatCents(cents: number | null | undefined, withSymbol = true): string {
  const { currency, locale } = getLocaleSync();
  const zero = ZERO_DECIMAL.has(currency);
  if (cents == null || Number.isNaN(cents)) {
    return withSymbol
      ? new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: zero ? 0 : 2 }).format(0)
      : (zero ? '0' : '0.00');
  }
  const value = zero ? cents : cents / 100;
  if (withSymbol) {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: zero ? 0 : 2,
      maximumFractionDigits: zero ? 0 : 2,
    }).format(value);
  }
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: zero ? 0 : 2,
    maximumFractionDigits: zero ? 0 : 2,
  }).format(value);
}

// Parse a user-typed dollar string ("12.34", "1,234.56", "$1,234.56")
// into integer cents. Returns null if not parseable.
export function parseDollarsToCents(input: string): number | null {
  if (!input) return null;
  const cleaned = input.replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const value = parseFloat(cleaned);
  if (Number.isNaN(value)) return null;
  return Math.round(value * 100);
}

// Format a rate (0..1 decimal) as a percent string.
// 0.075 -> "7.5%"
export function formatRate(rate: number | null | undefined): string {
  if (rate == null || Number.isNaN(rate)) return '0%';
  const pct = rate * 100;
  // Trim trailing zeros for whole numbers (50% not 50.0%).
  return `${Number.isInteger(pct) ? pct.toFixed(0) : pct.toFixed(1)}%`;
}

// Parse a user-typed percent ("10", "10.5", "10%") into a 0..1 decimal.
// Returns null if not parseable.
export function parsePercentToRate(input: string): number | null {
  if (!input) return null;
  const cleaned = input.replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const value = parseFloat(cleaned);
  if (Number.isNaN(value)) return null;
  return value / 100;
}
