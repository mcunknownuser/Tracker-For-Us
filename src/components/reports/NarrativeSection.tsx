// =============================================================================
//  narrative — prose only, no data access.
//
//  The body is the stage-5 commentary for this section id. `spec.brief` is the
//  instruction given to the writer, not copy for the client, so it is never
//  rendered.
// =============================================================================

import type { Section } from '../../lib/reports/types';
import { Paragraphs, SectionShell } from './parts';

type Spec = Extract<Section, { kind: 'narrative' }>;

export function NarrativeSection({ spec, body }: { spec: Spec; body?: string }) {
  return (
    <SectionShell title={spec.title}>
      {body ? (
        <Paragraphs text={body} className="rpt-lede" />
      ) : (
        <p className="rpt-missing">No commentary was written for this section.</p>
      )}
    </SectionShell>
  );
}
