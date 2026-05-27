// =============================================================================
//  OFM.tsx
//  Per-team-member operations: who earned what, who got paid, who's owed.
//  Quick "Log sale / Log withdrawal / Log payment" actions.
// =============================================================================

import { useEffect, useMemo, useState } from 'react';
import { PageHeader } from '../components/PageHeader';
import { Modal } from '../components/Modal';
import { Button, Field, Label, TextLink } from '../components/FormControls';
import { Select } from '../components/Select';
import { DatePicker } from '../components/DatePicker';
import {
  type TeamMember,
  listTeamMembers,
  listMemberNameMap,
  listMemberDeptMap,
  formatPayLine,
  isActiveInMonth,
  isFormer,
} from '../lib/teamMembers';
import {
  type ChatterSale,
  type ModelWithdrawal,
  type Payment,
  type MemberSummary,
  buildSummaries,
  createSale,
  createWithdrawal,
  createPayment,
  updateSale,
  updateWithdrawal,
  updatePayment,
  softDeleteSale,
  softDeleteWithdrawal,
  softDeletePayment,
  listSales,
  listWithdrawals,
  listPayments,
  currentMonthKey,
  shiftMonthKey,
  monthLongLabel,
} from '../lib/ofm';
import { confirm } from '../lib/confirm';
import { formatCents, parseDollarsToCents } from '../lib/money';
import { payStructureLabel } from '../lib/staffRoles';
import { toast } from '../lib/toast';

type EntryKind = 'sale' | 'withdrawal' | 'payment';

// What "log" buttons make sense for a single team member, based on
// which section they appear in. Shared between section-header buttons
// (no memberId) and per-row hover buttons (memberId prefilled).
//   commission → Log sale + Log payment
//   share      → Log withdrawal + Log payment
//   flat       → Log payment only
function rowLogButtons(
  kind: 'commission' | 'share' | 'flat',
): { entryKind: EntryKind; label: string; primary?: boolean }[] {
  if (kind === 'commission') {
    return [
      { entryKind: 'sale', label: '+ Log sale', primary: true },
      { entryKind: 'payment', label: '+ Log payment' },
    ];
  }
  if (kind === 'share') {
    return [
      { entryKind: 'withdrawal', label: '+ Log withdrawal', primary: true },
      { entryKind: 'payment', label: '+ Log payment' },
    ];
  }
  return [{ entryKind: 'payment', label: '+ Log payment', primary: true }];
}

