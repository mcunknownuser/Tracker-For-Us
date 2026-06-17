// =============================================================================
//  StatementExportModal
//  Pick people (one / some / all), a month range, and a format (PDF or CSV),
//  then export per-person earnings statements. Department-agnostic: the page
//  supplies the selectable members + an async builder that knows its own
//  earnings model.
// =============================================================================
import { useMemo, useState } from 'react';
import { Modal } from './Modal';
import { Button } from './FormControls';
import { useActiveAgency } from '../lib/agency';
import { currentMonthKey, shiftMonthKey, monthLongLabel } from '../lib/ofm';
import {
  type Statement,
  periodLabel,
  statementsToCSV,
  downloadCSV,
  savePDF,
} from '../lib/statements';
import { toast } from '../lib/toast';

export type ExportMember = { id: string; name: string; roleLabel: string };

export function StatementExportModal({
  members,
  onBuild,
  onClose,
}: {
  members: ExportMember[];
  onBuild: (ids: string[], fromMonth: string, toMonth: string) => Promise<Statement[]>;
  onClose: () => void;
}) {
  const { agency } = useActiveAgency();
  const agencyName = agency?.name ?? 'Statement';

  const monthOptions = useMemo(() => {
    const cur = currentMonthKey();
    return Array.from({ length: 24 }, (_, i) => {
      const key = shiftMonthKey(cur, -i);
      return { key, label: monthLongLabel(key) };
    });
  }, []);

  const [from, setFrom] = useState(currentMonthKey());
  const [to, setTo] = useState(currentMonthKey());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [format, setFormat] = useState<'pdf' | 'csv'>('pdf');
  const [busy, setBusy] = useState(false);

  const allSelected = selected.size === members.length && members.length > 0;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function generate() {
    if (selected.size === 0) {
      toast.error('Select at least one person.');
      return;
    }
    setBusy(true);
    try {
      const statements = await onBuild([...selected], from, to);
      if (statements.length === 0) {
        toast.error('Nothing to export for that selection.');
        return;
      }
      const period = periodLabel(from, to);
      if (format === 'csv') {
        downloadCSV(`statements-${from}_to_${to}.csv`, statementsToCSV(statements, agencyName, period));
      } else {
        savePDF(statements, agencyName, period, `statements-${from}_to_${to}.pdf`);
      }
      toast.success(`Exported ${statements.length} statement${statements.length === 1 ? '' : 's'}.`);
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Export failed.');
    } finally {
      setBusy(false);
    }
  }

  const monthSelect = (value: string, onChange: (v: string) => void) => (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 focus:border-neutral-500 focus:outline-none"
    >
      {monthOptions.map((o) => (
        <option key={o.key} value={o.key}>
          {o.label}
        </option>
      ))}
    </select>
  );

  return (
    <Modal open onClose={onClose} eyebrow="Export" title="Statements" maxWidth="max-w-lg">
      {/* Time frame */}
      <div className="mb-6">
        <div className="mb-2 text-[10px] font-medium uppercase tracking-widest text-neutral-500">Time frame</div>
        <div className="flex items-center gap-3">
          {monthSelect(from, setFrom)}
          <span className="text-neutral-600">→</span>
          {monthSelect(to, setTo)}
        </div>
      </div>

      {/* People */}
      <div className="mb-6">
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-[10px] font-medium uppercase tracking-widest text-neutral-500">
            People · {selected.size}/{members.length}
          </span>
          <button
            type="button"
            onClick={() => setSelected(allSelected ? new Set() : new Set(members.map((m) => m.id)))}
            className="text-[10px] font-medium uppercase tracking-widest text-neutral-400 hover:text-neutral-200"
          >
            {allSelected ? 'Clear all' : 'Select all'}
          </button>
        </div>
        <div className="max-h-56 overflow-y-auto border border-neutral-800 divide-y divide-neutral-900">
          {members.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => toggle(m.id)}
              className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-neutral-900"
            >
              <span
                className={
                  'flex h-4 w-4 shrink-0 items-center justify-center border text-[9px] ' +
                  (selected.has(m.id)
                    ? 'border-neutral-100 bg-neutral-100 text-neutral-950'
                    : 'border-neutral-600 text-transparent')
                }
              >
                ✓
              </span>
              <span className="text-sm text-neutral-200">{m.name}</span>
              <span className="ml-auto text-[10px] uppercase tracking-widest text-neutral-600">{m.roleLabel}</span>
            </button>
          ))}
          {members.length === 0 && (
            <div className="px-3 py-4 text-center text-[10px] uppercase tracking-widest text-neutral-600">
              No people to export.
            </div>
          )}
        </div>
      </div>

      {/* Format */}
      <div className="mb-7">
        <div className="mb-2 text-[10px] font-medium uppercase tracking-widest text-neutral-500">Format</div>
        <div className="flex gap-1 border border-neutral-800 p-1 text-[11px] font-medium uppercase tracking-widest">
          {(['pdf', 'csv'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFormat(f)}
              className={
                'flex-1 py-2 transition-colors ' +
                (format === f ? 'bg-neutral-100 text-neutral-950' : 'text-neutral-400 hover:text-neutral-200')
              }
            >
              {f === 'pdf' ? 'PDF' : 'CSV'}
            </button>
          ))}
        </div>
      </div>

      <Button onClick={generate} disabled={busy} className="w-full">
        {busy ? 'Generating…' : format === 'pdf' ? 'Generate PDF' : 'Download CSV'}
      </Button>
    </Modal>
  );
}
