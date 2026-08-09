// =============================================================================
//  table — selected columns of rows, sortable on screen.
//
//  Sorting is a display affordance only: it never changes the numbers, and the
//  printed copy keeps whatever order is on screen when Print is pressed.
// =============================================================================

import { useMemo, useState } from 'react';
import type { ComputedRow, ComputedSection, Section } from '../../lib/reports/types';
import { Figure, SectionShell, collectNotes, flowsAcrossPages, isMissing, rowValues } from './parts';

type Spec = Extract<Section, { kind: 'table' }>;
type Sort = { key: string; dir: 'asc' | 'desc' };

function compare(a: ComputedRow, b: ComputedRow, sort: Sort): number {
  const av = a.values[sort.key];
  const bv = b.values[sort.key];
  const am = isMissing(av);
  const bm = isMissing(bv);
  // Missing values sort last in both directions — they are not "the smallest".
  if (am || bm) return am && bm ? 0 : am ? 1 : -1;
  const dir = sort.dir === 'asc' ? 1 : -1;
  if (av && bv && av.raw !== null && bv.raw !== null) return (av.raw - bv.raw) * dir;
  return (av?.formatted ?? '').localeCompare(bv?.formatted ?? '') * dir;
}

export function TableSection({
  spec,
  section,
  commentary,
}: {
  spec: Spec;
  section?: ComputedSection;
  commentary?: string;
}) {
  const columns = section?.columns ?? spec.columns;
  const rows = useMemo(() => section?.rows ?? [], [section]);
  const [sort, setSort] = useState<Sort | null>(null);

  const sorted = useMemo(() => (sort ? [...rows].sort((a, b) => compare(a, b, sort)) : rows), [rows, sort]);
  const notes = collectNotes(rowValues(sorted, columns));

  // The engine may carry a row label in `group` that is not one of the chosen
  // columns. Show it, but don't print the same string twice.
  const showGroup = rows.some(
    (r) => r.group && !columns.some((c) => r.values[c]?.formatted === r.group),
  );

  // Only columns that actually hold numbers get right-aligned. A right-aligned
  // message column reads as broken.
  const numeric = new Set(
    columns.filter((c) => rows.some((r) => typeof r.values[c]?.raw === 'number')),
  );

  const toggle = (key: string) =>
    setSort((prev) =>
      prev?.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' },
    );

  return (
    <SectionShell
      title={spec.title}
      commentary={commentary}
      notes={notes.list}
      flow={flowsAcrossPages(rows.length)}
    >
      <table className="rpt-table">
        <thead>
          <tr>
            {showGroup ? <th /> : null}
            {columns.map((c) => {
              const on = sort?.key === c;
              return (
                <th key={c} className={numeric.has(c) ? 'rpt-th-num' : undefined}>
                  <button type="button" className="rpt-sort" onClick={() => toggle(c)}>
                    {c}
                    <span className={`rpt-sort-caret ${on ? 'rpt-sort-caret--on' : ''}`}>
                      {on && sort?.dir === 'asc' ? '▲' : '▼'}
                    </span>
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, i) => (
            <tr key={`${row.group}-${i}`}>
              {showGroup ? <td className="rpt-row-label">{row.group}</td> : null}
              {columns.map((c) => (
                <td key={c} className={numeric.has(c) ? 'rpt-num' : undefined}>
                  <Figure value={row.values[c]} mark={notes.mark(row.values[c])} />
                </td>
              ))}
            </tr>
          ))}
          {sorted.length === 0 ? (
            <tr>
              <td colSpan={columns.length + (showGroup ? 1 : 0)} className="rpt-missing">
                No rows to show.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
      {spec.limit && rows.length >= spec.limit ? (
        <div className="rpt-label mt-3">Showing first {spec.limit} rows</div>
      ) : null}
    </SectionShell>
  );
}