// =============================================================================
//  Page
// =============================================================================
// `departmentId` (optional) scopes the page to one department's team members.
// Sales/withdrawals/payments are attached to team_members, so filtering
// members also implicitly filters their entries.
// `departmentName` overrides the page title when this page is rendered as a
// department tab (e.g. "Upwork." instead of the generic "OFM.").
export function OFM({
  departmentId,
  departmentName,
}: { departmentId?: string; departmentName?: string } = {}) {
  const [monthKey, setMonthKey] = useState(currentMonthKey());
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [sales, setSales] = useState<ChatterSale[]>([]);
  const [withdrawals, setWithdrawals] = useState<ModelWithdrawal[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [summaries, setSummaries] = useState<MemberSummary[] | null>(null);
  // Includes soft-deleted members too, so breakdowns can still show real
  // names for sales/withdrawals attached to people who've since left.
  const [nameById, setNameById] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<Error | null>(null);
  // Modal state holds both the entry kind AND (optionally) a prefilled
  // team member id. Inline "log" buttons that appear on row hover use
  // the prefill so the user doesn't have to re-select the person they
  // just clicked into.
  const [modal, setModal] = useState<{ kind: EntryKind; prefilledMemberId?: string } | null>(null);
  const openLog = (kind: EntryKind, prefilledMemberId?: string) =>
    setModal({ kind, prefilledMemberId });
  const [activityMember, setActivityMember] = useState<TeamMember | null>(null);
  const [openStat, setOpenStat] = useState<StatKey | null>(null);
  const [editingEntry, setEditingEntry] = useState<
    | { kind: 'sale'; entry: ChatterSale }
    | { kind: 'withdrawal'; entry: ModelWithdrawal }
    | { kind: 'payment'; entry: Payment }
    | null
  >(null);

  async function reload(key = monthKey) {
    try {
      const [allMembers, s, w, p, names, deptMap] = await Promise.all([
        listTeamMembers(),
        listSales(key),
        listWithdrawals(key),
        listPayments(key),
        listMemberNameMap(),
        // Includes soft-deleted members too, so transactions from removed
        // staff still get attributed to the right department.
        listMemberDeptMap(),
      ]);
      // Three scopes here:
      //   * activeDeptMembers — non-deleted members currently in this dept.
      //     Drives the team row list at the bottom.
      //   * deptMemberIds — id set of EVERY member (active or soft-deleted)
      //     who is/was in this department. Drives the transaction filter
      //     so we don't lose Angel's $1,000 just because she was deleted.
      //   * displayMembers — subset of activeDeptMembers, narrowed to
      //     "active this month" for the team list.
      const activeDeptMembers = departmentId
        ? allMembers.filter((m) => m.department_id === departmentId)
        : allMembers;
      const deptMemberIds = new Set<string>();
      if (departmentId) {
        for (const [id, deptId] of deptMap) {
          if (deptId === departmentId) deptMemberIds.add(id);
        }
      } else {
        for (const id of deptMap.keys()) deptMemberIds.add(id);
      }
      const displayMembers = activeDeptMembers.filter((m) => isActiveInMonth(m, key));

      // Filter transactions to those attached to anyone (active or removed)
      // who was in this department. Cross-department transactions are
      // dropped; historical transactions from soft-deleted staff are kept.
      const sScoped = s.filter((x) => deptMemberIds.has(x.team_member_id));
      const wScoped = w.filter((x) => deptMemberIds.has(x.team_member_id));
      const pScoped = p.filter((x) => deptMemberIds.has(x.team_member_id));

      setMembers(displayMembers);
      setSales(sScoped);
      setWithdrawals(wScoped);
      setPayments(pScoped);
      // Build summaries from activeDeptMembers (non-deleted only). Soft-
      // deleted members' transactions still get counted in the headline
      // aggregates because they're now in sScoped/wScoped, but they don't
      // get rendered as their own row.
      setSummaries(buildSummaries(activeDeptMembers, sScoped, wScoped, pScoped, key));
      setNameById(names);
    } catch (e) {
      setError(e as Error);
    }
  }

  useEffect(() => {
    void reload(monthKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthKey, departmentId]);

  const loading = members === null || summaries === null;

  // Aggregate totals — the 8 top-of-page stats.
  //
  // Two data sources here:
  //   * Raw arrays (`sales`, `withdrawals`) — feed gross revenue. They
  //     include transactions from staff who've since been removed, so
  //     the headline matches the breakdown sum below.
  //   * `summaries` — feeds per-member earnings (modelsCut, chattersCut,
  //     flatPay, paid, owed). Only includes currently-listed staff since
  //     we can't compute commission/share for a deleted member (their
  //     pay structure is gone).
  const stats = useMemo(() => {
    if (!summaries) return null;
    const salesTotal       = sales.reduce((n, s) => n + s.amount_cents, 0);
    const withdrawalsTotal = withdrawals.reduce((n, w) => n + w.amount_cents, 0);

    let paid = 0;
    let owed = 0;
    let modelsCut = 0;
    let chattersCut = 0;
    let flatPay = 0;
    let modelCount = 0;
    let chatterCount = 0;
    let flatCount = 0;
    for (const s of summaries) {
      paid += s.paidCents;
      if (!isFormer(s.member)) owed += s.owedCents;
      const active = !isFormer(s.member);
      if (s.member.pay_structure === 'share') {
        modelsCut += s.earnedCents;
        if (active) modelCount += 1;
      } else if (s.member.pay_structure === 'commission') {
        chattersCut += s.earnedCents;
        if (active) chatterCount += 1;
      } else {
        flatPay += s.earnedCents;
        if (active) flatCount += 1;
      }
    }
    const grossRevenue = withdrawalsTotal + salesTotal;
    const totalPayouts = modelsCut + chattersCut + flatPay;
    const netProfit = grossRevenue - totalPayouts;
    const marginPct = grossRevenue > 0 ? (netProfit / grossRevenue) * 100 : 0;
    return {
      grossRevenue,
      netProfit,
      totalPayouts,
      paid,
      owed,
      modelsCut,
      chattersCut,
      flatPay,
      modelCount,
      chatterCount,
      flatCount,
      marginPct,
    };
  }, [summaries, sales, withdrawals]);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        eyebrow={departmentName ? 'Department · Models' : 'OnlyFans management'}
        title={departmentName ? `${departmentName}.` : 'OFM.'}
        subtitle="Sales, withdrawals, and payouts. Tracked per team member."
        actions={
          <>
            <button
              onClick={() => openLog('payment')}
              disabled={loading}
              className="border border-neutral-800 px-4 py-3 text-[11px] font-medium uppercase tracking-widest text-neutral-200 transition-colors hover:border-neutral-500 disabled:opacity-40"
            >
              Log payment
            </button>
            <button
              onClick={() => openLog('sale')}
              disabled={loading}
              className="border border-neutral-800 px-4 py-3 text-[11px] font-medium uppercase tracking-widest text-neutral-200 transition-colors hover:border-neutral-500 disabled:opacity-40"
            >
              Log sale
            </button>
            <button
              onClick={() => openLog('withdrawal')}
              disabled={loading}
              className="bg-neutral-50 px-4 py-3 text-[11px] font-medium uppercase tracking-widest text-neutral-950 transition-colors hover:bg-neutral-300 disabled:opacity-40"
            >
              Log withdrawal
            </button>
          </>
        }
      />

      {error && (
        <div className="mb-6 border border-red-900/60 bg-red-950/30 p-4 text-sm text-red-200">
          {error.message}
        </div>
      )}

      <MonthPicker monthKey={monthKey} onChange={setMonthKey} />

      {loading ? (
        <Loading />
      ) : members!.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          {stats && (
            <TopStats
              stats={stats}
              withdrawalsCount={withdrawals.length}
              salesCount={sales.length}
              onOpen={setOpenStat}
            />
          )}

          {/* Team rows only show staff active this month. Summaries
              themselves include former-but-in-dept members so the money
              aggregates above stay correct, but listing ex-staff in the
              roster would be confusing. */}
          <SummarySection
            title="Chatters"
            description="Commission on sales."
            rows={summaries!.filter(
              (s) => s.member.pay_structure === 'commission' && isActiveInMonth(s.member, monthKey),
            )}
            kind="commission"
            onMemberClick={setActivityMember}
            onLogEntry={openLog}
          />
          <SummarySection
            title="Models"
            description="Share of withdrawals."
            rows={summaries!.filter(
              (s) => s.member.pay_structure === 'share' && isActiveInMonth(s.member, monthKey),
            )}
            kind="share"
            onMemberClick={setActivityMember}
            onLogEntry={openLog}
          />
          <SummarySection
            title="Flat-paid"
            description="Salaried staff."
            rows={summaries!.filter(
              (s) => s.member.pay_structure === 'flat' && isActiveInMonth(s.member, monthKey),
            )}
            kind="flat"
            onMemberClick={setActivityMember}
            onLogEntry={openLog}
          />
        </>
      )}

      {modal && members && (
        <EntryFormModal
          kind={modal.kind}
          prefilledMemberId={modal.prefilledMemberId}
          members={members}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            void reload(monthKey);
          }}
        />
      )}

      {activityMember && (
        <MemberActivityModal
          member={activityMember}
          monthLabel={monthLongLabel(monthKey)}
          sales={sales.filter((s) => s.team_member_id === activityMember.id)}
          withdrawals={withdrawals.filter((w) => w.team_member_id === activityMember.id)}
          payments={payments.filter((p) => p.team_member_id === activityMember.id)}
          onClose={() => setActivityMember(null)}
          onEditSale={(s) => setEditingEntry({ kind: 'sale', entry: s })}
          onEditWithdrawal={(w) => setEditingEntry({ kind: 'withdrawal', entry: w })}
          onEditPayment={(p) => setEditingEntry({ kind: 'payment', entry: p })}
        />
      )}

      {editingEntry && (
        <EditEntryModal
          editingEntry={editingEntry}
          onClose={() => setEditingEntry(null)}
          onSaved={() => {
            setEditingEntry(null);
            void reload(monthKey);
          }}
        />
      )}

      {openStat && stats && summaries && (
        <StatDetailModal
          statKey={openStat}
          monthLabel={monthLongLabel(monthKey)}
          stats={stats}
          summaries={summaries}
          sales={sales}
          withdrawals={withdrawals}
          nameById={nameById}
          onClose={() => setOpenStat(null)}
          onNavigate={setOpenStat}
          onEditSale={(s) => {
            setOpenStat(null);
            setEditingEntry({ kind: 'sale', entry: s });
          }}
          onEditWithdrawal={(w) => {
            setOpenStat(null);
            setEditingEntry({ kind: 'withdrawal', entry: w });
          }}
        />
      )}
    </div>
  );
}

