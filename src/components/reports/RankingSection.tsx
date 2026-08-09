// =============================================================================
//  ranking — top-N groups by a single metric, with a proportional bar so the
//  gap between first and last is visible at a glance.
// =============================================================================

import type { ComputedSection, Section } from '../../lib/reports/types';
import {
  Figure,
  SectionShell,
  collectNotes,
  flowsAcrossPages,
  formatTarget,
  isMissing,
  targetTone,
} from './parts';

type Spec = Extract<Section, { kind: 'ranking' }>;

export function RankingSection({
  spec,
  section,
  commentary,
}: {
  spec: Spec;
  section?: ComputedSection;
  commentary?: string;
}) {
  const key = spec.metric.key;
  const rows = (section?.rows ?? []).slice(0, spec.limit);
  const notes = collectNotes(rows.map((r) => r.values[key]));
  const target = formatTarget(spec.metric);

  const max = rows.reduce((m, r) => {
    const raw = r.values[key]?.raw;
    return raw !== null && raw !== undefined && raw > m ? raw : m;
  }, 0);

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
            <th style={{ width: '1%' }}>#</th>
            <th>{spec.groupBy}</th>
            <th className="rpt-th-num">
              {spec.metric.label}
              {target ? <span className="rpt-target">Target {target}</span> : null}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const value = row.values[key];
            const raw = value?.raw ?? null;
            const width = max > 0 && raw !== null && raw > 0 ? (raw / max) * 100 : 0;
            return (
              <tr key={row.group}>
                <td className="rpt-rank">{i + 1}</td>
                <td>
                  <div className="rpt-row-label">{row.group}</div>
                  {width > 0 ? (
                    <div className="rpt-bar" style={{ maxWidth: 260 }}>
                      <div className="rpt-bar-fill" style={{ width: `${width}%` }} />
                    </div>
                  ) : null}
                </td>
                <td className="rpt-num">
                  <Figure
                    value={value}
                    tone={value && !isMissing(value) ? targetTone(value, spec.metric.target) : undefined}
                    mark={notes.mark(value)}
                  />
                </td>
              </tr>
            );
          })}
          {rows.length === 0 ? (
            <tr>
              <td colSpan={3} className="rpt-missing">
                Nothing to rank.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </SectionShell>
  );
}
