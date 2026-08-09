// =============================================================================
//  Reports.tsx
//  Drop in whatever Infloww exports you have for the week; the pipeline works
//  out what they are and builds a report from them.
//
//  Two layout constraints come from the print path and are not cosmetic:
//    * everything that isn't the document carries `rpt-no-print`
//    * <ReportDocument> is never wrapped in a transformed/animated container —
//      a transform becomes the containing block for the fixed sheet
//      background, and the page colour silently stops after page 1.
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { PageHeader } from '../components/PageHeader';
import { Button } from '../components/FormControls';
import { ReportDocument } from '../components/reports';
import { runReport, type RunResult, type RunStage } from '../lib/reports/run';
import { listRuns, getRun, type StoredRunSummary } from '../lib/reports/store';
import { toast } from '../lib/toast';

const ACCEPT = '.csv,.xlsx,.xls';

const STAGE_LABEL: Record<RunStage, string> = {
  parsing: 'Reading files',
  profiling: 'Inspecting columns',
  planning: 'Working out what this data supports',
  computing: 'Calculating',
  writing: 'Writing commentary',
  saving: 'Saving',
  done: 'Done',
};

export function Reports() {
  const [files, setFiles] = useState<File[]>([]);
  const [stage, setStage] = useState<RunStage | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [runs, setRuns] = useState<StoredRunSummary[] | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const refreshRuns = useCallback(async () => {
    try {
      setRuns(await listRuns({ limit: 12 }));
    } catch {
      setRuns([]); // History is a convenience; never block the page on it.
    }
  }, []);

  useEffect(() => {
    void refreshRuns();
  }, [refreshRuns]);

  function addFiles(list: FileList | null) {
    if (!list) return;
    const picked = Array.from(list);
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => f.name + f.size));
      return [...prev, ...picked.filter((f) => !seen.has(f.name + f.size))];
    });
  }

  async function generate() {
    if (files.length === 0) return;
    setResult(null);
    try {
      const payload = await Promise.all(
        files.map(async (f) => ({ name: f.name, bytes: await f.arrayBuffer() })),
      );
      const run = await runReport({ files: payload, onProgress: (s) => setStage(s) });
      setResult(run);
      void refreshRuns();
      toast.success(
        run.specReused
          ? 'Report generated using the saved layout for these files.'
          : 'Report generated. This layout is now saved for future uploads of the same export.',
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not generate the report.');
    } finally {
      setStage(null);
    }
  }

  // Export = a standalone document (report + stylesheet, nothing else), where
  // the app page would drag the sidebar into the PDF and clip the document to
  // its scroll container. Three environments, three paths:
  //   Browser, popups allowed → dedicated window + print dialog.
  //   Browser, popup blocked  → print in place (report.css hides app chrome).
  //   Desktop app (Tauri)     → the webview cannot print at all, so download
  //                             the document as an .html file; the default
  //                             browser prints it to PDF from there.
  async function exportPdf() {
    const doc = document.querySelector('.report-doc');
    if (!doc) return;
    const title = result?.report.computed.spec.title ?? 'Report';
    const isTauri = '__TAURI_INTERNALS__' in window;

    // Open the window BEFORE any await. Safari honours window.open only while
    // the click's user activation is live, and an await ends it — opened
    // late, the popup is silently blocked and Safari prints the whole app.
    const win = isTauri ? null : window.open('', '_blank');

    const { default: css } = await import('../styles/report.css?raw');
    const html =
      `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
      `<style>html,body{margin:0;padding:0}</style><style>${css}</style></head>` +
      `<body>${doc.outerHTML}</body></html>`;

    if (win) {
      win.document.write(html);
      win.document.close();
      // One beat for fonts and layout before the dialog opens.
      setTimeout(() => {
        win.focus();
        win.print();
      }, 300);
      return;
    }

    if (isTauri) {
      // Anchor-download is silently ignored by the webview, so the export
      // goes through a native command: Rust writes the file to Downloads and
      // opens it in the default browser, which CAN print.
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const path = await invoke<string>('save_report_html', { title, html });
        toast.success(
          `Report opened in your browser — use Print → "Save as PDF" there. (Saved to ${path})`,
        );
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
      return;
    }

    // Popup blocked: print in place. report.css's print rules hide the app
    // shell and un-clip the document when a report is on the page.
    window.print();
  }

  async function openRun(id: string) {
    try {
      const run = await getRun(id);
      if (!run) return toast.error('That report is no longer available.');
      setResult({
        report: { computed: run.computed, prose: run.prose },
        spec: run.computed.spec,
        profile: { tables: [], signature: '' },
        specReused: true,
        runId: run.id,
        warnings: [],
      });
      setFiles([]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not open that report.');
    }
  }

  const busy = stage !== null;

  return (
    <>
      <div className="rpt-no-print">
        <PageHeader
          eyebrow="Reporting"
          title="Reports"
          subtitle="Drop in this week's Infloww exports. The report is built from whatever they contain."
          actions={
            result ? (
              <>
                <Button variant="ghost" onClick={() => { setResult(null); setFiles([]); }}>
                  New report
                </Button>
                <Button onClick={() => void exportPdf()}>Save as PDF</Button>
              </>
            ) : undefined
          }
        />

        {!result && (
          <>
            <div
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}
              onClick={() => inputRef.current?.click()}
              className={`cursor-pointer rounded-lg border border-dashed p-12 text-center transition-colors ${
                dragging ? 'border-neutral-400 bg-neutral-900/40' : 'border-neutral-800 hover:border-neutral-700'
              }`}
            >
              <p className="font-serif text-xl text-neutral-200">Drop exports here</p>
              <p className="mt-2 text-sm text-neutral-500">
                Excel or CSV — Top Fans, Employee Performance, Sales Record, or anything else
                Infloww gives you. Several files at once is fine.
              </p>
              <input
                ref={inputRef}
                type="file"
                multiple
                accept={ACCEPT}
                className="hidden"
                onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
              />
            </div>

            {files.length > 0 && (
              <div className="mt-6">
                <ul className="divide-y divide-neutral-900 border-y border-neutral-900">
                  {files.map((f) => (
                    <li key={f.name + f.size} className="flex items-center justify-between py-3">
                      <span className="text-sm text-neutral-300">{f.name}</span>
                      <button
                        onClick={() => setFiles((prev) => prev.filter((p) => p !== f))}
                        className="text-xs uppercase tracking-editorial text-neutral-500 hover:text-neutral-300"
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="mt-6 flex items-center gap-4">
                  <Button onClick={generate} loading={busy} disabled={busy}>
                    Generate report
                  </Button>
                  {stage && <span className="text-sm text-neutral-500">{STAGE_LABEL[stage]}…</span>}
                </div>
              </div>
            )}

            {runs && runs.length > 0 && (
              <section className="mt-16">
                <h2 className="mb-4 text-[11px] font-medium uppercase tracking-editorial text-neutral-500">
                  Previous reports
                </h2>
                <ul className="divide-y divide-neutral-900 border-y border-neutral-900">
                  {runs.map((r) => (
                    <li key={r.id}>
                      <button
                        onClick={() => openRun(r.id)}
                        className="flex w-full items-center justify-between py-3 text-left hover:opacity-70"
                      >
                        <span className="text-sm text-neutral-300">{r.title}</span>
                        <span className="text-xs text-neutral-600">
                          {r.period_label ?? new Date(r.created_at).toLocaleDateString()}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}

        {result && result.warnings.length > 0 && (
          <div className="mb-8 rounded-md border border-amber-900/60 bg-amber-950/20 p-4">
            <p className="mb-2 text-[11px] font-medium uppercase tracking-editorial text-amber-500">
              Worth knowing
            </p>
            <ul className="space-y-1 text-sm text-amber-200/80">
              {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </div>
        )}
      </div>

      {/* Never wrap this in a transformed container — see the header note. */}
      {result && (
        <ReportDocument report={result.report.computed} prose={result.report.prose} />
      )}
    </>
  );
}