// =============================================================================
//  Month picker — two arrows + month label, jump-to-today on click
// =============================================================================
function MonthPicker({
  monthKey,
  onChange,
}: {
  monthKey: string;
  onChange: (k: string) => void;
}) {
  return (
    <div className="mb-10 flex items-center gap-4">
      <button
        type="button"
        onClick={() => onChange(shiftMonthKey(monthKey, -1))}
        className="border border-neutral-800 px-3 py-1.5 text-[11px] uppercase tracking-widest text-neutral-400 transition-colors hover:border-neutral-500 hover:text-neutral-100"
      >
        ← Prev
      </button>
      <button
        type="button"
        onClick={() => onChange(currentMonthKey())}
        className="font-serif text-xl font-semibold tracking-tight text-neutral-100 hover:text-neutral-300"
        title="Jump to current month"
      >
        {monthLongLabel(monthKey)}
      </button>
      <button
        type="button"
        onClick={() => onChange(shiftMonthKey(monthKey, 1))}
        className="border border-neutral-800 px-3 py-1.5 text-[11px] uppercase tracking-widest text-neutral-400 transition-colors hover:border-neutral-500 hover:text-neutral-100"
      >
        Next →
      </button>
    </div>
  );
}

// =============================================================================
//  Top stats — 8 boxes (2 rows of 4 on lg screens)
// =============================================================================
type Stats = {
  grossRevenue: number;
  netProfit: number;
  totalPayouts: number;
  paid: number;
  owed: number;
  modelsCut: number;
  chattersCut: number;
  flatPay: number;
  modelCount: number;
  chatterCount: number;
  flatCount: number;
  marginPct: number;
};

type StatKey =
  | 'gross-revenue'
  | 'net-profit'
  | 'total-payouts'
  | 'currently-owed'
  | 'models-cut'
  | 'chatters-cut'
  | 'flat-paid'
  | 'margin';

function TopStats({
  stats,
  withdrawalsCount,
  salesCount,
  onOpen,
}: {
  stats: Stats;
  withdrawalsCount: number;
  salesCount: number;
  onOpen: (key: StatKey) => void;
}) {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return (
    <div className="mb-12">
      {/* Primary row — the 4 headline numbers, bigger boxes. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          tier="primary"
          label="Gross revenue"
          value={formatCents(stats.grossRevenue)}
          hint={`${plural(withdrawalsCount, 'withdrawal')} · ${plural(salesCount, 'sale')}`}
          onClick={() => onOpen('gross-revenue')}
        />
        <Stat
          tier="primary"
          label="Net profit"
          value={formatCents(stats.netProfit)}
          hint={
            stats.grossRevenue > 0
              ? `${stats.marginPct.toFixed(0)}% kept after payouts`
              : 'No revenue yet'
          }
          onClick={() => onOpen('net-profit')}
        />
        <Stat
          tier="primary"
          label="Total payouts"
          value={formatCents(stats.totalPayouts)}
          hint={`${formatCents(stats.paid)} paid · ${formatCents(stats.owed)} owed`}
          onClick={() => onOpen('total-payouts')}
        />
        <Stat
          tier="primary"
          label="Currently owed"
          value={formatCents(stats.owed)}
          hint="Outstanding to team"
          onClick={() => onOpen('currently-owed')}
        />
      </div>

      {/* Secondary row — supporting breakdown, smaller boxes. */}
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          tier="secondary"
          label="Models' cut"
          value={formatCents(stats.modelsCut)}
          hint={`${plural(stats.modelCount, 'model')} · share of withdrawals`}
          onClick={() => onOpen('models-cut')}
        />
        <Stat
          tier="secondary"
          label="Chatters' cut"
          value={formatCents(stats.chattersCut)}
          hint={`${plural(stats.chatterCount, 'chatter')} · % of sales`}
          onClick={() => onOpen('chatters-cut')}
        />
        <Stat
          tier="secondary"
          label="Flat-paid"
          value={formatCents(stats.flatPay)}
          hint={plural(stats.flatCount, 'employee')}
          onClick={() => onOpen('flat-paid')}
        />
        <Stat
          tier="secondary"
          label="Margin"
          value={`${stats.marginPct.toFixed(1)}%`}
          hint="Net profit ÷ gross revenue"
          onClick={() => onOpen('margin')}
        />
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  tier,
  onClick,
}: {
  label: string;
  value: string;
  hint?: string;
  tier: 'primary' | 'secondary';
  onClick: () => void;
}) {
  const isPrimary = tier === 'primary';
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'group border border-neutral-800 bg-neutral-950 text-left transition-colors hover:border-neutral-700 hover:bg-neutral-900 ' +
        (isPrimary ? 'p-7' : 'p-6')
      }
    >
      <div className="text-[10px] font-medium uppercase tracking-editorial text-neutral-500">
        {label}
      </div>
      <div
        className={
          'mt-3 font-serif font-semibold tabular-nums tracking-tight text-neutral-50 ' +
          (isPrimary ? 'text-4xl' : 'text-2xl')
        }
      >
        {value}
      </div>
      {hint && (
        <div className="mt-2 text-[10px] uppercase tracking-widest text-neutral-600">
          {hint}
        </div>
      )}
    </button>
  );
}

