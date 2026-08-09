// =============================================================================
//  trend — periods across the columns, one row per metric, each row carrying a
//  bar scaled to its own maximum.
//
//  Deliberately no chart library. recharts is in the project but it renders to
//  a sized SVG that does not paginate or print predictably, and a CSS bar says
//  the same thing at a tenth of the weight. Bars are scaled per row because a
//  row of dollars and a row of percentages share no scale.
// =============================================================================

import type { ComputedSection, Section } from '../../lib/reports/types';
import { Figure, SectionShell, collectNotes, flowsAcrossPages, rowValues } from './parts';

type Spec = Extract<Section, { kind: 'trend' }>;

export function TrendSection({
  spec,
  section,
  commentary,
}: {
  spec: Spec;
  section?: ComputedSection;
  commentary?: string;
}) {
  const buckets = section?.columns ?? [];
  const rows = section?.rows ?? [];
  const notes = collectNotes(rowValues(rows, buckets));

  return (
    <SectionShell
      title={spec.title}
      commentary={commentary}
      notes={notes.list}
      flow={flowsAcrossPages(rows.length)}
      aside={<div className="rpt-label">By {spec.bucketBy}</div>}
    >
      <table className="rpt-table">
        <thead>
          <tr>
            <th>Metric</th>
            {buckets.map((b) => (
              <th key={b} className="rpt-th-num">
                {b}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const label = spec.metrics.find((m) => m.key === row.group)?.label ?? row.group;
            const max = buckets.reduce((m, b) => {
              const raw = row.values[b]?.raw;
              return raw !== null && raw !== undefined && raw > m ? raw : m;
            }, 0);
            return (
              <tr key={row.group}>
                <td className="rpt-row-label">{label}</td>
                {buckets.map((b) => {
                  const value = row.values[b];
                  const raw = value?.raw ?? null;
                  const width = max > 0 && raw !== null && raw > 0 ? (raw / max) * 100 : 0;
                  return (
                    <td key={b} className="rpt-num">
                      <Figure value={value} mark={notes.mark(value)} />
                      {width > 0 ? (
                        <div className="rpt-bar">
                          <div className="rpt-bar-fill" style={{ width: `${width}%` }} />
                        </div>
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            );
          })}
          {rows.length === 0 || buckets.length === 0 ? (
            <tr>
              <td colSpan={buckets.length + 1} className="rpt-missing">
                No periods to compare.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </SectionShell>
  );
}
