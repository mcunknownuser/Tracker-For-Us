// =============================================================================
//  MemberEarningsModal
//  Generic, department-agnostic earnings drill-down. Shows HOW an "owed"
//  figure was built — the basis math (earned), what's been paid, the
//  resulting balance, and the underlying line items as receipts.
//
//  Each page computes its own basis line + activity sections (OFM passes
//  sales/withdrawals; Reddit passes per-account income) and feeds them in.
//  The reconciliation (earned − paid = owed) is identical everywhere.
// =============================================================================
import { Modal } from './Modal';
import { formatCents } from '../lib/money';

export type ActivityItem = {
  id: string;
  date: string;
  amountCents: number;
  note: string | null;
  onClick?: () => void;
};

export type ActivitySection = {
  title: string;
  empty: string;
  items: ActivityItem[];
};

export function shortDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y!, m! - 1, d!).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

export function MemberEarningsModal({
  title,
  eyebrow,
  basisLine,
  earnedCents,
  paidCents,
  sections,
  onClose,
  onViewHistory,
}: {
  title: string;
  eyebrow: string;
  basisLine: string;
  earnedCents: number;
  paidCents: number;
  sections: ActivitySection[];
  onClose: () => void;
  onViewHistory?: () => void;
}) {
  const owedCents = Math.max(0, earnedCents - paidCents);
  return (
    <Modal open onClose={onClose} eyebrow={eyebrow} title={title} maxWidth="max-w-xl">
      {/* How the owed figure was built — auditable, not just displayed. */}
      <section className="mb-8">
        <div className="mb-3 flex items-baseline justify-between border-b border-neutral-900 pb-2">
          <h3 className="font-serif text-lg font-medium tracking-tight text-neutral-100">
            Earnings
          </h3>
          <span className="text-[10px] font-medium uppercase tracking-editorial text-neutral-600">
            this month
          </span>
        </div>
        <div className="space-y-2 text-sm">
          <div className="flex items-baseline justify-between gap-4">
            <span className="text-neutral-400">{basisLine}</span>
            <span className="tabular-nums text-neutral-100">{formatCents(earnedCents)}</span>
          </div>
          <div className="flex items-baseline justify-between gap-4">
            <span className="text-neutral-400">Paid this month</span>
            <span className="tabular-nums text-neutral-400">− {formatCents(paidCents)}</span>
          </div>
          <div className="flex items-baseline justify-between gap-4 border-t border-neutral-900 pt-2">
            <span className="font-medium text-neutral-200">Owed</span>
            <span className="font-medium tabular-nums text-neutral-100">{formatCents(owedCents)}</span>
          </div>
        </div>
      </section>

      {sections.map((s) => (
        <ActivityList key={s.title} title={s.title} empty={s.empty} items={s.items} />
      ))}

      {onViewHistory && (
        <button
          type="button"
          onClick={onViewHistory}
          className="mt-2 w-full border border-neutral-800 py-2.5 text-[10px] font-medium uppercase tracking-widest text-neutral-400 transition-colors hover:border-neutral-600 hover:text-neutral-200"
        >
          View full payment history →
        </button>
      )}
    </Modal>
  );
}

export function ActivityList({ title, empty, items }: ActivitySection) {
  const total = items.reduce((s, i) => s + i.amountCents, 0);
  return (
    <section className="mb-8 last:mb-0">
      <div className="mb-3 flex items-baseline justify-between border-b border-neutral-900 pb-2">
        <div className="flex items-baseline gap-3">
          <h3 className="font-serif text-lg font-medium tracking-tight text-neutral-100">
            {title}
          </h3>
          <span className="text-[10px] font-medium uppercase tracking-editorial text-neutral-600">
            {items.length}
          </span>
        </div>
        <span className="text-sm text-neutral-300">{formatCents(total)}</span>
      </div>
      {items.length === 0 ? (
        <div className="flex h-16 items-center justify-center border border-dashed border-neutral-800 text-[10px] uppercase tracking-widest text-neutral-600">
          {empty}
        </div>
      ) : (
        <div className="divide-y divide-neutral-900">
          {items.map((i) => {
            const inner = (
              <>
                <div className="text-[10px] uppercase tracking-widest text-neutral-500">
                  {shortDate(i.date)}
                </div>
                <div className="text-sm text-neutral-300">{i.note ?? ''}</div>
                <div className="text-right text-sm tabular-nums text-neutral-100">
                  {formatCents(i.amountCents)}
                </div>
              </>
            );
            return i.onClick ? (
              <button
                key={i.id}
                type="button"
                onClick={i.onClick}
                className="grid w-full grid-cols-[auto_1fr_auto] items-baseline gap-4 py-3 text-left transition-colors hover:bg-neutral-900"
              >
                {inner}
              </button>
            ) : (
              <div
                key={i.id}
                className="grid w-full grid-cols-[auto_1fr_auto] items-baseline gap-4 py-3 text-left"
              >
                {inner}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