// =============================================================================
//  Summary section per pay structure
// =============================================================================
function SummarySection({
  title,
  description,
  rows,
  kind,
  onMemberClick,
  onLogEntry,
}: {
  title: string;
  description: string;
  rows: MemberSummary[];
  kind: 'commission' | 'share' | 'flat';
  onMemberClick: (m: TeamMember) => void;
  // Opens the matching "log new entry" modal. Called from two places:
  //   * section-header buttons (no memberId — pick from dropdown)
  //   * row hover buttons     (memberId pre-filled for that member)
  onLogEntry: (entry: EntryKind, prefilledMemberId?: string) => void;
}) {
  if (rows.length === 0) return null;

  // All three sections now share the same 6-column shape. For flat-paid,
  // the "gross" column shows sales attributed to that employee — they can
  // bring in revenue too, the agency just doesn't pay them on commission.
  const gridStyle = {
    gridTemplateColumns: '1fr 7rem 7rem 7rem 7rem 7rem',
  };

  // Same button set as the per-row hover actions, sourced from the
  // shared helper so the two stay in sync.
  const logButtons = rowLogButtons(kind);

  return (
    <section className="mb-12">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3 border-b border-neutral-800 pb-3">
        <div className="flex items-baseline gap-3">
          <h2 className="font-serif text-2xl font-semibold tracking-tight text-neutral-100">
            {title}
          </h2>
          <span className="text-[10px] font-medium uppercase tracking-editorial text-neutral-500">
            {rows.length}
          </span>
          <span className="hidden text-xs text-neutral-500 md:inline">{description}</span>
        </div>
        <div className="flex items-center gap-2">
          {logButtons.map((b) => (
            <button
              key={b.entryKind}
              type="button"
              onClick={() => onLogEntry(b.entryKind)}
              className={
                'px-3 py-1.5 text-[10px] font-medium uppercase tracking-widest transition-colors ' +
                (b.primary
                  ? 'bg-neutral-50 text-neutral-950 hover:bg-neutral-200 active:bg-neutral-300'
                  : 'border border-neutral-800 text-neutral-300 hover:border-neutral-500 hover:text-neutral-100')
              }
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>

      {/* Header */}
      <div
        style={gridStyle}
        className="grid gap-4 px-2 pb-2 text-[10px] uppercase tracking-widest text-neutral-600"
      >
        <div>Member</div>
        <div className="text-right">
          {kind === 'share' ? 'Withdrawals' : 'Sales'}
        </div>
        <div className="text-right">Their share</div>
        <div className="text-right">Your share</div>
        <div className="text-right">Paid</div>
        <div className="text-right">Owed</div>
      </div>

      <div className="divide-y divide-neutral-900">
        {rows.map((r) => {
          // For flat-paid, "gross" is also chatter sales attributed to the
          // member. They still bring in revenue even if their pay is fixed.
          const grossCents =
            kind === 'share' ? r.withdrawalsCents : r.salesCents;
          const yourShareCents = grossCents - r.earnedCents;
          return (
            <div
              key={r.member.id}
              className="group relative transition-colors hover:bg-neutral-900"
            >
              {/* Main row — clickable to open this person's activity feed.
                  Hover-action buttons sit INSIDE the member-name cell (the
                  first grid column, which is the 1fr column) so they appear
                  right next to the name and don't overlay any data on the
                  right. Buttons stop propagation so they don't also trigger
                  the row's "view activity" click. */}
              <button
                type="button"
                onClick={() => onMemberClick(r.member)}
                style={gridStyle}
                className="grid w-full items-center gap-4 px-2 py-4 text-left"
                title={`View ${r.member.name}'s recent activity`}
              >
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <span className="font-serif text-lg text-neutral-50">
                      {r.member.name}
                    </span>
                    <div className="mt-0.5 text-[10px] uppercase tracking-widest text-neutral-600">
                      {r.member.role_label ?? payStructureLabel(r.member.pay_structure)}
                      {' · '}
                      {formatPayLine(r.member)}
                    </div>
                  </div>
                  {/* Hover-revealed log buttons pushed to the right edge
                      of the member-name cell, so on hover they sit
                      immediately to the LEFT of the Sales column. The
                      gap-4 outer spacing matches the column gap, so the
                      buttons line up with the same rhythm as the rest
                      of the row. */}
                  <div
                    role="presentation"
                    className="flex shrink-0 items-center gap-1.5 opacity-0 transition-opacity group-hover:opacity-100"
                  >
                    {rowLogButtons(kind).map((b) => (
                      <span
                        key={b.entryKind}
                        role="button"
                        tabIndex={0}
                        onClick={(e) => {
                          e.stopPropagation();
                          onLogEntry(b.entryKind, r.member.id);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            e.stopPropagation();
                            onLogEntry(b.entryKind, r.member.id);
                          }
                        }}
                        className={
                          'cursor-pointer whitespace-nowrap px-2.5 py-1.5 text-[10px] font-medium uppercase tracking-widest shadow-md transition-colors ' +
                          (b.primary
                            ? 'bg-neutral-50 text-neutral-950 hover:bg-neutral-200'
                            : 'border border-neutral-700 bg-neutral-950 text-neutral-200 hover:border-neutral-500 hover:text-neutral-50')
                        }
                      >
                        {b.label}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="text-right text-sm tabular-nums text-neutral-300">
                  {formatCents(grossCents)}
                </div>
                <div className="text-right text-sm tabular-nums text-neutral-100">
                  {formatCents(r.earnedCents)}
                </div>
                <div className="text-right text-sm tabular-nums text-neutral-100">
                  {formatCents(yourShareCents)}
                </div>
                <div className="text-right text-sm tabular-nums text-neutral-300">
                  {formatCents(r.paidCents)}
                </div>
                <div
                  className={
                    'text-right text-sm tabular-nums ' +
                    (r.owedCents > 0 ? 'text-neutral-50' : 'text-neutral-600')
                  }
                >
                  {formatCents(r.owedCents)}
                </div>
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// =============================================================================
//  States
// =============================================================================
function Loading() {
  return (
    <div className="flex h-64 items-center justify-center border border-dashed border-neutral-800 text-xs uppercase tracking-widest text-neutral-700">
      Loading…
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-64 flex-col items-center justify-center gap-2 border border-dashed border-neutral-800 px-6 text-center">
      <div className="font-serif text-xl text-neutral-200">No team members yet.</div>
      <div className="text-xs uppercase tracking-widest text-neutral-600">
        Add chatters or models on the Employees page first.
      </div>
    </div>
  );
}

// =============================================================================
//  Entry form modal (sale / withdrawal / payment)
// =============================================================================
function EntryFormModal({
  kind,
  prefilledMemberId,
  members,
  onClose,
  onSaved,
}: {
  kind: EntryKind;
  // When opening the modal from an inline row button, this is the member
  // the user just clicked on — used to skip the "pick a person" step.
  prefilledMemberId?: string;
  members: TeamMember[];
  onClose: () => void;
  onSaved: () => void;
}) {
  // Filter members based on entry kind.
  //   sale       — chatters (commission) + flat-paid staff who also bring in
  //                revenue. Excludes models since their income is withdrawals.
  //   withdrawal — share-paid members (models) only.
  //   payment    — anyone.
  const eligible = useMemo(() => {
    if (kind === 'sale') {
      return members.filter(
        (m) => m.pay_structure === 'commission' || m.pay_structure === 'flat',
      );
    }
    if (kind === 'withdrawal') return members.filter((m) => m.pay_structure === 'share');
    return members;
  }, [kind, members]);

  // Prefer the prefilled id if it's actually eligible for this kind;
  // otherwise fall back to the first eligible member.
  const [memberId, setMemberId] = useState<string>(() => {
    if (prefilledMemberId && eligible.some((m) => m.id === prefilledMemberId)) {
      return prefilledMemberId;
    }
    return eligible[0]?.id ?? '';
  });
  const [amountDollars, setAmountDollars] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Withdrawal-only: option to also pay the model their share in the same submit.
  const [payShare, setPayShare] = useState(false);
  const [shareDate, setShareDate] = useState(date);
  // Keep shareDate in sync with `date` until the user explicitly changes it.
  // Tracks whether the user has manually overridden the share date.
  const [shareDateTouched, setShareDateTouched] = useState(false);
  useEffect(() => {
    if (!shareDateTouched) setShareDate(date);
  }, [date, shareDateTouched]);

  const selectedMember = eligible.find((m) => m.id === memberId);
  // Compute the share amount in real-time so we can show it inside the checkbox label.
  const amountCentsLive = parseDollarsToCents(amountDollars) ?? 0;
  const shareCentsLive =
    kind === 'withdrawal' && selectedMember?.pay_structure === 'share'
      ? Math.round(amountCentsLive * (selectedMember.rate ?? 0))
      : 0;

  const meta = (() => {
    if (kind === 'sale') {
      return {
        eyebrow: 'Log sale',
        title: 'New sale',
        memberLabel: 'Chatter',
        noteLabel: 'Description (optional)',
        notePlaceholder: 'e.g. PPV bundle to whale',
        submitLabel: 'Log sale',
        emptyMsg: 'No commission-paid team members yet. Add a chatter on the Employees page first.',
      };
    }
    if (kind === 'withdrawal') {
      return {
        eyebrow: 'Log withdrawal',
        title: 'New withdrawal',
        memberLabel: 'Model',
        noteLabel: 'Description (optional)',
        notePlaceholder: 'e.g. OF weekly payout',
        submitLabel: 'Log withdrawal',
        emptyMsg: 'No share-paid team members yet. Add a model on the Employees page first.',
      };
    }
    return {
      eyebrow: 'Log payment',
      title: 'New payment',
      memberLabel: 'Recipient',
      noteLabel: 'Note (optional)',
      notePlaceholder: 'e.g. Sept 1st payout',
      submitLabel: 'Log payment',
      emptyMsg: 'No team members yet. Add someone on the Employees page first.',
    };
  })();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    if (!memberId) {
      toast.error(meta.emptyMsg);
      return;
    }
    const cents = parseDollarsToCents(amountDollars);
    if (cents == null || cents <= 0) {
      toast.error('Amount must be greater than zero.');
      return;
    }
    setSubmitting(true);
    try {
      if (kind === 'sale') {
        await createSale({
          team_member_id: memberId,
          amount_cents: cents,
          occurred_on: date,
          description: note,
        });
      } else if (kind === 'withdrawal') {
        await createWithdrawal({
          team_member_id: memberId,
          amount_cents: cents,
          occurred_on: date,
          description: note,
        });
        // Optionally also pay the model their share in one go.
        if (payShare && shareCentsLive > 0) {
          await createPayment({
            team_member_id: memberId,
            amount_cents: shareCentsLive,
            paid_on: shareDate,
            note: `Share of ${formatCents(cents)} withdrawal`,
          });
        }
      } else {
        await createPayment({
          team_member_id: memberId,
          amount_cents: cents,
          paid_on: date,
          note,
        });
      }
      toast.success(`Logged ${kind}.`);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open onClose={onClose} eyebrow={meta.eyebrow} title={meta.title}>
      <form onSubmit={handleSubmit} noValidate>
        <div className="mb-5">
          <Label htmlFor="member">{meta.memberLabel}</Label>
          {eligible.length === 0 ? (
            <div className="border border-dashed border-neutral-700 bg-neutral-950 px-3.5 py-3 text-sm text-neutral-400">
              {meta.emptyMsg}
            </div>
          ) : (
            <Select
              id="member"
              value={memberId}
              onChange={setMemberId}
              options={eligible.map((m) => ({
                value: m.id,
                label: m.name,
                detail: m.role_label ?? payStructureLabel(m.pay_structure),
              }))}
            />
          )}
        </div>

        <Field
          id="amount"
          label="Amount"
          type="text"
          inputMode="decimal"
          required
          value={amountDollars}
          onChange={(e) => setAmountDollars(e.target.value)}
          placeholder="e.g. 250.00"
          hint="Dollars."
        />

        <div className="mb-5">
          <Label htmlFor="date">Date</Label>
          <DatePicker id="date" value={date} onChange={setDate} />
        </div>

        <div className="mb-5">
          <Label htmlFor="note">{meta.noteLabel}</Label>
          <textarea
            id="note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder={meta.notePlaceholder}
            className="block w-full border border-neutral-800 bg-neutral-950 px-3.5 py-3 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
          />
        </div>

        {/* Withdrawal-only: option to also create a payment for the share. */}
        {kind === 'withdrawal' && selectedMember && (
          <div className="mb-5 border border-neutral-900 bg-neutral-950 p-4">
            <label className="flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                checked={payShare}
                onChange={(e) => setPayShare(e.target.checked)}
                className="mt-0.5 h-4 w-4 border-neutral-700 bg-neutral-950 accent-neutral-50"
              />
              <span className="flex-1">
                <span className="block text-sm text-neutral-100">
                  Paid {selectedMember.name} their share
                </span>
                <span className="mt-0.5 block text-xs text-neutral-500">
                  Also logs a {formatCents(shareCentsLive)} payment to{' '}
                  {selectedMember.name} on the date you pick below.
                </span>
              </span>
            </label>
            {payShare && (
              <div className="mt-4">
                <Label htmlFor="share-date">Payment date</Label>
                <DatePicker
                  id="share-date"
                  value={shareDate}
                  onChange={(v) => {
                    setShareDate(v);
                    setShareDateTouched(true);
                  }}
                />
                <button
                  type="button"
                  onClick={() => {
                    setShareDateTouched(false);
                    setShareDate(date);
                  }}
                  className="mt-1.5 text-[10px] uppercase tracking-widest text-neutral-600 hover:text-neutral-300"
                >
                  Reset to withdrawal date
                </button>
              </div>
            )}
          </div>
        )}

        <div className="mt-8 flex flex-col gap-3">
          <Button type="submit" loading={submitting} disabled={eligible.length === 0}>
            {meta.submitLabel}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// =============================================================================
//  Member activity modal — recent sales / withdrawals / payments
// =============================================================================
function MemberActivityModal({
  member,
  monthLabel,
  sales,
  withdrawals,
  payments,
  onClose,
  onEditSale,
  onEditWithdrawal,
  onEditPayment,
}: {
  member: TeamMember;
  monthLabel: string;
  sales: ChatterSale[];
  withdrawals: ModelWithdrawal[];
  payments: Payment[];
  onClose: () => void;
  onEditSale: (s: ChatterSale) => void;
  onEditWithdrawal: (w: ModelWithdrawal) => void;
  onEditPayment: (p: Payment) => void;
}) {
  const isCommission = member.pay_structure === 'commission';
  const isShare = member.pay_structure === 'share';

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow={`${monthLabel} · ${member.role_label ?? payStructureLabel(member.pay_structure)}`}
      title={member.name}
      maxWidth="max-w-xl"
    >
      {isCommission && (
        <ActivityList
          title="Sales"
          empty="No sales this month."
          items={sales.map((s) => ({
            id: s.id,
            date: s.occurred_on,
            amountCents: s.amount_cents,
            note: s.description,
            onClick: () => onEditSale(s),
          }))}
        />
      )}

      {isShare && (
        <ActivityList
          title="Withdrawals"
          empty="No withdrawals this month."
          items={withdrawals.map((w) => ({
            id: w.id,
            date: w.occurred_on,
            amountCents: w.amount_cents,
            note: w.description,
            onClick: () => onEditWithdrawal(w),
          }))}
        />
      )}

      <ActivityList
        title="Payments"
        empty="No payments this month."
        items={payments.map((p) => ({
          id: p.id,
          date: p.paid_on,
          amountCents: p.amount_cents,
          note: p.note,
          onClick: () => onEditPayment(p),
        }))}
      />
    </Modal>
  );
}

function ActivityList({
  title,
  empty,
  items,
}: {
  title: string;
  empty: string;
  items: {
    id: string;
    date: string;
    amountCents: number;
    note: string | null;
    onClick: () => void;
  }[];
}) {
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
          {items.map((i) => (
            <button
              key={i.id}
              type="button"
              onClick={i.onClick}
              className="grid w-full grid-cols-[auto_1fr_auto] items-baseline gap-4 py-3 text-left transition-colors hover:bg-neutral-900"
            >
              <div className="text-[10px] uppercase tracking-widest text-neutral-500">
                {shortDate(i.date)}
              </div>
              <div className="text-sm text-neutral-300">{i.note ?? ''}</div>
              <div className="text-right text-sm tabular-nums text-neutral-100">
                {formatCents(i.amountCents)}
              </div>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function shortDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y!, (m! - 1), d!).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

// =============================================================================
//  EditEntryModal — edit or delete a sale, withdrawal, or payment
// =============================================================================
type EditingEntry =
  | { kind: 'sale'; entry: ChatterSale }
  | { kind: 'withdrawal'; entry: ModelWithdrawal }
  | { kind: 'payment'; entry: Payment };

function EditEntryModal({
  editingEntry,
  onClose,
  onSaved,
}: {
  editingEntry: EditingEntry;
  onClose: () => void;
  onSaved: () => void;
}) {
  // Initial values vary by kind.
  const initialAmountDollars =
    (editingEntry.entry.amount_cents / 100).toString();
  const initialDate =
    editingEntry.kind === 'payment'
      ? editingEntry.entry.paid_on
      : editingEntry.entry.occurred_on;
  const initialNote =
    editingEntry.kind === 'payment'
      ? editingEntry.entry.note ?? ''
      : editingEntry.entry.description ?? '';

  const [amountDollars, setAmountDollars] = useState(initialAmountDollars);
  const [date, setDate] = useState(initialDate);
  const [note, setNote] = useState(initialNote);
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const meta = (() => {
    if (editingEntry.kind === 'sale') return { eyebrow: 'Edit sale', title: 'Sale', noteLabel: 'Description' };
    if (editingEntry.kind === 'withdrawal') return { eyebrow: 'Edit withdrawal', title: 'Withdrawal', noteLabel: 'Description' };
    return { eyebrow: 'Edit payment', title: 'Payment', noteLabel: 'Note' };
  })();

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    const cents = parseDollarsToCents(amountDollars);
    if (cents == null || cents <= 0) {
      toast.error('Amount must be greater than zero.');
      return;
    }
    if (!date) {
      toast.error('Date is required.');
      return;
    }
    setSubmitting(true);
    try {
      if (editingEntry.kind === 'sale') {
        await updateSale(editingEntry.entry.id, {
          amount_cents: cents,
          occurred_on: date,
          description: note,
        });
      } else if (editingEntry.kind === 'withdrawal') {
        await updateWithdrawal(editingEntry.entry.id, {
          amount_cents: cents,
          occurred_on: date,
          description: note,
        });
      } else {
        await updatePayment(editingEntry.entry.id, {
          amount_cents: cents,
          paid_on: date,
          note,
        });
      }
      toast.success('Saved.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    if (deleting) return;
    const ok = await confirm({
      title: `Delete this ${editingEntry.kind}?`,
      message: 'This removes it from the activity log and recalculates totals.',
      destructive: true,
      confirmLabel: `Delete ${editingEntry.kind}`,
    });
    if (!ok) return;
    setDeleting(true);
    try {
      if (editingEntry.kind === 'sale') await softDeleteSale(editingEntry.entry.id);
      else if (editingEntry.kind === 'withdrawal') await softDeleteWithdrawal(editingEntry.entry.id);
      else await softDeletePayment(editingEntry.entry.id);
      toast.success('Removed.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete.');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Modal open onClose={onClose} eyebrow={meta.eyebrow} title={meta.title}>
      <form onSubmit={handleSave} noValidate>
        <Field
          id="edit-amount"
          label="Amount"
          type="text"
          inputMode="decimal"
          required
          value={amountDollars}
          onChange={(e) => setAmountDollars(e.target.value)}
          hint="Dollars."
        />

        <div className="mb-5">
          <Label htmlFor="edit-date">Date</Label>
          <DatePicker id="edit-date" value={date} onChange={setDate} />
        </div>

        <div className="mb-5">
          <Label htmlFor="edit-note">{meta.noteLabel}</Label>
          <textarea
            id="edit-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            className="block w-full border border-neutral-800 bg-neutral-950 px-3.5 py-3 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
          />
        </div>

        <div className="mt-8 flex flex-col gap-3">
          <Button type="submit" loading={submitting}>
            Save changes
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>

        <div className="mt-6 border-t border-neutral-900 pt-5 text-right">
          <TextLink onClick={handleDelete}>
            {deleting ? 'Deleting…' : `Delete ${editingEntry.kind}`}
          </TextLink>
        </div>
      </form>
    </Modal>
  );
}

// =============================================================================
//  StatDetailModal — breakdown of where each top-of-page stat comes from
// =============================================================================
function StatDetailModal({
  statKey,
  monthLabel,
  stats,
  summaries,
  sales,
  withdrawals,
  nameById,
  onClose,
  onNavigate,
  onEditSale,
  onEditWithdrawal,
}: {
  statKey: StatKey;
  monthLabel: string;
  stats: Stats;
  summaries: MemberSummary[];
  sales: ChatterSale[];
  withdrawals: ModelWithdrawal[];
  nameById: Map<string, string>;
  onClose: () => void;
  onNavigate: (next: StatKey) => void;
  onEditSale: (s: ChatterSale) => void;
  onEditWithdrawal: (w: ModelWithdrawal) => void;
}) {
  const meta = STAT_META[statKey];
  const headlineValue =
    statKey === 'margin'
      ? `${stats.marginPct.toFixed(1)}%`
      : formatCents(getStatCents(statKey, stats));

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow={`${monthLabel} · breakdown`}
      title={meta.title}
      maxWidth="max-w-xl"
    >
      <div className="mb-6 border border-neutral-900 bg-neutral-950 p-5">
        <div className="text-[10px] uppercase tracking-widest text-neutral-500">
          {meta.title}
        </div>
        <div className="mt-2 font-serif text-3xl font-semibold tabular-nums tracking-tight text-neutral-50">
          {headlineValue}
        </div>
        <div className="mt-2 text-xs leading-relaxed text-neutral-500">
          {meta.formula}
        </div>
      </div>

      <StatBreakdown
        statKey={statKey}
        stats={stats}
        summaries={summaries}
        sales={sales}
        withdrawals={withdrawals}
        nameById={nameById}
        onNavigate={onNavigate}
        onEditSale={onEditSale}
        onEditWithdrawal={onEditWithdrawal}
      />
    </Modal>
  );
}

const STAT_META: Record<StatKey, { title: string; formula: string }> = {
  'gross-revenue': {
    title: 'Gross revenue',
    formula: 'All model withdrawals plus all chatter sales logged this month.',
  },
  'net-profit': {
    title: 'Net profit',
    formula: 'Gross revenue minus what you owe (or already paid) the team.',
  },
  'total-payouts': {
    title: 'Total payouts',
    formula: 'Models’ cut + chatters’ cut + flat-paid earnings this month.',
  },
  'currently-owed': {
    title: 'Currently owed',
    formula: 'Everyone with earnings this month that you haven’t paid yet.',
  },
  'models-cut': {
    title: 'Models’ cut',
    formula: 'Each model’s share of their withdrawals this month.',
  },
  'chatters-cut': {
    title: 'Chatters’ cut',
    formula: 'Each chatter’s commission on the sales they logged.',
  },
  'flat-paid': {
    title: 'Flat-paid earnings',
    formula: 'Salaried staff earnings accrued this month (4 wks / 2 wks / 1 mo / 1/12 yr).',
  },
  margin: {
    title: 'Margin',
    formula: 'Net profit ÷ gross revenue.',
  },
};

function getStatCents(key: StatKey, s: Stats): number {
  switch (key) {
    case 'gross-revenue': return s.grossRevenue;
    case 'net-profit':    return s.netProfit;
    case 'total-payouts': return s.totalPayouts;
    case 'currently-owed':return s.owed;
    case 'models-cut':    return s.modelsCut;
    case 'chatters-cut':  return s.chattersCut;
    case 'flat-paid':     return s.flatPay;
    case 'margin':        return 0;
  }
}

function StatBreakdown({
  statKey,
  stats,
  summaries,
  sales,
  withdrawals,
  nameById,
  onNavigate,
  onEditSale,
  onEditWithdrawal,
}: {
  statKey: StatKey;
  stats: Stats;
  summaries: MemberSummary[];
  sales: ChatterSale[];
  withdrawals: ModelWithdrawal[];
  nameById: Map<string, string>;
  onNavigate: (next: StatKey) => void;
  onEditSale: (s: ChatterSale) => void;
  onEditWithdrawal: (w: ModelWithdrawal) => void;
}) {
  // nameById covers all team_members including soft-deleted, so rows
  // attached to former employees still resolve to their real name.
  //
  // Summaries include former-but-in-dept members (so money aggregates are
  // accurate), so we can't use the bare summary set to tell "active vs
  // former" — we check end_date on each member explicitly.
  const activeIds = new Set(
    summaries.filter((s) => !isFormer(s.member)).map((s) => s.member.id),
  );
  const resolveName = (id: string): string => {
    const name = nameById.get(id) ?? 'Unknown';
    if (activeIds.has(id)) return name;
    return name.includes('· former') ? name : `${name} · former`;
  };

  if (statKey === 'gross-revenue') {
    return (
      <>
        <BreakdownGroup
          title="Withdrawals"
          total={withdrawals.reduce((n, w) => n + w.amount_cents, 0)}
          rows={withdrawals.map((w) => ({
            // Lead with the amount + type so the row reads as a transaction
            // first; person + date are secondary detail. Clicking opens the
            // full edit modal where description / amount / date can be seen
            // and changed.
            left: `${formatCents(w.amount_cents)} · Withdrawal`,
            mid: `${resolveName(w.team_member_id)} · ${shortDate(w.occurred_on)}`,
            right: '',
            onClick: () => onEditWithdrawal(w),
          }))}
          empty="No withdrawals this month."
        />
        <BreakdownGroup
          title="Sales"
          total={sales.reduce((n, s) => n + s.amount_cents, 0)}
          rows={sales.map((s) => ({
            left: `${formatCents(s.amount_cents)} · Sale`,
            mid: `${resolveName(s.team_member_id)} · ${shortDate(s.occurred_on)}`,
            right: '',
            onClick: () => onEditSale(s),
          }))}
          empty="No sales this month."
        />
      </>
    );
  }

  if (statKey === 'net-profit') {
    return (
      <FormulaList
        rows={[
          {
            left: 'Gross revenue',
            right: formatCents(stats.grossRevenue),
            onClick: () => onNavigate('gross-revenue'),
          },
          {
            left: 'Models’ cut',
            right: `− ${formatCents(stats.modelsCut)}`,
            onClick: () => onNavigate('models-cut'),
          },
          {
            left: 'Chatters’ cut',
            right: `− ${formatCents(stats.chattersCut)}`,
            onClick: () => onNavigate('chatters-cut'),
          },
          {
            left: 'Flat-paid',
            right: `− ${formatCents(stats.flatPay)}`,
            onClick: () => onNavigate('flat-paid'),
          },
        ]}
        total={{ left: 'Net profit', right: formatCents(stats.netProfit) }}
      />
    );
  }

  if (statKey === 'total-payouts') {
    // Each row drills into the sub-breakdown so the user can see who
    // contributed to that bucket (e.g. clicking "Flat-paid" lists every
    // salaried member and what each accrued).
    return (
      <FormulaList
        rows={[
          {
            left: 'Models’ cut',
            right: formatCents(stats.modelsCut),
            onClick: () => onNavigate('models-cut'),
          },
          {
            left: 'Chatters’ cut',
            right: formatCents(stats.chattersCut),
            onClick: () => onNavigate('chatters-cut'),
          },
          {
            left: 'Flat-paid',
            right: formatCents(stats.flatPay),
            onClick: () => onNavigate('flat-paid'),
          },
        ]}
        total={{ left: 'Total payouts', right: formatCents(stats.totalPayouts) }}
        sub={`${formatCents(stats.paid)} already paid · ${formatCents(stats.owed)} still outstanding`}
      />
    );
  }

  if (statKey === 'currently-owed') {
    const owedRows = summaries
      .filter((s) => s.owedCents > 0 && !isFormer(s.member))
      .sort((a, b) => b.owedCents - a.owedCents);
    return (
      <BreakdownGroup
        title="Outstanding by team member"
        total={stats.owed}
        rows={owedRows.map((s) => ({
          left: s.member.name,
          mid: `${formatCents(s.earnedCents)} earned · ${formatCents(s.paidCents)} paid`,
          right: formatCents(s.owedCents),
        }))}
        empty="Nobody is owed money right now."
      />
    );
  }

  if (statKey === 'models-cut') {
    const rows = summaries.filter((s) => s.member.pay_structure === 'share');
    return (
      <BreakdownGroup
        title="Models"
        total={stats.modelsCut}
        rows={rows.map((s) => ({
          left: s.member.name,
          mid: `${formatCents(s.withdrawalsCents)} × ${pctLabel(s.member.rate)}`,
          right: formatCents(s.earnedCents),
        }))}
        empty="No models on the roster."
      />
    );
  }

  if (statKey === 'chatters-cut') {
    const rows = summaries.filter((s) => s.member.pay_structure === 'commission');
    return (
      <BreakdownGroup
        title="Chatters"
        total={stats.chattersCut}
        rows={rows.map((s) => ({
          left: s.member.name,
          mid: `${formatCents(s.salesCents)} × ${pctLabel(s.member.rate)}`,
          right: formatCents(s.earnedCents),
        }))}
        empty="No chatters on the roster."
      />
    );
  }

  if (statKey === 'flat-paid') {
    const rows = summaries.filter((s) => s.member.pay_structure === 'flat');
    return (
      <BreakdownGroup
        title="Salaried staff"
        total={stats.flatPay}
        rows={rows.map((s) => ({
          left: s.member.name,
          mid: formatPayLine(s.member),
          right: formatCents(s.earnedCents),
        }))}
        empty="No flat-paid staff this month."
      />
    );
  }

  // margin
  return (
    <FormulaList
      rows={[
        { left: 'Net profit',    right: formatCents(stats.netProfit) },
        { left: 'Gross revenue', right: `÷ ${formatCents(stats.grossRevenue)}` },
      ]}
      total={{ left: 'Margin', right: `${stats.marginPct.toFixed(1)}%` }}
    />
  );
}

function BreakdownGroup({
  title,
  total,
  rows,
  empty,
}: {
  title: string;
  total: number;
  rows: { left: string; mid: string; right: string; onClick?: () => void }[];
  empty: string;
}) {
  return (
    <section className="mb-6 last:mb-0">
      <div className="mb-3 flex items-baseline justify-between border-b border-neutral-900 pb-2">
        <div className="flex items-baseline gap-3">
          <h3 className="font-serif text-base font-medium tracking-tight text-neutral-100">
            {title}
          </h3>
          <span className="text-[10px] uppercase tracking-widest text-neutral-600">
            {rows.length}
          </span>
        </div>
        <span className="text-sm tabular-nums text-neutral-300">
          {formatCents(total)}
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="flex h-14 items-center justify-center border border-dashed border-neutral-800 text-[10px] uppercase tracking-widest text-neutral-600">
          {empty}
        </div>
      ) : (
        <div className="divide-y divide-neutral-900">
          {rows.map((r, i) => {
            const content = (
              <>
                <div className="text-sm text-neutral-100">{r.left}</div>
                <div className="text-[10px] uppercase tracking-widest text-neutral-600">
                  {r.mid}
                </div>
                <div className="text-right text-sm tabular-nums text-neutral-200">
                  {r.right}
                </div>
              </>
            );
            const baseClasses =
              'grid grid-cols-[auto_1fr_auto] items-baseline gap-4 py-2.5';
            if (r.onClick) {
              return (
                <button
                  key={`${r.left}-${i}`}
                  type="button"
                  onClick={r.onClick}
                  className={`${baseClasses} w-full text-left transition-colors hover:bg-neutral-900`}
                  title="View details"
                >
                  {content}
                </button>
              );
            }
            return (
              <div key={`${r.left}-${i}`} className={baseClasses}>
                {content}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// One row's right-hand value: an optional sign rendered in its own
// fixed-width slot so the `$` characters line up vertically across rows.
function MoneyCell({ sign, amount }: { sign: '+' | '−' | ''; amount: string }) {
  return (
    <span className="inline-flex items-baseline tabular-nums">
      <span className="w-3 text-right text-neutral-400">{sign}</span>
      <span className="ml-1 text-neutral-200">{amount}</span>
    </span>
  );
}

// Splits a string like "− $1,500.00" or "$1,500.00" into the explicit
// pieces MoneyCell expects. Lets existing callers keep passing a plain
// string while we transparently align the $.
function splitMoneyCell(s: string): { sign: '+' | '−' | ''; amount: string } {
  const trimmed = s.trim();
  if (trimmed.startsWith('−')) {
    return { sign: '−', amount: trimmed.slice(1).trim() };
  }
  if (trimmed.startsWith('+')) {
    return { sign: '+', amount: trimmed.slice(1).trim() };
  }
  return { sign: '', amount: trimmed };
}

function FormulaList({
  rows,
  total,
  sub,
}: {
  rows: { left: string; right: string; onClick?: () => void }[];
  total: { left: string; right: string };
  sub?: string;
}) {
  return (
    <section>
      <div className="divide-y divide-neutral-900">
        {rows.map((r) => {
          const { sign, amount } = splitMoneyCell(r.right);
          const content = (
            <>
              <span className="text-neutral-300">{r.left}</span>
              <span className="text-sm">
                <MoneyCell sign={sign} amount={amount} />
              </span>
            </>
          );
          if (r.onClick) {
            return (
              <button
                key={r.left}
                type="button"
                onClick={r.onClick}
                className="flex w-full items-baseline justify-between py-2.5 text-left text-sm transition-colors hover:bg-neutral-900"
                title="View breakdown"
              >
                {content}
                <span className="ml-2 text-[10px] uppercase tracking-widest text-neutral-600">
                  &rarr;
                </span>
              </button>
            );
          }
          return (
            <div
              key={r.left}
              className="flex items-baseline justify-between py-2.5 text-sm"
            >
              {content}
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex items-baseline justify-between border-t border-neutral-700 pt-3">
        <span className="font-serif text-lg text-neutral-50">{total.left}</span>
        <span className="font-serif text-lg tabular-nums text-neutral-50">
          {total.right}
        </span>
      </div>
      {sub && (
        <div className="mt-3 text-[10px] uppercase tracking-widest text-neutral-600">
          {sub}
        </div>
      )}
    </section>
  );
}

function pctLabel(rate: number | null): string {
  if (rate == null) return '0%';
  const v = rate * 100;
  return `${Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)}%`;
}
