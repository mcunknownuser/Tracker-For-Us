// =============================================================================
//  ReportDocument
//  The finished document: masthead, executive headline, every planned section
//  in spec order, the recommendations, and a provenance footer.
//
//  The export path is HTML -> browser print -> Save as PDF, so this renders a
//  page, not a screen. Anything the host page puts around it (toolbars, a
//  Print button) should carry `rpt-no-print` so it drops out of the PDF.
//
//  Do not wrap this in an animated/transformed container: a CSS transform on
//  an ancestor becomes the containing block for the fixed-position sheet
//  background and stops it repeating on later printed pages. It degrades
//  quietly (the warm colour then stops at the page margin), but it looks worse.
// =============================================================================

import type { ComputedReport, ReportProse } from '../../lib/reports/types';
import { ReportSection } from './ReportSection';
import { Paragraphs } from './parts';
import '../../styles/report.css';

function longDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' });
}

export function ReportDocument({
  report,
  prose,
  pageSize = 'a4',
  periodLabel,
}: {
  report: ComputedReport;
  prose: ReportProse;
  // Which sheet the print stylesheet targets. A4 unless the client is US.
  pageSize?: 'a4' | 'letter';
  periodLabel?: string;
}) {
  const { spec } = report;
  const computedById = new Map(report.sections.map((s) => [s.id, s]));
  const recommendations = [...prose.recommendations].sort((a, b) => a.rank - b.rank);
  const groupNotes = Object.entries(prose.perGroupNotes ?? {});

  return (
    <div className={`report-doc ${pageSize === 'letter' ? 'report-doc--letter' : ''}`}>
      {/* Print-only: paints the warm sheet edge to edge on every page. */}
      <div className="rpt-bleed" aria-hidden="true" />

      <div className="rpt-page">
        {/* ---- Masthead ---- */}
        <header className="rpt-avoid-break mb-9">
          <div className="mb-3 flex items-baseline justify-between gap-4">
            <span className="rpt-eyebrow">{periodLabel ?? 'Performance report'}</span>
            <span className="rpt-eyebrow">{longDate(report.computedAt)}</span>
          </div>
          <h1 className="rpt-title">{spec.title}</h1>
          {spec.subtitle ? <p className="rpt-subtitle mt-2">{spec.subtitle}</p> : null}
          <hr className="rpt-masthead-rule mt-5" />
        </header>

        {/* ---- Executive headline ---- */}
        {prose.headline.title || prose.headline.body ? (
          <section className="rpt-avoid-break mb-8">
            <div className="rpt-card">
              <div className="rpt-label">Summary</div>
              <h2 className="rpt-h2 mt-2">{prose.headline.title}</h2>
              <hr className="rpt-h2-rule mt-2.5" />
              <Paragraphs text={prose.headline.body} className="rpt-lede mt-4" />
            </div>
          </section>
        ) : null}

        {/* ---- Planned sections, in spec order ---- */}
        {spec.sections.map((section) => (
          <ReportSection
            key={section.id}
            spec={section}
            computed={computedById.get(section.id)}
            prose={prose}
          />
        ))}

        {/* ---- Per-group coaching notes ---- */}
        {groupNotes.length > 0 ? (
          <section className="mb-8">
            <div className="rpt-card rpt-flow">
              <div className="rpt-section-head mb-5">
                <h2 className="rpt-h2">Notes by person</h2>
                <hr className="rpt-h2-rule mt-2.5" />
              </div>
              <div className="grid gap-5 sm:grid-cols-2">
                {groupNotes.map(([group, note]) => (
                  <div key={group} className="rpt-avoid-break">
                    <div className="rpt-row-label">{group}</div>
                    <p className="rpt-prose mt-1.5">
                      <span className="rpt-label">Working</span> {note.win}
                    </p>
                    <p className="rpt-prose mt-1.5">
                      <span className="rpt-label">Fix next</span> {note.fix}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </section>
        ) : null}

        {/* ---- Recommendations ---- */}
        {recommendations.length > 0 ? (
          <section className="mb-8">
            <div className="rpt-card rpt-flow">
              <div className="rpt-section-head mb-5">
                <h2 className="rpt-h2">What to do next</h2>
                <hr className="rpt-h2-rule mt-2.5" />
              </div>
              <ol>
                {recommendations.map((r, i) => (
                  <li key={r.rank} className={`rpt-rec flex gap-4 ${i > 0 ? 'mt-5' : ''}`}>
                    <span className="rpt-rec-num shrink-0">{String(r.rank).padStart(2, '0')}</span>
                    <div>
                      <div className="rpt-rec-title">{r.title}</div>
                      <Paragraphs text={r.body} className="rpt-prose mt-1" />
                      {r.target ? <div className="rpt-target mt-1.5">Target {r.target}</div> : null}
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </section>
        ) : null}

        {/* ---- Provenance. Warnings and unplaced columns are surfaced here
                rather than dropped, so the report never overstates what it
                was able to see. ---- */}
        <footer className="rpt-footer rpt-avoid-break mt-10 pt-5">
          {spec.dataDescription ? <p className="mb-3">{spec.dataDescription}</p> : null}

          {spec.warnings.length > 0 ? (
            <div className="mb-3">
              <div className="rpt-label mb-1">Limitations</div>
              <ul>
                {spec.warnings.map((w, i) => (
                  <li key={i}>· {w}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {spec.unmappedColumns.length > 0 ? (
            <div className="mb-3">
              <div className="rpt-label mb-1">Columns not used</div>
              <p>{spec.unmappedColumns.join(' · ')}</p>
            </div>
          ) : null}

          <div className="rpt-label mb-1">Source files</div>
          <p className="rpt-footer-files">{report.sourceFiles.join(' · ') || 'None recorded'}</p>
          <p className="mt-3">
            {report.rowsConsumed.toLocaleString('en-US')} rows read · generated{' '}
            {longDate(report.computedAt)}. Every figure is computed from the source files above.
          </p>
        </footer>
      </div>
    </div>
  );
}
