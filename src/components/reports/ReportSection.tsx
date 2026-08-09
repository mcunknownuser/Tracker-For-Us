// =============================================================================
//  ReportSection — the dispatcher.
//
//  There is no fixed report template: the planner decides which sections a
//  report contains, so rendering is a vocabulary, not a layout. This maps one
//  planned section to its renderer and is the only place that knows the full
//  set of kinds.
//
//  It switches on `spec.kind` rather than `ComputedSection.kind` because that
//  is the discriminant TypeScript can narrow — each renderer then receives its
//  own concrete Section type instead of the union.
// =============================================================================

import type { ComputedSection, ReportProse, Section } from '../../lib/reports/types';
import { SectionError } from './parts';
import { CalloutSection } from './CalloutSection';
import { NarrativeSection } from './NarrativeSection';
import { RankingSection } from './RankingSection';
import { ScorecardSection } from './ScorecardSection';
import { StatCardsSection } from './StatCardsSection';
import { TableSection } from './TableSection';
import { TrendSection } from './TrendSection';

export function ReportSection({
  spec,
  computed,
  prose,
}: {
  spec: Section;
  computed?: ComputedSection;
  prose: ReportProse;
}) {
  const commentary = prose.sectionCommentary[spec.id];

  // A section that blew up is shown in place, not dropped. The rest of the
  // report still prints.
  if (computed?.error) return <SectionError title={spec.title} error={computed.error} />;

  // Every kind except the prose-only two needs a computed result. A silently
  // absent section would read as "nothing to report", which is a lie.
  if (!computed && spec.kind !== 'narrative' && spec.kind !== 'callout') {
    return (
      <SectionError
        title={spec.title}
        error="This section was planned but no computed result was returned for it."
      />
    );
  }

  switch (spec.kind) {
    // Prose-only kinds need no computed result at all.
    case 'narrative':
      return <NarrativeSection spec={spec} body={commentary} />;
    case 'callout':
      return <CalloutSection spec={spec} />;
    case 'statCards':
      return <StatCardsSection spec={spec} section={computed} commentary={commentary} />;
    case 'scorecard':
      return <ScorecardSection spec={spec} section={computed} commentary={commentary} />;
    case 'table':
      return <TableSection spec={spec} section={computed} commentary={commentary} />;
    case 'ranking':
      return <RankingSection spec={spec} section={computed} commentary={commentary} />;
    case 'trend':
      return <TrendSection spec={spec} section={computed} commentary={commentary} />;
    default:
      return null;
  }
}
