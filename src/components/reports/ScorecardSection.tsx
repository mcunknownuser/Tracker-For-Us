// =============================================================================
//  scorecard — one row per group, one column per metric, pass/fail badges.
//  This is the centrepiece of the report, and the section most likely to run
//  long, so it is allowed to break across pages (rows stay whole, the header
//  repeats — see report.css).
// =============================================================================

import type { ComputedSection, Section } from '../../lib/reports/types';
import {
  Figure,
  SectionShell,
  collectNotes,
  flowsAcrossPages,
  formatTarget,
  rowValues,
  targetTone,
} from './parts';

type Spec = Extract<Section, { kind: 'scorecard' }>;

function Legend() {
  const items: Array<[string, string, string]> = [
    ['pass', 'var(--rpt-pass-bg)', 'Meets target'],
    ['near', 'var(--rpt-near-bg)', 'Within 10%'],
    ['fail', 'var(--rpt-fail-bg)', 'Below target'],
  ];
  return (
    <div className="rpt-legend flex shrink-0 items-center gap-3">
      {items.map(([tone, bg, label]) => (
        <span key={tone}>
          <span
            className="rpt-legend-dot"
            style={{ background: bg, borderColor: `var(--rpt-${tone})` }}
          />
          {label}
        </span>
      ))}
    </div>
  );
}

export function ScorecardSection({
  spec,
  section,
  commentary,
}: {
  spec: Spec;
  section?: ComputedSection;
  commentary?: string;
}) {
  const columns = section?.columns ?? spec.metrics.map((m) => m.key);
  const rows = section?.rows ?? [];
  const notes = collectNotes(rowValues(rows, columns));
  const metricFor = (key: string) => spec.metrics.find((m) => m.key === key);
  const hasTargets = spec.metrics.some((m) => m.target);

  return (
    <SectionShell
      title={spec.title}
      commentary={commentary}
      notes={notes.list}
      flow={flowsAcrossPages(rows.length)}
      aside={hasTargets ? <Legend /> : undefined}
    >
      <table className="rpt-table">
        <thead>
          <tr>
            <th>{spec.groupBy}</th>
            {columns.map((key) => {
              const metric = metricFor(key);
              const target = metric ? formatTarget(metric) : null;
              const proposed = metric?.target?.source === 'proposed';
              return (
                <th key={key} className="rpt-th-num">
                  {metric?.label ?? key}
                  {target ? (
                    <span
                      className={`rpt-target ${proposed ? 'rpt-target--proposed' : ''}`}
                      title={
                        proposed
                          ? 'Proposed target — not yet agreed with the client'
                          : 'Agreed target'
                      }
                    >
                      Target {target}
                      {proposed ? ' (proposed)' : ''}
                    </span>
                  ) : null}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.group}>
              <td className="rpt-row-label">{row.group}</td>
              {columns.map((key) => {
                const value = row.values[key];
                return (
                  <td key={key} className="rpt-num">
                    <Figure
                      value={value}
                      tone={value ? targetTone(value, metricFor(key)?.target) : undefined}
                      mark={notes.mark(value)}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length + 1} className="rpt-missing">
                No rows matched this section's filter.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </SectionShell>
  );
}
