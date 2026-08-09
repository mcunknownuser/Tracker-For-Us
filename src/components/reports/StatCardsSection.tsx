// =============================================================================
//  statCards — a row of headline figures. Big serif number, small uppercase
//  label. One card per metric in spec order.
// =============================================================================

import type { ComputedSection, Section } from '../../lib/reports/types';
import { SectionShell, collectNotes, isMissing } from './parts';

type Spec = Extract<Section, { kind: 'statCards' }>;

export function StatCardsSection({
  spec,
  section,
  commentary,
}: {
  spec: Spec;
  section?: ComputedSection;
  commentary?: string;
}) {
  const values = section?.values ?? {};
  // The engine sets `columns` as the display order; spec order is the fallback.
  const order = section?.columns ?? spec.metrics.map((m) => m.key);
  const notes = collectNotes(order.map((key) => values[key]));

  return (
    <SectionShell title={spec.title} commentary={commentary} notes={notes.list}>
      <div className="rpt-stat-grid">
        {order.map((key) => {
          const m = spec.metrics.find((metric) => metric.key === key);
          const value = values[key];
          const missing = isMissing(value);
          const mark = notes.mark(value);
          return (
            <div key={key} className="rpt-stat">
              <div className="rpt-label">{m?.label ?? key}</div>
              <div
                className={`rpt-stat-value mt-2 ${missing ? 'rpt-missing' : ''}`}
                title={value?.note || undefined}
              >
                {missing ? '—' : value?.formatted}
                {mark ? <sup className="rpt-sup">{mark}</sup> : null}
              </div>
              {m?.description ? <div className="rpt-stat-desc mt-1.5">{m.description}</div> : null}
            </div>
          );
        })}
      </div>
    </SectionShell>
  );
}
