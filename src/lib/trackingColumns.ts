// =============================================================================
//  trackingColumns.ts
//  Column visibility for the Tracking page table. Stored in the per-user
//  preferences blob (see lib/preferences.ts) so settings sync across
//  devices.
// =============================================================================

import { getPref, setPref } from './preferences';

export type ColumnKey =
  | 'date'
  | 'clicks'
  | 'subs'
  | 'cvr'
  | 'promoCost'
  | 'earnings'
  | 'spendCvr'
  | 'fansSpent'
  | 'profit'
  | 'cpc'
  | 'epc'
  | 'cps'
  | 'aeps'
  | 'roi'
  | 'source'
  | 'tag'
  | 'list';

export type ColumnDef = {
  key: ColumnKey;
  label: string;
  hint: string;
};

// Order also defines the table column order. Tracking-link name is always
// visible and not toggleable, so it's not in this list.
export const TRACKING_COLUMNS: ColumnDef[] = [
  { key: 'date',      label: 'Date',       hint: 'When the link was created in Infloww' },
  { key: 'clicks',    label: 'Clicks',     hint: 'Δ since previous upload'              },
  { key: 'subs',      label: 'Subs',       hint: 'Δ since previous upload'              },
  { key: 'cvr',       label: 'CVR',        hint: 'Subscription conversion rate'          },
  { key: 'promoCost', label: 'Promo cost', hint: 'Δ since previous upload'              },
  { key: 'earnings',  label: 'Earnings',   hint: 'Δ since previous upload'              },
  { key: 'spendCvr',  label: 'Spend CVR',  hint: 'Spending conversion rate'              },
  { key: 'fansSpent', label: 'Fans spent', hint: 'Δ since previous upload'              },
  { key: 'profit',    label: 'Profit',     hint: 'Δ since previous upload'              },
  { key: 'cpc',       label: 'CPC',        hint: 'Cost per click'                        },
  { key: 'epc',       label: 'EPC',        hint: 'Earnings per click'                    },
  { key: 'cps',       label: 'CPS',        hint: 'Cost per subscriber'                   },
  { key: 'aeps',      label: 'AEPS',       hint: 'Avg earnings per spending fan'         },
  { key: 'roi',       label: 'ROI',        hint: 'Return on investment'                  },
  { key: 'source',    label: 'Source',     hint: 'Platform tag (Reddit, Twitter, …)'     },
  { key: 'tag',       label: 'Tag',        hint: 'Infloww tag field'                     },
  { key: 'list',      label: 'List',       hint: 'Infloww list grouping'                 },
];

const PREF_KEY = 'tracking.visibleColumns';
const ALL_KEYS = new Set<ColumnKey>(TRACKING_COLUMNS.map((c) => c.key));

function isColumnKey(s: string): s is ColumnKey {
  return ALL_KEYS.has(s as ColumnKey);
}

// Default = all columns visible.
export function defaultVisibleColumns(): Set<ColumnKey> {
  return new Set(ALL_KEYS);
}

export async function loadVisibleColumns(): Promise<Set<ColumnKey>> {
  const stored = await getPref<string[] | null>(PREF_KEY, null);
  if (!stored || !Array.isArray(stored)) return defaultVisibleColumns();
  return new Set(stored.filter(isColumnKey));
}

export async function saveVisibleColumns(cols: Set<ColumnKey>): Promise<void> {
  await setPref(PREF_KEY, Array.from(cols));
}
