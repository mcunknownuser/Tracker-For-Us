// =============================================================================
//  PaymentLedgerModal
//  All-time payment history for one team member, plus a tamper-evident change
//  log. Two views:
//    • Payments  — active payments by default; "Show deleted" reveals removed
//                  rows inline (dimmed + struck).
//    • Change log — every create/edit/delete event from the audit trail
//                  (append-only; can't be altered through the app).
// =============================================================================
import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import { shortDate } from './MemberEarningsModal';
import { formatCents } from '../lib/money';
import { listMemberPaymentHistory, type LedgerPayment } from '../lib/ofm';
import { listMemberPaymentAudit, type AuditEntry } from '../lib/audit';

type View = 'payments' | 'log';

export function PaymentLedgerModal({
  memberId,
  memberName,
  onClose,
}: {
  memberId: string;
  memberName: string;
  onClose: () => void;
}) {
  const [view, setView] = useState<View>('payments');
  const [rows, setRows] = useState<LedgerPayment[] | null>(null);
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);

  useEffect(() => {
    let alive = true;
    listMemberPaymentHistory(memberId)
      .then((r) => alive && setRows(r))
      .catch((e) => alive && setError(e as Error));
    return () => {
      alive = false;
    };
  }, [memberId]);

  // Lazy-load the audit trail the first time the change log is opened.
  useEffect(() => {
    if (view !== 'log' || audit !== null) return;
    let alive = true;
    listMemberPaymentAudit(memberId)
      .then((a) => alive && setAudit(a))
      .catch((e) => alive && setError(e as Error));
    return () => {
      alive = false;
    };
  }, [view, audit, memberId]);

  const active = (rows ?? []).filter((r) => !r.deleted_at);
  const deletedCount = (rows ?? []).length - active.length;
  const totalPaid = active.reduce((s, r) => s + r.amount_cents, 0);
  const visible = showDeleted ? rows ?? [] : active;

  return (
    <Modal open onClose={onClose} eyebrow="Payment history" title={memberName} maxWidth="max-w-xl">
      {/* View switch */}
      <div className="mb-5 flex gap-1 border border-neutral-800 p-1 text-[10px] font-medium uppercase tracking-widest">
        {(['payments', 'log'] as View[]).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            className={
              'flex-1 py-1.5 transition-colors ' +
              (view === v ? 'bg-neutral-100 text-neutral-950' : 'text-neutral-400 hover:text-neutral-200')
            }
          >
            {v === 'payments' ? 'Payments' : 'Change log'}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-4 flex h-12 items-center justify-center border border-dashed border-red-900/60 text-[10px] uppercase tracking-widest text-red-400">
          {error.message}
        </div>
      )}

      {view === 'payments' ? (
        <>
          <div className="mb-6 flex items-baseline justify-between border-b border-neutral-900 pb-3">
            <div>
              <div className="font-serif text-2xl tabular-nums text-neutral-50">{formatCents(totalPaid)}</div>
              <div className="mt-0.5 text-[10px] uppercase tracking-widest text-neutral-600">
                Total paid · {active.length} payment{active.length === 1 ? '' : 's'}
              </div>
            </div>
            {deletedCount > 0 && (
              <button
                type="button"
                onClick={() => setShowDeleted((s) => !s)}
                className="border border-neutral-700 px-3 py-1.5 text-[10px] font-medium uppercase tracking-widest text-neutral-300 transition-colors hover:border-neutral-500"
              >
                {showDeleted ? 'Hide deleted' : `Show deleted (${deletedCount})`}
              </button>
            )}
          </div>

          {rows === null ? (
            <LoadingRow />
          ) : visible.length === 0 ? (
            <EmptyRow text="No payments recorded." />
          ) : (
            <div className="divide-y divide-neutral-900">
              {visible.map((p) => {
                const isDeleted = !!p.deleted_at;
                return (
                  <div
                    key={p.id}
                    className={'grid grid-cols-[auto_1fr_auto] items-baseline gap-4 py-3 ' + (isDeleted ? 'opacity-50' : '')}
                  >
                    <div className="text-[10px] uppercase tracking-widest text-neutral-500">
                      {shortDate(p.paid_on)}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={'text-sm text-neutral-300 ' + (isDeleted ? 'line-through' : '')}>
                        {p.note ?? ''}
                      </span>
                      {isDeleted && (
                        <span className="border border-red-900/60 px-1.5 py-0.5 text-[8px] font-medium uppercase tracking-widest text-red-400">
                          Deleted
                        </span>
                      )}
                    </div>
                    <div
                      className={
                        'text-right text-sm tabular-nums ' +
                        (isDeleted ? 'text-neutral-500 line-through' : 'text-neutral-100')
                      }
                    >
                      {formatCents(p.amount_cents)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      ) : audit === null ? (
        <LoadingRow />
      ) : audit.length === 0 ? (
        <EmptyRow text="No changes recorded yet." />
      ) : (
        <div className="divide-y divide-neutral-900">
          {audit.map((e) => {
            const d = describeAudit(e);
            return (
              <div key={e.id} className="grid grid-cols-[auto_1fr] items-baseline gap-4 py-3">
                <div className="text-[10px] uppercase tracking-widest text-neutral-500">{fmtWhen(e.created_at)}</div>
                <div>
                  <span
                    className={
                      'mr-2 text-[9px] font-medium uppercase tracking-widest ' +
                      (d.tone === 'create'
                        ? 'text-emerald-400'
                        : d.tone === 'delete'
                          ? 'text-red-400'
                          : 'text-amber-400')
                    }
                  >
                    {d.label}
                  </span>
                  <span className="text-sm text-neutral-300">{d.detail}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

function LoadingRow() {
  return (
    <div className="flex h-16 items-center justify-center border border-dashed border-neutral-800 text-[10px] uppercase tracking-widest text-neutral-600">
      Loading…
    </div>
  );
}

function EmptyRow({ text }: { text: string }) {
  return (
    <div className="flex h-16 items-center justify-center border border-dashed border-neutral-800 text-[10px] uppercase tracking-widest text-neutral-600">
      {text}
    </div>
  );
}

type PayShape = { amount_cents?: number; note?: string | null; paid_on?: string };
const asPay = (v: unknown): PayShape => (v ?? {}) as PayShape;

function describeAudit(e: AuditEntry): { label: string; tone: 'create' | 'update' | 'delete'; detail: string } {
  const prev = asPay(e.prev_value);
  const next = asPay(e.next_value);
  if (e.action === 'create') {
    return {
      label: 'Created',
      tone: 'create',
      detail: `${formatCents(next.amount_cents ?? 0)}${next.note ? ` · ${next.note}` : ''}`,
    };
  }
  if (e.action === 'delete') {
    return { label: 'Deleted', tone: 'delete', detail: `${formatCents(prev.amount_cents ?? 0)} removed` };
  }
  const parts: string[] = [];
  if ((prev.amount_cents ?? 0) !== (next.amount_cents ?? 0)) {
    parts.push(`${formatCents(prev.amount_cents ?? 0)} → ${formatCents(next.amount_cents ?? 0)}`);
  }
  if ((prev.note ?? '') !== (next.note ?? '')) {
    parts.push(`note "${prev.note ?? ''}" → "${next.note ?? ''}"`);
  }
  if ((prev.paid_on ?? '') !== (next.paid_on ?? '')) {
    parts.push(`date ${prev.paid_on ?? '—'} → ${next.paid_on ?? '—'}`);
  }
  return { label: 'Edited', tone: 'update', detail: parts.join(' · ') || 'No field changes' };
}

function fmtWhen(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
