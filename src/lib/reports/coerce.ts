// =============================================================================
//  Value coercion — the single source of truth for "what does this cell mean".
//
//  Both profile.ts (type inference) and engine.ts (arithmetic) depend on this.
//  If they each rolled their own, a report could disagree with itself: the
//  profile calls a column currency, the engine reads it as text, and a total
//  silently comes out zero. One implementation, imported by both.
//
//  Infloww quirks this handles:
//    "$1,928.00"   money with separators
//    "41.67%"      percent as written (41.67, NOT 0.4167)
//    "47h 18min"   clocked hours
//    "2m 53s"      response time
//    "3 months"    subscription length
//    "-"           Infloww's not-applicable marker — null, never 0
// =============================================================================

const EMPTY_MARKERS = new Set(['', '-', '–', '—', 'n/a', 'na', 'null']);

export function isEmptyValue(raw: string | null | undefined): boolean {
  if (raw == null) return true;
  return EMPTY_MARKERS.has(raw.trim().toLowerCase());
}

// "$1,928.00" → 1928 · "(50)" → -50 · "-" → null
export function parseCurrency(raw: string): number | null {
  if (isEmptyValue(raw)) return null;
  let s = raw.trim();
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[$£€,\s]/g, '');
  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1);
  }
  if (!/^\d*\.?\d+$/.test(s)) return null;
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

// "41.67%" → 41.67. Percent stays as written so formatting is a suffix, not a
// multiply — a 100x error here would be invisible in a scorecard.
export function parsePercent(raw: string): number | null {
  if (isEmptyValue(raw)) return null;
  const s = raw.trim().replace(/%/g, '').replace(/,/g, '');
  if (!/^-?\d*\.?\d+$/.test(s)) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

export function parseNumber(raw: string): number | null {
  if (isEmptyValue(raw)) return null;
  const s = raw.trim().replace(/,/g, '');
  if (!/^-?\d*\.?\d+$/.test(s)) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

const DURATION_UNITS: Array<[RegExp, number]> = [
  [/(\d+(?:\.\d+)?)\s*(?:years?|yrs?|y)\b/gi, 31_536_000],
  [/(\d+(?:\.\d+)?)\s*(?:months?|mos?)\b/gi, 2_592_000],   // 30d
  [/(\d+(?:\.\d+)?)\s*(?:weeks?|wks?|w)\b/gi, 604_800],
  [/(\d+(?:\.\d+)?)\s*(?:days?|d)\b/gi, 86_400],
  [/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/gi, 3_600],
  [/(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)\b/gi, 60],
  [/(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/gi, 1],
];

// Everything becomes seconds; callers convert. "47h 18min" → 170280.
// Per-hour metrics divide by durationToHours(), so 101 PPVs / 47.3h = 2.14.
export function parseDuration(raw: string): number | null {
  if (isEmptyValue(raw)) return null;
  const s = raw.trim();
  let total = 0;
  let matched = false;
  for (const [re, mult] of DURATION_UNITS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
      total += parseFloat(m[1]) * mult;
      matched = true;
    }
  }
  return matched ? total : null;
}

export function durationToHours(seconds: number | null): number | null {
  return seconds == null ? null : seconds / 3600;
}

// Format-directed read. Callers pass the ColumnType the profiler assigned.
export function coerce(raw: string, type: string): number | null {
  switch (type) {
    case 'currency': return parseCurrency(raw);
    case 'percent': return parsePercent(raw);
    case 'duration': return parseDuration(raw);
    case 'number': return parseNumber(raw);
    default: return parseNumber(raw);
  }
}

// ---- Display ---------------------------------------------------------------

// `toFixed` rounds the stored double, not the decimal you meant. 44.55 is held
// as 44.54999999999999716, so (44.55).toFixed(1) === "44.5" — one digit below
// what the source system printed. Re-parsing the shifted decimal as a fresh
// literal avoids inheriting that error: "44.55e1" parses to exactly 445.5,
// which rounds to 446, giving 44.6.
//
// Worth the trouble because these are staff-facing performance figures. A
// number that disagrees with Infloww by a digit costs more trust than it
// saves effort.
function roundTo(n: number, digits: number): number {
  const sign = n < 0 ? -1 : 1;
  const abs = Math.abs(n);
  const shifted = Math.round(Number(`${abs}e${digits}`));
  return sign * Number(`${shifted}e-${digits}`);
}

export function formatValue(n: number | null, format: string): string {
  if (n == null || !Number.isFinite(n)) return '—';
  switch (format) {
    case 'currency':
      return (n < 0 ? '-$' : '$') + roundTo(Math.abs(n), 2).toLocaleString('en-US', {
        minimumFractionDigits: 2, maximumFractionDigits: 2,
      });
    case 'percent': {
      const digits = Math.abs(n) >= 10 ? 1 : 2;
      return roundTo(n, digits).toFixed(digits) + '%';
    }
    case 'integer':
      return Math.round(n).toLocaleString('en-US');
    case 'duration': {
      const h = Math.floor(n / 3600);
      const m = Math.round((n % 3600) / 60);
      return h > 0 ? `${h}h ${m}m` : `${m}m`;
    }
    case 'number':
    default:
      return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
}
