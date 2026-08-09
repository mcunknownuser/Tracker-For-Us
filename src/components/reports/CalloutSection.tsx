// =============================================================================
//  callout — a fixed info/warn box. Used for data limitations and caveats, so
//  it is a box rather than a card: it should read as an aside, not as a
//  finding, but must still be impossible to miss.
// =============================================================================

import type { Section } from '../../lib/reports/types';
import { Paragraphs } from './parts';

type Spec = Extract<Section, { kind: 'callout' }>;

export function CalloutSection({ spec }: { spec: Spec }) {
  return (
    <section className="mb-8">
      <div className={`rpt-callout rpt-callout--${spec.tone} rpt-avoid-break`}>
        <div className="rpt-label">{spec.tone === 'warn' ? 'Caution' : 'Note'}</div>
        <div className="rpt-callout-title mt-1.5">{spec.title}</div>
        <Paragraphs text={spec.body} className="rpt-prose mt-1.5" />
      </div>
    </section>
  );
}
