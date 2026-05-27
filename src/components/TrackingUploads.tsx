// =============================================================================
//  TrackingUploads.tsx
//  Self-contained "CSV upload history" component. Fetches uploads, renders
//  the list, handles delete-with-confirm. Used from Settings.
// =============================================================================

import { useEffect, useState } from 'react';
import { type UploadSummary, listUploads, deleteUpload } from '../lib/tracking';
import { confirm } from '../lib/confirm';
import { toast } from '../lib/toast';
import { formatCents } from '../lib/money';

export function TrackingUploads() {
  const [uploads, setUploads] = useState<UploadSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  async function reload() {
    try {
      const u = await listUploads();
      setUploads(u);
      setLoaded(true);
    } catch (e) {
      setError(e as Error);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  if (!loaded) {
    return (
      <div className="flex h-24 items-center justify-center border border-dashed border-neutral-800 text-[10px] uppercase tracking-widest text-neutral-700">
        Loading…
      </div>
    );
  }
  if (error) {
    return (
      <div className="border border-red-900/60 bg-red-950/30 p-4 text-sm text-red-200">
        {error.message}
      </div>
    );
  }
  if (uploads.length === 0) {
    return (
      <div className="flex h-24 items-center justify-center border border-dashed border-neutral-800 text-[10px] uppercase tracking-widest text-neutral-600">
        No CSV uploads yet.
      </div>
    );
  }

  return (
    <>
      <div
        style={{ gridTemplateColumns: '1fr 5rem 7rem 7rem 5rem' }}
        className="grid gap-3 px-2 pb-2 text-[10px] uppercase tracking-widest text-neutral-600"
      >
        <div>When</div>
        <div className="text-right">Links</div>
        <div className="text-right">Clicks</div>
        <div className="text-right">Earnings</div>
        <div className="text-right"></div>
      </div>

      {/* ~10 rows visible; scrolls for the rest. */}
      <div className="max-h-[32rem] overflow-y-auto divide-y divide-neutral-900">
        {uploads.map((u) => (
          <UploadRow key={u.recorded_at} upload={u} onDeleted={reload} />
        ))}
      </div>
    </>
  );
}

function UploadRow({
  upload,
  onDeleted,
}: {
  upload: UploadSummary;
  onDeleted: () => void;
}) {
  async function handleDelete() {
    const ok = await confirm({
      title: 'Delete this upload?',
      message: `Removes ${upload.snapshot_count} snapshot${upload.snapshot_count === 1 ? '' : 's'} from this CSV import. The links themselves stay — only the data from this upload is removed.`,
      destructive: true,
      confirmLabel: 'Delete upload',
    });
    if (!ok) return;
    try {
      const removed = await deleteUpload(upload.recorded_at);
      toast.success(`Removed ${removed} snapshot${removed === 1 ? '' : 's'}.`);
      onDeleted();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete.');
    }
  }

  const when = new Date(upload.recorded_at);
  const dateLabel = when.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

  return (
    <div
      style={{ gridTemplateColumns: '1fr 5rem 7rem 7rem 5rem' }}
      className="grid items-center gap-3 px-2 py-3"
    >
      <div className="text-sm text-neutral-100">{dateLabel}</div>
      <div className="text-right text-sm tabular-nums text-neutral-300">
        {upload.snapshot_count.toLocaleString()}
      </div>
      <div className="text-right text-sm tabular-nums text-neutral-300">
        {upload.total_clicks.toLocaleString()}
      </div>
      <div className="text-right text-sm tabular-nums text-neutral-100">
        {formatCents(upload.total_earnings_cents)}
      </div>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={handleDelete}
          className="text-[10px] uppercase tracking-widest text-neutral-600 transition-colors hover:text-rose-400"
        >
          Delete
        </button>
      </div>
    </div>
  );
}
