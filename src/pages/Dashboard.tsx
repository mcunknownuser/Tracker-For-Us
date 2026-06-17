// =============================================================================
//  Dashboard.tsx
//  Cross-page roll-up. Pulls from OFM, Reddit, Tracking, and Expenses and
//  surfaces:
//    * Top stats row — combined totals (gross / payouts / net profit / owed)
//    * Department breakdown row — one box per department
//    * Revenue chart — daily gross income for the period
//    * Outstanding payments — every team member with a non-zero balance
//    * Top performers — top 3 chatters / models / tracking links
//    * Recent activity feed — timeline of recent events across the app
// =============================================================================

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { PageHeader } from '../components/PageHeader';
import { useActiveAgency } from '../lib/agency';
import {
  type ChatterSale,
  type ModelWithdrawal,
  type Payment,
  type MemberSummary,
  buildSummaries,
  createPayment,
  softDeletePayment,
  softDeleteSale,
  softDeleteWithdrawal,
  listSales,
  listWithdrawals,
  listPayments,
  currentMonthKey,
  monthLongLabel,
  monthRange,
} from '../lib/ofm';
import {
  type RedditAccount,
  type RedditAccountIncome,
  listAccounts as listRedditAccounts,
  listAllAccountsIncludingDeleted as listAllRedditAccountsEver,
  listIncomeForMonth as listRedditIncomeForMonth,
  setIncome as setRedditIncome,
} from '../lib/reddit';
import {
  type TrackingLink,
  type TrackingSnapshot,
  listLinks as listTrackingLinks,
  listAllSnapshots,
} from '../lib/tracking';
import { type Expense, listExpenses } from '../lib/expenses';
import { type Department, listDepartments } from '../lib/departments';
import { departmentPath } from '../lib/routes';
import {
  type TeamMember,
  listTeamMembers,
  listMemberNameMap,
  listMemberDeptMap,
  isFormer,
} from '../lib/teamMembers';
import { toast } from '../lib/toast';
import { confirm } from '../lib/confirm';
import { formatCents } from '../lib/money';
import { payStructureLabel } from '../lib/staffRoles';
import { Modal } from '../components/Modal';
import { getLabel } from '../lib/labels';
import { EmptyState } from '../components/EmptyState';
import { StatCardSkeleton, ChartSkeleton, ListSkeleton } from '../components/Skeleton';

type Scope = 'month' | 'all' | 'range';
type DateRange = { start: string; end: string }; // both YYYY-MM-DD, end exclusive
type StatKey = 'gross' | 'payouts' | 'profit' | 'owed' | 'expenses' | 'unassigned';

// Returns the ISO date N days before today (or today if days=0).
function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
function startOfYearIso(): string {
  return `${new Date().getFullYear()}-01-01`;
}
// Inclusive label like "Mar 1 – Mar 31" given a range whose end is exclusive.
function rangeLabel(range: DateRange): string {
  const fmt = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y!, (m! - 1), d!).toLocaleString('en-US', { month: 'short', day: 'numeric' });
  };
  // Display the inclusive end (one day before the exclusive end).
  const endDate = new Date(range.end + 'T00:00:00');
  endDate.setDate(endDate.getDate() - 1);
  const endIso = endDate.toISOString().slice(0, 10);
  return `${fmt(range.start)} – ${fmt(endIso)}`;
}

// =============================================================================
//  Page
// =============================================================================
export function Dashboard() {
  const { agency } = useActiveAgency();
  const navigate = useNavigate();
  const [scope, setScope] = useState<Scope>('month');
  const [monthKey, setMonthKey] = useState(currentMonthKey());
  // Custom date range. End is exclusive (start of next day) so filtering
  // can use `>= start && < end` consistently for both ISO date and datetime
  // columns. Default to last 30 days.
  const [range, setRange] = useState<DateRange>(() => ({
    start: isoDaysAgo(30),
    // Tomorrow, so today is included.
    end: isoDaysAgo(-1),
  }));

  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [openStat, setOpenStat] = useState<StatKey | null>(null);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [sales, setSales] = useState<ChatterSale[]>([]);
  const [withdrawals, setWithdrawals] = useState<ModelWithdrawal[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [redditAccounts, setRedditAccounts] = useState<RedditAccount[]>([]);
  // Includes soft-deleted accounts so the Unassigned modal can still
  // resolve real labels for orphaned income rows.
  const [redditAccountsForLookup, setRedditAccountsForLookup] = useState<RedditAccount[]>([]);
  const [redditIncome, setRedditIncome] = useState<RedditAccountIncome[]>([]);
  const [trackingLinks, setTrackingLinks] = useState<TrackingLink[]>([]);
  const [snapshots, setSnapshots] = useState<TrackingSnapshot[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  // Includes soft-deleted members so historical sales/withdrawals/payments
  // attached to them still resolve to their real name instead of "Unknown".
  const [nameById, setNameById] = useState<Map<string, string>>(new Map());
  // member id → department_id for EVERY member (including soft-deleted)
  // so per-department totals correctly attribute historical transactions
  // from staff who have since been removed from the active roster.
  const [deptByMemberId, setDeptByMemberId] = useState<Map<string, string | null>>(new Map());
  // Bumping this re-runs the data load — used after the user dismisses
  // someone from the Outstanding panel (which mutates a team_member row).
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        // For OFM / Reddit / Tracking, we need data for the selected scope.
        //   month — fetch this month
        //   all   — fetch full history
        //   range — fetch full history, filter client-side by chosen dates
        const key = monthKey;
        const wantsAll = scope === 'all' || scope === 'range';
        const [
          depts, m, s, w, p, ra, raAll, ri, tl, snaps, ex, names, dMap,
        ] = await Promise.all([
          listDepartments(),
          listTeamMembers(),
          wantsAll ? listAllSales() : listSales(key),
          wantsAll ? listAllWithdrawals() : listWithdrawals(key),
          wantsAll ? listAllPayments() : listPayments(key),
          listRedditAccounts(),
          listAllRedditAccountsEver(),
          wantsAll ? listAllRedditIncome() : listRedditIncomeForMonth(key),
          listTrackingLinks(),
          listAllSnapshots(),
          listExpenses(),
          listMemberNameMap(),
          listMemberDeptMap(),
        ]);
        if (cancelled) return;
        // Apply client-side date filter for range scope.
        const filtered = scope === 'range'
          ? {
              sales: s.filter((x) => x.occurred_on >= range.start && x.occurred_on < range.end),
              withdrawals: w.filter((x) => x.occurred_on >= range.start && x.occurred_on < range.end),
              payments: p.filter((x) => x.paid_on >= range.start && x.paid_on < range.end),
              ri: ri.filter((x) => x.month_start >= range.start && x.month_start < range.end),
            }
          : { sales: s, withdrawals: w, payments: p, ri };
        setDepartments(depts);
        setMembers(m);
        setNameById(names);
        setDeptByMemberId(dMap);
        setSales(filtered.sales);
        setWithdrawals(filtered.withdrawals);
        setPayments(filtered.payments);
        setRedditAccounts(ra);
        setRedditAccountsForLookup(raAll);
        setRedditIncome(filtered.ri);
        setTrackingLinks(tl);
        setSnapshots(snaps);
        setExpenses(ex);
        setLoaded(true);
      } catch (e) {
        if (!cancelled) setError(e as Error);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [scope, monthKey, range.start, range.end, reloadTick]);

  // --------------------------------------------------------------------------
  // Derive aggregates
  // --------------------------------------------------------------------------

  const summaries: MemberSummary[] = useMemo(
    () => buildSummaries(members, sales, withdrawals, payments, monthKey),
    [members, sales, withdrawals, payments, monthKey],
  );

  // OFM
  const ofmSalesCents = useMemo(() => sales.reduce((n, s) => n + s.amount_cents, 0), [sales]);
  const ofmWithdrawalsCents = useMemo(
    () => withdrawals.reduce((n, w) => n + w.amount_cents, 0),
    [withdrawals],
  );
  const ofmPayoutsCents = useMemo(
    () => summaries.reduce((n, s) => n + s.earnedCents, 0),
    [summaries],
  );
  // Owed totals exclude former employees — once someone leaves we don't
  // want the dashboard nagging the user about an unpaid balance to them.
  // The underlying data is preserved; this is purely a display filter.
  const ofmOwedCents = useMemo(
    () => summaries.filter((s) => !isFormer(s.member)).reduce((n, s) => n + s.owedCents, 0),
    [summaries],
  );

  // Reddit
  const redditIncomeCents = useMemo(
    () => redditIncome.reduce((n, i) => n + i.amount_cents, 0),
    [redditIncome],
  );
  // Reddit payouts are computed via the same payments table — already
  // counted in `payments`. To avoid double-counting, treat all payments
  // as agency-wide outflow.

  // Per-department breakdown. Each department gets its own card on the
  // dashboard, sourced from the data its layout type cares about:
  //   * models    — chatter sales + model withdrawals from members in this dept
  //   * marketing — reddit income for accounts whose VA is in this dept,
  //                 plus accounts with no VA, plus income from soft-
  //                 deleted accounts (counted in the first marketing
  //                 department only, so they aren't duplicated)
  //
  // The dept-membership lookup uses `deptByMemberId` — which covers
  // soft-deleted members too — so transactions from staff who've since
  // been removed still get attributed to the right department.
  const departmentTotals = useMemo(() => {
    // First marketing department absorbs (a) reddit accounts with no
    // assigned VA and (b) reddit income rows whose underlying account
    // has been soft-deleted. Both are still Reddit income; they just
    // can't be attributed to any specific marketing dept any other way.
    const firstMarketingId = departments.find((d) => d.layout_type === 'marketing')?.id;
    const knownAccountIds = new Set(redditAccounts.map((a) => a.id));

    return departments.map((d) => {
      if (d.layout_type === 'models') {
        const inDept = (memberId: string) => deptByMemberId.get(memberId) === d.id;
        const matchingSales       = sales.filter((x) => inDept(x.team_member_id));
        const matchingWithdrawals = withdrawals.filter((x) => inDept(x.team_member_id));
        const salesCents = matchingSales.reduce((n, x) => n + x.amount_cents, 0);
        const wdCents    = matchingWithdrawals.reduce((n, x) => n + x.amount_cents, 0);
        return {
          dept: d,
          incomeCents: salesCents + wdCents,
          hint: `${matchingWithdrawals.length} ${getLabel('withdrawal').toLowerCase()}s · ${matchingSales.length} ${getLabel('sale').toLowerCase()}s`,
        };
      }
      // marketing
      const matchingAccountIds = new Set(
        redditAccounts
          .filter((a) =>
            (a.team_member_id && deptByMemberId.get(a.team_member_id) === d.id) ||
            (a.team_member_id === null && d.id === firstMarketingId),
          )
          .map((a) => a.id),
      );
      const matchingIncome = redditIncome.filter(
        (i) =>
          matchingAccountIds.has(i.account_id) ||
          // Income whose underlying account was soft-deleted lands in
          // the first marketing dept so it doesn't disappear into
          // "Unassigned" — the user has clearly told us it was Reddit
          // income (it lives in the reddit_account_income table).
          (!knownAccountIds.has(i.account_id) && d.id === firstMarketingId),
      );
      const incomeCents = matchingIncome.reduce((n, i) => n + i.amount_cents, 0);
      return {
        dept: d,
        incomeCents,
        hint: `${matchingAccountIds.size} accounts`,
      };
    });
  }, [departments, deptByMemberId, sales, withdrawals, redditAccounts, redditIncome]);

  // Unassigned income — transactions that don't fit into any active
  // department card. Three causes:
  //   1. Member has no department_id set
  //   2. Member's team_member row was hard-deleted (id not in map)
  //   3. Member's department_id points to a soft-deleted department
  //      (the dept isn't in `departments` anymore, but the member still
  //      references its id — common after the user deletes a dept).
  // Reddit income from soft-deleted ACCOUNTS is no longer orphaned —
  // it's now folded into the first marketing dept above.
  const unassigned = useMemo(() => {
    const activeDeptIds = new Set(departments.map((d) => d.id));
    const orphanMember = (memberId: string) => {
      const deptId = deptByMemberId.get(memberId);
      if (!deptId) return true;             // no dept OR member missing
      return !activeDeptIds.has(deptId);    // dept was deleted
    };
    const firstMarketingId = departments.find((d) => d.layout_type === 'marketing')?.id;

    const orphanSales       = sales.filter((x) => orphanMember(x.team_member_id));
    const orphanWithdrawals = withdrawals.filter((x) => orphanMember(x.team_member_id));

    // Reddit accounts orphan when their VA is in a non-marketing dept,
    // or has no dept, or has a dept that was deleted. (Accounts with no
    // VA and accounts whose owner-account was soft-deleted are both
    // attributed to the first marketing dept above; they're not orphans.)
    const orphanAccountIds = new Set(
      redditAccounts
        .filter((a) => {
          if (a.team_member_id === null) {
            return !firstMarketingId;
          }
          const memberDept = deptByMemberId.get(a.team_member_id);
          if (!memberDept) return true;
          if (!activeDeptIds.has(memberDept)) return true;
          const memberDeptObj = departments.find((d) => d.id === memberDept);
          return memberDeptObj?.layout_type !== 'marketing';
        })
        .map((a) => a.id),
    );
    const orphanIncome = redditIncome.filter((i) => orphanAccountIds.has(i.account_id));

    const salesCents  = orphanSales.reduce((n, x) => n + x.amount_cents, 0);
    const wdCents     = orphanWithdrawals.reduce((n, x) => n + x.amount_cents, 0);
    const incomeCents = orphanIncome.reduce((n, x) => n + x.amount_cents, 0);

    return {
      sales: orphanSales,
      withdrawals: orphanWithdrawals,
      redditIncome: orphanIncome,
      totalCents: salesCents + wdCents + incomeCents,
      entryCount: orphanSales.length + orphanWithdrawals.length + orphanIncome.length,
    };
  }, [sales, withdrawals, redditAccounts, redditIncome, departments, deptByMemberId]);

  // Expenses
  const expensesScoped = useMemo(() => {
    if (scope === 'all') return expenses;
    if (scope === 'range') {
      return expenses.filter(
        (e) => e.incurred_on >= range.start && e.incurred_on < range.end,
      );
    }
    const [start, end] = monthRange(monthKey);
    return expenses.filter((e) => e.incurred_on >= start && e.incurred_on < end);
  }, [expenses, scope, monthKey, range.start, range.end]);
  const expensesCents = useMemo(
    () => expensesScoped.reduce((n, e) => n + e.amount_cents, 0),
    [expensesScoped],
  );

  // Combined totals (tracking earnings deliberately excluded — Infloww
  // numbers are cumulative-lifetime and conflate with the OFM withdrawals
  // they originate from).
  const grossRevenueCents = ofmWithdrawalsCents + ofmSalesCents + redditIncomeCents;
  const totalPaidCents = useMemo(
    () => payments.reduce((n, p) => n + p.amount_cents, 0),
    [payments],
  );
  const totalPayoutsCents = ofmPayoutsCents; // all team_member earnings flow through OFM summary math
  const netProfitCents = grossRevenueCents - totalPayoutsCents - expensesCents;

  const scopeLabel =
    scope === 'all'   ? 'All time' :
    scope === 'range' ? rangeLabel(range) :
                        monthLongLabel(monthKey);

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        eyebrow="Overview"
        title={agency ? `Welcome, ${agency.name}.` : 'Welcome.'}
        subtitle="Your agency at a glance. Click into any section for detail."
        actions={
          <ScopeToggle
            scope={scope}
            onScope={setScope}
            monthKey={monthKey}
            onMonth={setMonthKey}
            range={range}
            onRange={setRange}
          />
        }
      />

      {error && (
        <div className="mb-6 border border-red-900/60 bg-red-950/30 p-4 text-sm text-red-200">
          {error.message}
        </div>
      )}

      {!loaded ? (
        <DashboardSkeleton />
      ) : (
        <>
          {/* Top totals row. Real gaps + bordered cards (no more 1px
              divider lines) so each metric reads as its own box. */}
          <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard tier="primary" tone="revenue" label="Gross revenue"  value={formatCents(grossRevenueCents)} hint={scopeLabel}                                                                              onClick={() => setOpenStat('gross')} />
            <StatCard tier="primary" tone="cost"    label="Total payouts"  value={formatCents(totalPayoutsCents)} hint={`${formatCents(totalPaidCents)} paid`}                                                  onClick={() => setOpenStat('payouts')} />
            <StatCard tier="primary" tone="key"     label="Net profit"     value={formatCents(netProfitCents)}    hint={grossRevenueCents > 0 ? `${((netProfitCents / grossRevenueCents) * 100).toFixed(1)}% margin` : 'No revenue yet'} onClick={() => setOpenStat('profit')} />
            <StatCard tier="primary" tone="warn"    label="Currently owed" value={formatCents(ofmOwedCents)}      hint="Outstanding to team"                                                                     onClick={() => setOpenStat('owed')} />
          </div>

          {/* Department breakdown row — one card per department the agency
              has created. Income is computed from the department's data
              (sales+withdrawals for models layout; reddit income for
              marketing layout). Clicking a department card jumps directly
              to that department's page. */}
          {(departmentTotals.length > 0 || true) && (
            <div
              className="mb-12 grid grid-cols-1 gap-3"
              style={{
                gridTemplateColumns: `repeat(auto-fit, minmax(220px, 1fr))`,
              }}
            >
              {departmentTotals.map((d) => (
                <StatCard
                  key={d.dept.id}
                  tier="secondary"
                  tone="dept"
                  label={`${d.dept.name} income`}
                  value={formatCents(d.incomeCents)}
                  hint={d.hint}
                  onClick={() => navigate(departmentPath(d.dept.id))}
                />
              ))}
              <StatCard
                tier="secondary"
                tone="cost"
                label="Expenses"
                value={formatCents(expensesCents)}
                hint={`${expensesScoped.length} entries`}
                onClick={() => setOpenStat('expenses')}
              />
              {/* Catch-all for income that doesn't belong to any department —
                  e.g. transactions on a team member with no department, or
                  a Reddit account assigned to a non-marketing dept. Only
                  shown when there are actual orphans, so a clean setup
                  doesn't have a "$0 Unassigned" card cluttering the view. */}
              {unassigned.entryCount > 0 && (
                <StatCard
                  tier="secondary"
                  tone="warn"
                  label="Unassigned"
                  value={formatCents(unassigned.totalCents)}
                  hint={`${unassigned.entryCount} ${unassigned.entryCount === 1 ? 'entry' : 'entries'} · click to review`}
                  onClick={() => setOpenStat('unassigned')}
                />
              )}
            </div>
          )}

          {/* Revenue chart + Outstanding list */}
          <div className="mb-12 grid grid-cols-1 gap-6 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <RevenueChart
                sales={sales}
                withdrawals={withdrawals}
                redditIncome={redditIncome}
              />
            </div>
            <OutstandingList
              summaries={summaries}
              onMarkPaid={async (member, owedCents) => {
                // Create a Payment for the full owed amount, dated today.
                // Undo toast soft-deletes the payment to restore the
                // owed balance.
                const today = new Date().toISOString().slice(0, 10);
                try {
                  const created = await createPayment({
                    team_member_id: member.id,
                    amount_cents: owedCents,
                    paid_on: today,
                    note: 'Marked paid from dashboard',
                  });
                  setReloadTick((n) => n + 1);
                  toast.action({
                    message: `${member.name} marked paid (${formatCents(owedCents)}).`,
                    actionLabel: 'Undo',
                    onAction: () => {
                      void (async () => {
                        try {
                          await softDeletePayment(created.id);
                          setReloadTick((n) => n + 1);
                          toast.success(`Payment to ${member.name} reverted.`);
                        } catch (err) {
                          toast.error(
                            err instanceof Error ? err.message : 'Undo failed.',
                          );
                        }
                      })();
                    },
                  });
                } catch (err) {
                  toast.error(
                    err instanceof Error ? err.message : 'Could not record payment.',
                  );
                }
              }}
            />
          </div>

          {/* Top performers + Recent activity */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <TopPerformers summaries={summaries} snapshots={snapshots} links={trackingLinks} scope={scope} monthKey={monthKey} />
            <RecentActivity
              sales={sales}
              withdrawals={withdrawals}
              payments={payments}
              expenses={expensesScoped}
              nameById={nameById}
              activeIds={new Set(members.map((m) => m.id))}
            />
          </div>
        </>
      )}

      {openStat && (
        <StatDetailModal
          statKey={openStat}
          scopeLabel={scopeLabel}
          totals={{
            gross: grossRevenueCents,
            payouts: totalPayoutsCents,
            paid: totalPaidCents,
            profit: netProfitCents,
            owed: ofmOwedCents,
            expenses: expensesCents,
            unassigned: unassigned.totalCents,
          }}
          departmentTotals={departmentTotals}
          payments={payments}
          expenses={expensesScoped}
          summaries={summaries}
          unassignedSales={unassigned.sales}
          unassignedWithdrawals={unassigned.withdrawals}
          unassignedRedditIncome={unassigned.redditIncome}
          redditAccountsForLookup={redditAccountsForLookup}
          nameById={nameById}
          onChanged={() => setReloadTick((n) => n + 1)}
          onClose={() => setOpenStat(null)}
          onDeptNavigate={(id) => {
            setOpenStat(null);
            navigate(departmentPath(id));
          }}
        />
      )}
    </div>
  );
}

// =============================================================================
//  Scope toggle — month picker + "all time" button
// =============================================================================
// Scope picker. A single pill displays the current scope label; clicking
// opens a popover with the three modes + relevant controls. Keeping the
// trigger to a fixed-width element means the page header doesn't reflow
// when the user switches scopes.
function ScopeToggle({
  scope,
  onScope,
  monthKey,
  onMonth,
  range,
  onRange,
}: {
  scope: Scope;
  onScope: (s: Scope) => void;
  monthKey: string;
  onMonth: (k: string) => void;
  range: DateRange;
  onRange: (r: DateRange) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const triggerLabel =
    scope === 'all'   ? 'All time' :
    scope === 'range' ? rangeLabel(range) :
                        monthLongLabel(monthKey);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 border border-neutral-800 bg-neutral-950 px-3 py-1.5 text-xs text-neutral-100 transition-colors hover:border-neutral-600"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="text-neutral-500" aria-hidden>
          <rect x="3" y="4" width="18" height="18" rx="0" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="3" y1="10" x2="21" y2="10" />
        </svg>
        <span className="font-serif text-sm text-neutral-50">{triggerLabel}</span>
        <span className="text-[10px] uppercase tracking-widest text-neutral-600">
          {scope === 'month' ? 'Month' : scope === 'range' ? 'Range' : 'All'}
        </span>
        <Chevron open={open} />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-30 mt-2 w-[320px] border border-neutral-800 bg-neutral-950 shadow-2xl">
          {/* Mode list */}
          <div className="border-b border-neutral-900">
            <ScopeRow
              label="This month / pick a month"
              active={scope === 'month'}
              onClick={() => onScope('month')}
            />
            <ScopeRow
              label="Custom range"
              active={scope === 'range'}
              onClick={() => onScope('range')}
            />
            <ScopeRow
              label="All time"
              active={scope === 'all'}
              onClick={() => { onScope('all'); setOpen(false); }}
            />
          </div>

          {/* Sub-controls — always rendered in a stable slot so the popover
              doesn't pop-in/out; mode determines content */}
          <div className="p-3">
            {scope === 'month' && <MonthControls monthKey={monthKey} onMonth={onMonth} />}
            {scope === 'range' && <RangeControls range={range} onRange={onRange} />}
            {scope === 'all'  && (
              <div className="py-4 text-center text-[10px] uppercase tracking-widest text-neutral-600">
                Showing every record on file.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ScopeRow({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'flex w-full items-center justify-between px-4 py-2.5 text-left text-sm transition-colors ' +
        (active ? 'bg-neutral-900 text-neutral-50' : 'text-neutral-300 hover:bg-neutral-900')
      }
    >
      <span>{label}</span>
      {active && <span className="text-[10px] uppercase tracking-widest text-neutral-500">Active</span>}
    </button>
  );
}

function MonthControls({ monthKey, onMonth }: { monthKey: string; onMonth: (k: string) => void }) {
  const shift = (delta: number) => {
    const [y, m] = monthKey.split('-').map(Number);
    const d = new Date(y!, (m! - 1) + delta, 1);
    onMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  };
  return (
    <div className="flex items-center justify-between">
      <button
        type="button"
        onClick={() => shift(-1)}
        className="border border-neutral-800 px-3 py-1.5 text-neutral-400 transition-colors hover:border-neutral-500 hover:text-neutral-100"
      >
        ←
      </button>
      <div className="font-serif text-base text-neutral-100">{monthLongLabel(monthKey)}</div>
      <button
        type="button"
        onClick={() => shift(1)}
        className="border border-neutral-800 px-3 py-1.5 text-neutral-400 transition-colors hover:border-neutral-500 hover:text-neutral-100"
      >
        →
      </button>
    </div>
  );
}

function RangeControls({ range, onRange }: { range: DateRange; onRange: (r: DateRange) => void }) {
  // Display inclusive end (one day before exclusive end).
  const endInclusive = (() => {
    const d = new Date(range.end + 'T00:00:00');
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  })();
  const setPreset = (days: number | 'ytd') => {
    if (days === 'ytd') {
      onRange({ start: startOfYearIso(), end: isoDaysAgo(-1) });
    } else {
      onRange({ start: isoDaysAgo(days - 1), end: isoDaysAgo(-1) });
    }
  };
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="mb-1 block text-[10px] uppercase tracking-widest text-neutral-600">From</span>
          <input
            type="date"
            value={range.start}
            max={endInclusive}
            onChange={(e) => onRange({ ...range, start: e.target.value || range.start })}
            className="block w-full border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-xs text-neutral-100 [color-scheme:dark] focus:border-neutral-500 focus:outline-none"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[10px] uppercase tracking-widest text-neutral-600">To</span>
          <input
            type="date"
            value={endInclusive}
            min={range.start}
            max={todayIso()}
            onChange={(e) => {
              const v = e.target.value;
              if (!v) return;
              const d = new Date(v + 'T00:00:00');
              d.setDate(d.getDate() + 1);
              onRange({ ...range, end: d.toISOString().slice(0, 10) });
            }}
            className="block w-full border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-xs text-neutral-100 [color-scheme:dark] focus:border-neutral-500 focus:outline-none"
          />
        </label>
      </div>
      <div className="grid grid-cols-4 gap-px bg-neutral-800">
        {[
          { label: 'Last 7d',  action: () => setPreset(7) },
          { label: 'Last 30d', action: () => setPreset(30) },
          { label: 'Last 90d', action: () => setPreset(90) },
          { label: 'YTD',      action: () => setPreset('ytd') },
        ].map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={p.action}
            className="bg-neutral-950 px-2 py-1.5 text-[10px] uppercase tracking-widest text-neutral-400 transition-colors hover:bg-neutral-900 hover:text-neutral-100"
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="12" height="12" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"
      className={'ml-1 shrink-0 text-neutral-500 transition-transform ' + (open ? 'rotate-180' : '')}
      aria-hidden
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

// =============================================================================
//  Stat card — primary (bigger) and secondary (smaller) tiers
// =============================================================================
// Color-coded tones for stat cards. Palette pulled from a coordinated
// luxury-nude family so the dashboard reads expensive at a glance.
//   revenue — champagne gold  (money in)
//   cost    — blush           (money out)
//   key     — warm cream      (headline metric)
//   warn    — cognac caramel  (outstanding / dues)
//   dept    — smoky taupe     (per-department income)
//   neutral — stone           (fallback)
//
// All values sit at roughly the same warm mid-tone saturation, so they
// feel like one palette rather than a rainbow.
type StatTone = 'revenue' | 'cost' | 'key' | 'warn' | 'dept' | 'neutral';

const TONE_STYLES: Record<StatTone, { accent: string; label: string; dot: string }> = {
  revenue: { accent: 'before:bg-[#b8956a]', label: 'text-[#b8956a]', dot: 'bg-[#b8956a]' }, // champagne gold
  cost:    { accent: 'before:bg-[#b8857a]', label: 'text-[#b8857a]', dot: 'bg-[#b8857a]' }, // blush
  key:     { accent: 'before:bg-[#c8b896]', label: 'text-[#c8b896]', dot: 'bg-[#c8b896]' }, // warm cream
  warn:    { accent: 'before:bg-[#b8754d]', label: 'text-[#b8754d]', dot: 'bg-[#b8754d]' }, // cognac caramel
  dept:    { accent: 'before:bg-[#a89890]', label: 'text-[#a89890]', dot: 'bg-[#a89890]' }, // smoky taupe
  neutral: { accent: 'before:bg-[#7c706a]', label: 'text-[#7c706a]', dot: 'bg-[#7c706a]' }, // stone
};

function StatCard({
  label,
  value,
  hint,
  tier,
  tone = 'neutral',
  onClick,
}: {
  label: string;
  value: string;
  hint?: string;
  tier: 'primary' | 'secondary';
  tone?: StatTone;
  onClick?: () => void;
}) {
  const isPrimary = tier === 'primary';
  const t = TONE_STYLES[tone];
  // `before:` pseudo-element draws a 3px colored accent bar down the
  // left edge of every card. Combined with a real border on each card
  // (instead of the old 1px-gap-with-background trick) this gives each
  // metric its own clearly framed box.
  const baseClasses =
    'relative text-left transition-all ' +
    (isPrimary 
      ? 'premium-card-primary p-7 pl-8' 
      : 'bg-neutral-950 hover:bg-neutral-900 border border-neutral-800 p-6 pl-7') +
    ' before:absolute before:left-0 before:top-0 before:h-full before:w-[3px] ' +
    t.accent;
  const content = (
    <>
      <div className="flex items-center gap-2">
        <span aria-hidden className={'inline-block h-2 w-2 ' + t.dot} />
        <div className={'text-[11px] font-bold uppercase tracking-editorial ' + t.label}>
          {label}
        </div>
      </div>
      <div className={'mt-3 font-serif font-semibold tabular-nums tracking-tight text-neutral-50 ' + (isPrimary ? 'text-4xl' : 'text-2xl')}>
        {value}
      </div>
      {hint && (
        <div className="mt-2 text-[10px] font-medium uppercase tracking-widest text-neutral-500">{hint}</div>
      )}
    </>
  );
  return onClick ? (
    <button type="button" onClick={onClick} className={baseClasses}>
      {content}
    </button>
  ) : (
    <div className={baseClasses}>{content}</div>
  );
}

// =============================================================================
//  Revenue chart — daily aggregated gross revenue
// =============================================================================
function RevenueChart({
  sales,
  withdrawals,
  redditIncome,
}: {
  sales: ChatterSale[];
  withdrawals: ModelWithdrawal[];
  redditIncome: RedditAccountIncome[];
}) {
  // Bucket by ISO date (YYYY-MM-DD).
  const data = useMemo(() => {
    const byDay = new Map<string, number>();
    const add = (date: string, cents: number) => {
      const k = date.slice(0, 10);
      byDay.set(k, (byDay.get(k) ?? 0) + cents);
    };
    for (const s of sales)        add(s.occurred_on, s.amount_cents);
    for (const w of withdrawals)  add(w.occurred_on, w.amount_cents);
    for (const r of redditIncome) add(r.month_start, r.amount_cents);
    return Array.from(byDay.entries())
      .map(([date, cents]) => ({ date, cents }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
  }, [sales, withdrawals, redditIncome]);

  return (
    <section className="border border-neutral-800 bg-neutral-950 p-5">
      <div className="mb-3 flex items-baseline justify-between border-b border-neutral-900 pb-2">
        <h3 className="font-serif text-base font-medium tracking-tight text-neutral-100">
          Revenue
        </h3>
        <span className="text-[10px] uppercase tracking-widest text-neutral-600">
          Daily gross
        </span>
      </div>
      {data.length === 0 ? (
        <div className="py-6">
          <EmptyState
            compact
            title="No revenue yet for this period."
            message="Log a sale or withdrawal on a department page, or import income on the Reddit page."
          />
        </div>
      ) : (
        <div className="h-72 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#262626" />
              <XAxis
                dataKey="date"
                tickFormatter={(d) => new Date(d as string).toLocaleString('en-US', { month: 'short', day: 'numeric' })}
                tick={{ fill: '#737373', fontSize: 11 }}
                stroke="#404040"
                minTickGap={32}
              />
              <YAxis
                tick={{ fill: '#737373', fontSize: 11 }}
                stroke="#404040"
                width={64}
                tickFormatter={(v) => `$${Math.round((v as number) / 100).toLocaleString()}`}
              />
              <Tooltip
                contentStyle={{ backgroundColor: '#0a0a0a', border: '1px solid #262626', color: '#fafafa', fontSize: 12 }}
                labelFormatter={(d) => new Date(d as string).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                formatter={(v: number) => [formatCents(v), 'Gross']}
              />
              <Line type="monotone" dataKey="cents" stroke="#fafafa" strokeWidth={2} dot={{ fill: '#fafafa', r: 2 }} activeDot={{ r: 4 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}

// =============================================================================
//  Outstanding list — every member with a non-zero owed balance.
//  Former employees are filtered out (the agency doesn't want reminders
//  about money owed to ex-staff). Each row also exposes a small × that
//  marks the member as former on the spot, so the user can dismiss a
//  stale row without having to navigate to Employees.
// =============================================================================
function OutstandingList({
  summaries,
  onMarkPaid,
}: {
  summaries: MemberSummary[];
  // Records a Payment for the full owed amount. Undo lives in the toast.
  onMarkPaid: (member: TeamMember, owedCents: number) => Promise<void>;
}) {
  const rows = useMemo(
    () =>
      summaries
        .filter((s) => s.owedCents > 0 && !isFormer(s.member))
        .sort((a, b) => b.owedCents - a.owedCents),
    [summaries],
  );
  const total = useMemo(() => rows.reduce((n, r) => n + r.owedCents, 0), [rows]);

  // Drive the "Mark paid" reveal from JS hover state rather than CSS :hover.
  // Safari can leave :hover stuck on rows the pointer passed over (and a
  // clicked button keeps :focus), which left buttons visible after the mouse
  // left. onMouseLeave on the list container guarantees a reset.
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  return (
    <section className="flex flex-col border border-neutral-800 bg-neutral-950 p-5">
      <div className="mb-3 flex items-baseline justify-between border-b border-neutral-900 pb-2">
        <h3 className="font-serif text-base font-medium tracking-tight text-neutral-100">
          Outstanding
        </h3>
        <span className="text-sm tabular-nums text-neutral-200">{formatCents(total)}</span>
      </div>
      {rows.length === 0 ? (
        <EmptyState
          compact
          title="Everyone's paid up."
          message="When a team member is owed money, they'll appear here with a one-click pay button."
        />
      ) : (
        // The scroll list is absolutely positioned so it fills the card's
        // height (driven by the Revenue chart next to it) without its own
        // content forcing the row taller. It scrolls when there are more
        // members than fit.
        <div className="relative min-h-0 lg:flex-1">
        <div
          className="max-h-72 overflow-y-auto divide-y divide-neutral-900 lg:absolute lg:inset-0 lg:max-h-none"
          onMouseLeave={() => setHoveredId(null)}
        >
          {rows.map((s) => (
            <div
              key={s.member.id}
              onMouseEnter={() => setHoveredId(s.member.id)}
              className="flex items-center justify-between gap-3 py-2.5"
            >
              <div className="min-w-0">
                <div className="text-sm text-neutral-100">{s.member.name}</div>
                <div className="text-[10px] uppercase tracking-widest text-neutral-600">
                  {s.member.role_label ?? payStructureLabel(s.member.pay_structure)}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm tabular-nums text-neutral-50">
                  {formatCents(s.owedCents)}
                </span>
                <button
                  type="button"
                  onClick={() => void onMarkPaid(s.member, s.owedCents)}
                  title={`Mark as paid (records a ${formatCents(s.owedCents)} payment)`}
                  aria-label={`Mark ${s.member.name} as paid`}
                  className={
                    'shrink-0 border border-neutral-800 px-2 py-1 text-[10px] uppercase tracking-widest text-neutral-300 transition-colors hover:border-neutral-400 hover:bg-neutral-900 hover:text-neutral-50 ' +
                    (hoveredId === s.member.id ? 'visible' : 'invisible')
                  }
                >
                  Mark paid
                </button>
              </div>
            </div>
          ))}
        </div>
        </div>
      )}
    </section>
  );
}

// =============================================================================
//  Top performers — top 3 chatters / models / tracking links
// =============================================================================
function TopPerformers({
  summaries,
  snapshots,
  links,
  scope,
  monthKey,
}: {
  summaries: MemberSummary[];
  snapshots: TrackingSnapshot[];
  links: TrackingLink[];
  scope: Scope;
  monthKey: string;
}) {
  const topChatters = useMemo(
    () =>
      summaries
        .filter((s) => s.member.pay_structure === 'commission')
        .sort((a, b) => b.earnedCents - a.earnedCents)
        .slice(0, 3),
    [summaries],
  );
  const topModels = useMemo(
    () =>
      summaries
        .filter((s) => s.member.pay_structure === 'share')
        .sort((a, b) => b.withdrawalsCents - a.withdrawalsCents)
        .slice(0, 3),
    [summaries],
  );
  const topLinks = useMemo(() => {
    const scoped = scope === 'all' ? snapshots : filterSnapshotsByMonth(snapshots, monthKey);
    const latestByLink = new Map<string, TrackingSnapshot>();
    for (const s of scoped) if (!latestByLink.has(s.link_id)) latestByLink.set(s.link_id, s);
    const linkById = new Map(links.map((l) => [l.id, l]));
    return Array.from(latestByLink.entries())
      .map(([linkId, snap]) => ({ link: linkById.get(linkId), subs: snap.subs }))
      .filter((x): x is { link: TrackingLink; subs: number } => !!x.link)
      .sort((a, b) => b.subs - a.subs)
      .slice(0, 3);
  }, [snapshots, links, scope, monthKey]);

  return (
    <section className="border border-neutral-800 bg-neutral-950 p-5">
      <div className="mb-3 flex items-baseline justify-between border-b border-neutral-900 pb-2">
        <h3 className="font-serif text-base font-medium tracking-tight text-neutral-100">
          Top performers
        </h3>
        <span className="text-[10px] uppercase tracking-widest text-neutral-600">
          Top 3 per category
        </span>
      </div>

      <PerformerGroup label="Chatters" empty="No chatters with sales.">
        {topChatters.map((s) => (
          <PerformerRow key={s.member.id} name={s.member.name} value={formatCents(s.earnedCents)} sub={`${formatCents(s.salesCents)} sales`} />
        ))}
      </PerformerGroup>

      <PerformerGroup label="Models" empty="No models with withdrawals.">
        {topModels.map((s) => (
          <PerformerRow key={s.member.id} name={s.member.name} value={formatCents(s.withdrawalsCents)} sub={`${formatCents(s.earnedCents)} earned`} />
        ))}
      </PerformerGroup>

      <PerformerGroup label="Tracking links" empty="No tracking snapshots in range.">
        {topLinks.map(({ link, subs }) => (
          <PerformerRow key={link.id} name={link.name} value={`${subs.toLocaleString()} subs`} sub={link.source ?? '—'} />
        ))}
      </PerformerGroup>
    </section>
  );
}

function PerformerGroup({
  label,
  empty,
  children,
}: {
  label: string;
  empty: string;
  children: React.ReactNode;
}) {
  const arr = Array.isArray(children) ? children : [children];
  const hasContent = arr.filter(Boolean).length > 0;
  return (
    <div className="mb-4 last:mb-0">
      <div className="mb-1.5 text-[10px] uppercase tracking-widest text-neutral-500">
        {label}
      </div>
      {hasContent ? (
        <div className="divide-y divide-neutral-900">{children}</div>
      ) : (
        <div className="flex h-12 items-center text-[10px] uppercase tracking-widest text-neutral-700">
          {empty}
        </div>
      )}
    </div>
  );
}

function PerformerRow({
  name,
  value,
  sub,
}: {
  name: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="flex items-baseline justify-between py-2">
      <div className="min-w-0">
        <div className="truncate text-sm text-neutral-100">{name}</div>
        <div className="text-[10px] uppercase tracking-widest text-neutral-600">{sub}</div>
      </div>
      <span className="text-sm tabular-nums text-neutral-200">{value}</span>
    </div>
  );
}

// =============================================================================
//  Recent activity — newest events across departments
// =============================================================================
type ActivityEvent = {
  ts: string;
  kind: 'sale' | 'withdrawal' | 'payment' | 'expense';
  label: string;
  amountCents: number;
};

function RecentActivity({
  sales,
  withdrawals,
  payments,
  expenses,
  nameById,
  activeIds,
}: {
  sales: ChatterSale[];
  withdrawals: ModelWithdrawal[];
  payments: Payment[];
  expenses: Expense[];
  // id -> name covering all members including soft-deleted ones, so the
  // feed still shows the real name when a record's team_member has been
  // removed from the active roster.
  nameById: Map<string, string>;
  // Set of currently-active team_member ids. If a referenced id is not in
  // this set, the helper appends "· former" so historical entries from
  // departed staff are visually marked even if nameById hasn't surfaced
  // that yet.
  activeIds: Set<string>;
}) {
  const memberName = (id: string) => {
    const name = nameById.get(id) ?? 'Unknown';
    if (activeIds.has(id)) return name;
    return name.includes('· former') ? name : `${name} · former`;
  };
  const events = useMemo<ActivityEvent[]>(() => {
    const out: ActivityEvent[] = [];
    for (const s of sales)        out.push({ ts: s.occurred_on,   kind: 'sale',       label: `${memberName(s.team_member_id)} · sale`,                amountCents: s.amount_cents });
    for (const w of withdrawals)  out.push({ ts: w.occurred_on,   kind: 'withdrawal', label: `${memberName(w.team_member_id)} · withdrawal`,          amountCents: w.amount_cents });
    for (const p of payments)     out.push({ ts: p.paid_on,       kind: 'payment',    label: `${memberName(p.team_member_id)} · paid`,                amountCents: p.amount_cents });
    for (const e of expenses)     out.push({ ts: e.incurred_on,   kind: 'expense',    label: `${e.name} · expense`,                                   amountCents: e.amount_cents });
    out.sort((a, b) => (a.ts < b.ts ? 1 : -1));
    return out.slice(0, 20);
  }, [sales, withdrawals, payments, expenses, nameById]);

  const toneFor = (k: ActivityEvent['kind']) => {
    if (k === 'sale' || k === 'withdrawal') return 'text-emerald-400';
    if (k === 'payment' || k === 'expense') return 'text-rose-400';
    return 'text-neutral-300';
  };
  const signFor = (k: ActivityEvent['kind']) => {
    if (k === 'sale' || k === 'withdrawal') return '+';
    return '−';
  };

  return (
    <section className="flex flex-col border border-neutral-800 bg-neutral-950 p-5">
      <div className="mb-3 flex items-baseline justify-between border-b border-neutral-900 pb-2">
        <h3 className="font-serif text-base font-medium tracking-tight text-neutral-100">
          Recent activity
        </h3>
        <span className="text-[10px] uppercase tracking-widest text-neutral-600">
          Newest {events.length}
        </span>
      </div>
      {events.length === 0 ? (
        <EmptyState
          compact
          title="Nothing logged yet."
          message="As your team logs sales, withdrawals, payments, and expenses, the newest will show up here."
        />
      ) : (
        // Absolutely-positioned scroll list so the activity feed fills the
        // card height set by Top performers next to it — and stops where that
        // card ends — instead of its own length stretching the row.
        <div className="relative min-h-0 lg:flex-1">
        <div className="max-h-96 overflow-y-auto divide-y divide-neutral-900 lg:absolute lg:inset-0 lg:max-h-none">
          {events.map((e, i) => (
            <div key={i} className="flex items-baseline justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <div className="truncate text-sm text-neutral-100">{e.label}</div>
                <div className="text-[10px] uppercase tracking-widest text-neutral-600">
                  {shortDate(e.ts)} · {e.kind}
                </div>
              </div>
              <span className={'whitespace-nowrap text-sm tabular-nums ' + toneFor(e.kind)}>
                {signFor(e.kind)}{formatCents(e.amountCents)}
              </span>
            </div>
          ))}
        </div>
        </div>
      )}
    </section>
  );
}

// =============================================================================
//  Helpers + tiny "all-time" wrappers around lib/* monthly listers
// =============================================================================
function DashboardSkeleton() {
  return (
    <>
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <StatCardSkeleton key={i} tier="primary" />
        ))}
      </div>
      <div className="mb-12 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <StatCardSkeleton key={i} tier="secondary" />
        ))}
      </div>
      <div className="mb-12 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <ChartSkeleton />
        </div>
        <ListSkeleton rows={5} />
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ListSkeleton rows={5} />
        <ListSkeleton rows={5} />
      </div>
    </>
  );
}

function shortDate(iso: string): string {
  const d = iso.length >= 10 ? new Date(iso.slice(0, 10) + 'T00:00:00') : new Date(iso);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric' });
}

function filterSnapshotsByMonth(
  snapshots: TrackingSnapshot[],
  monthKey: string,
): TrackingSnapshot[] {
  const [start, end] = monthRange(monthKey);
  // recorded_at is ISO datetime; date_created is plain date. The chart and
  // top-link views use recorded_at. Compare on the YYYY-MM-DD prefix.
  return snapshots.filter((s) => {
    const d = s.recorded_at.slice(0, 10);
    return d >= start && d < end;
  });
}

// "All-time" data fetchers — the lib/* helpers only expose per-month
// queries, so we fall back to the Supabase client here for the full-history
// case. Imported lazily to avoid pulling supabase into the dashboard for
// month-only views.
async function listAllSales(): Promise<ChatterSale[]> {
  const { supabase } = await import('../lib/supabase');
  const { getActiveAgencyId } = await import('../lib/agency');
  const agencyId = getActiveAgencyId();
  if (!agencyId) return [];
  const { data, error } = await supabase
    .from('chatter_sales')
    .select('id, agency_id, team_member_id, amount_cents, description, occurred_on, created_at')
    .eq('agency_id', agencyId)
    .is('deleted_at', null)
    .order('occurred_on', { ascending: false });
  if (error) throw error;
  return (data ?? []) as ChatterSale[];
}
async function listAllWithdrawals(): Promise<ModelWithdrawal[]> {
  const { supabase } = await import('../lib/supabase');
  const { getActiveAgencyId } = await import('../lib/agency');
  const agencyId = getActiveAgencyId();
  if (!agencyId) return [];
  const { data, error } = await supabase
    .from('model_withdrawals')
    .select('id, agency_id, team_member_id, amount_cents, description, occurred_on, created_at')
    .eq('agency_id', agencyId)
    .is('deleted_at', null)
    .order('occurred_on', { ascending: false });
  if (error) throw error;
  return (data ?? []) as ModelWithdrawal[];
}
async function listAllPayments(): Promise<Payment[]> {
  const { supabase } = await import('../lib/supabase');
  const { getActiveAgencyId } = await import('../lib/agency');
  const agencyId = getActiveAgencyId();
  if (!agencyId) return [];
  const { data, error } = await supabase
    .from('payments')
    .select('id, agency_id, team_member_id, amount_cents, note, paid_on, created_at')
    .eq('agency_id', agencyId)
    .is('deleted_at', null)
    .order('paid_on', { ascending: false });
  if (error) throw error;
  return (data ?? []) as Payment[];
}
async function listAllRedditIncome(): Promise<RedditAccountIncome[]> {
  const { supabase } = await import('../lib/supabase');
  const { getActiveAgencyId } = await import('../lib/agency');
  const agencyId = getActiveAgencyId();
  if (!agencyId) return [];
  const { data, error } = await supabase
    .from('reddit_account_income')
    .select('id, agency_id, account_id, amount_cents, month_start, created_at')
    .eq('agency_id', agencyId);
  if (error) throw error;
  return (data ?? []) as RedditAccountIncome[];
}

// =============================================================================
//  StatDetailModal — breakdown of where each top stat comes from
// =============================================================================
// Meta strings here read user-configured labels at call time, so the
// detail modal stays in sync if the user renames "Chatter" etc.
function statMeta(): Record<StatKey, { title: string; formula: string }> {
  return {
    gross: {
      title: 'Gross revenue',
      formula: 'Sum of income across every department in this period.',
    },
    payouts: {
      title: 'Total payouts',
      formula: 'Sum of every team member’s accrued earnings this period (commission, share, flat).',
    },
    profit: {
      title: 'Net profit',
      formula: 'Gross revenue minus total payouts minus expenses.',
    },
    owed: {
      title: 'Currently owed',
      formula: 'Per-member earned minus paid, clamped at zero.',
    },
    expenses: {
      title: 'Expenses',
      formula: 'Every expense whose date falls inside the selected period.',
    },
    unassigned: {
      title: 'Unassigned income',
      formula:
        'Transactions whose team member has no department, or Reddit accounts assigned to a non-marketing department. Delete any junk to reconcile your totals.',
    },
  };
}

function StatDetailModal({
  statKey,
  scopeLabel,
  totals,
  departmentTotals,
  payments,
  expenses,
  summaries,
  unassignedSales,
  unassignedWithdrawals,
  unassignedRedditIncome,
  redditAccountsForLookup,
  nameById,
  onChanged,
  onClose,
  onDeptNavigate,
}: {
  statKey: StatKey;
  scopeLabel: string;
  totals: {
    gross: number;
    payouts: number;
    paid: number;
    profit: number;
    owed: number;
    expenses: number;
    unassigned: number;
  };
  departmentTotals: { dept: Department; incomeCents: number; hint: string }[];
  payments: Payment[];
  expenses: Expense[];
  summaries: MemberSummary[];
  unassignedSales: ChatterSale[];
  unassignedWithdrawals: ModelWithdrawal[];
  unassignedRedditIncome: RedditAccountIncome[];
  // Reddit accounts including soft-deleted ones, so the UnassignedList
  // can resolve real labels for income rows whose account was removed.
  redditAccountsForLookup: RedditAccount[];
  nameById: Map<string, string>;
  onChanged: () => void;
  onClose: () => void;
  onDeptNavigate: (departmentId: string) => void;
}) {
  const meta = statMeta()[statKey];
  const headline = (() => {
    switch (statKey) {
      case 'gross':      return formatCents(totals.gross);
      case 'payouts':    return formatCents(totals.payouts);
      case 'profit':     return formatCents(totals.profit);
      case 'owed':       return formatCents(totals.owed);
      case 'expenses':   return formatCents(totals.expenses);
      case 'unassigned': return formatCents(totals.unassigned);
    }
  })();

  return (
    <Modal open onClose={onClose} eyebrow={`${scopeLabel} · breakdown`} title={meta.title} maxWidth="max-w-xl">
      <div className="mb-6 border border-neutral-900 bg-neutral-950 p-5">
        <div className="text-[10px] uppercase tracking-widest text-neutral-500">
          {meta.title}
        </div>
        <div className="mt-2 font-serif text-3xl font-semibold tabular-nums tracking-tight text-neutral-50">
          {headline}
        </div>
        <div className="mt-2 text-xs leading-relaxed text-neutral-500">{meta.formula}</div>
      </div>

      {statKey === 'gross' && (
        <FormulaList
          rows={
            departmentTotals.length > 0
              ? departmentTotals.map((d) => ({
                  left: `${d.dept.name} income`,
                  right: formatCents(d.incomeCents),
                  onClick: () => onDeptNavigate(d.dept.id),
                }))
              : [{ left: 'No departments yet', right: formatCents(0) }]
          }
          total={{ left: 'Gross revenue', right: formatCents(totals.gross) }}
        />
      )}

      {statKey === 'payouts' && (
        <BreakdownGroup
          title="Earned by team member"
          total={totals.payouts}
          rows={[...summaries]
            .filter((s) => s.earnedCents > 0)
            .sort((a, b) => b.earnedCents - a.earnedCents)
            .map((s) => ({
              left: s.member.name,
              mid: s.member.role_label ?? payStructureLabel(s.member.pay_structure),
              right: formatCents(s.earnedCents),
            }))}
          empty="Nobody has accrued earnings this period."
        />
      )}

      {statKey === 'profit' && (
        <FormulaList
          rows={[
            { left: 'Gross revenue',  right: formatCents(totals.gross) },
            { left: 'Total payouts',  right: `− ${formatCents(totals.payouts)}` },
            { left: 'Expenses',       right: `− ${formatCents(totals.expenses)}` },
          ]}
          total={{ left: 'Net profit', right: formatCents(totals.profit) }}
        />
      )}

      {statKey === 'owed' && (
        <BreakdownGroup
          title="Outstanding by team member"
          total={totals.owed}
          rows={[...summaries]
            .filter((s) => s.owedCents > 0 && !isFormer(s.member))
            .sort((a, b) => b.owedCents - a.owedCents)
            .map((s) => ({
              left: s.member.name,
              mid: `${formatCents(s.earnedCents)} earned · ${formatCents(s.paidCents)} paid`,
              right: formatCents(s.owedCents),
            }))}
          empty="Nobody is owed money right now."
        />
      )}

      {statKey === 'expenses' && (
        <BreakdownGroup
          title="Entries"
          total={totals.expenses}
          rows={expenses
            .slice()
            .sort((a, b) => (a.incurred_on < b.incurred_on ? 1 : -1))
            .map((e) => ({
              left: e.name,
              mid: shortIsoDate(e.incurred_on),
              right: formatCents(e.amount_cents),
            }))}
          empty="No expenses this period."
        />
      )}

      {statKey === 'unassigned' && (
        <UnassignedList
          sales={unassignedSales}
          withdrawals={unassignedWithdrawals}
          redditIncome={unassignedRedditIncome}
          redditAccounts={redditAccountsForLookup}
          nameById={nameById}
          onChanged={onChanged}
        />
      )}

      {/* Suppress unused-var lint for payments — still used for "paid" total in totals.paid. */}
      <span className="hidden">{payments.length}</span>
    </Modal>
  );
}

// =============================================================================
//  UnassignedList — rows of orphan transactions with a per-row Delete.
//  Deleting soft-deletes the underlying record (or zeros it, in the case
//  of reddit income), then triggers a dashboard reload so the totals
//  reconcile immediately.
// =============================================================================
function UnassignedList({
  sales,
  withdrawals,
  redditIncome,
  redditAccounts,
  nameById,
  onChanged,
}: {
  sales: ChatterSale[];
  withdrawals: ModelWithdrawal[];
  redditIncome: RedditAccountIncome[];
  redditAccounts: RedditAccount[];
  nameById: Map<string, string>;
  onChanged: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);

  const memberName = (id: string) => nameById.get(id) ?? 'Unknown';
  // `redditAccounts` is the lookup list — includes soft-deleted accounts
  // so we can show the real label (e.g. "juicy · Was run by xo") even
  // for orphan income rows.
  const resolveAccount = (id: string): { label: string; vaName: string | null } => {
    const a = redditAccounts.find((acct) => acct.id === id);
    if (!a) return { label: `Account ${id.slice(0, 8)}`, vaName: null };
    const vaName = a.team_member_id ? nameById.get(a.team_member_id) ?? null : null;
    return { label: a.label, vaName };
  };

  async function handleDelete(
    id: string,
    label: string,
    runDelete: () => Promise<void>,
  ) {
    const ok = await confirm({
      title: `Delete ${label}?`,
      message: 'This removes the entry permanently. The amount will drop off your gross revenue.',
      destructive: true,
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    setBusyId(id);
    try {
      await runDelete();
      toast.success('Entry deleted.');
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete.');
    } finally {
      setBusyId(null);
    }
  }

  const rows: { id: string; left: string; mid: string; cents: number; del: () => Promise<void> }[] = [
    ...sales.map((s) => ({
      id: `sale-${s.id}`,
      left: `${memberName(s.team_member_id)} · sale`,
      mid: shortIsoDate(s.occurred_on),
      cents: s.amount_cents,
      del: () => softDeleteSale(s.id),
    })),
    ...withdrawals.map((w) => ({
      id: `wd-${w.id}`,
      left: `${memberName(w.team_member_id)} · withdrawal`,
      mid: shortIsoDate(w.occurred_on),
      cents: w.amount_cents,
      del: () => softDeleteWithdrawal(w.id),
    })),
    ...redditIncome.map((r) => {
      const { label, vaName } = resolveAccount(r.account_id);
      return {
        id: `ri-${r.id}`,
        left: `${label} · reddit income`,
        mid: vaName
          ? `${shortIsoDate(r.month_start)} · was run by ${vaName}`
          : shortIsoDate(r.month_start),
        cents: r.amount_cents,
        // setIncome with 0 deletes the row outright.
        del: () => setRedditIncome(r.account_id, r.month_start.slice(0, 7), 0).then(() => undefined),
      };
    }),
  ].sort((a, b) => b.cents - a.cents);

  if (rows.length === 0) {
    return (
      <EmptyState
        compact
        title="Nothing unassigned."
        message="All income is attributed to a department. Math reconciled."
      />
    );
  }

  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between border-b border-neutral-900 pb-2">
        <h3 className="font-serif text-base font-medium tracking-tight text-neutral-100">
          Orphaned entries
        </h3>
        <span className="text-[10px] uppercase tracking-widest text-neutral-600">
          {rows.length}
        </span>
      </div>
      <div className="divide-y divide-neutral-900">
        {rows.map((r) => (
          <div key={r.id} className="grid grid-cols-[1fr_auto_auto] items-baseline gap-4 py-2.5">
            <div>
              <div className="text-sm text-neutral-100">{r.left}</div>
              <div className="text-[10px] uppercase tracking-widest text-neutral-600">{r.mid}</div>
            </div>
            <span className="text-sm tabular-nums text-neutral-200">
              {formatCents(r.cents)}
            </span>
            <button
              type="button"
              disabled={busyId === r.id}
              onClick={() => void handleDelete(r.id, r.left, r.del)}
              className="border border-neutral-800 px-2.5 py-1 text-[10px] uppercase tracking-widest text-neutral-400 transition-colors hover:border-red-700 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busyId === r.id ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

// Splits "− $1,500.00" into { sign: '−', amount: '$1,500.00' } so the
// sign can be rendered in a fixed-width slot and the $ symbols line up
// vertically across rows regardless of whether each is positive or negative.
function splitMoneyCell(s: string): { sign: '+' | '−' | ''; amount: string } {
  const trimmed = s.trim();
  if (trimmed.startsWith('−')) return { sign: '−', amount: trimmed.slice(1).trim() };
  if (trimmed.startsWith('+')) return { sign: '+', amount: trimmed.slice(1).trim() };
  return { sign: '', amount: trimmed };
}

function MoneyCell({ sign, amount }: { sign: '+' | '−' | ''; amount: string }) {
  return (
    <span className="inline-flex items-baseline tabular-nums">
      <span className="w-3 text-right text-neutral-400">{sign}</span>
      <span className="ml-1 text-neutral-200">{amount}</span>
    </span>
  );
}

function FormulaList({
  rows,
  total,
}: {
  rows: { left: string; right: string; onClick?: () => void }[];
  total: { left: string; right: string };
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
                title="View details"
              >
                {content}
                <span className="ml-2 text-[10px] uppercase tracking-widest text-neutral-600">
                  &rarr;
                </span>
              </button>
            );
          }
          return (
            <div key={r.left} className="flex items-baseline justify-between py-2.5 text-sm">
              {content}
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex items-baseline justify-between border-t border-neutral-700 pt-3">
        <span className="font-serif text-lg text-neutral-50">{total.left}</span>
        <span className="font-serif text-lg tabular-nums text-neutral-50">{total.right}</span>
      </div>
    </section>
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
  rows: { left: string; mid: string; right: string }[];
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
        <span className="text-sm tabular-nums text-neutral-300">{formatCents(total)}</span>
      </div>
      {rows.length === 0 ? (
        <div className="flex h-14 items-center justify-center border border-dashed border-neutral-800 text-[10px] uppercase tracking-widest text-neutral-600">
          {empty}
        </div>
      ) : (
        <div className="max-h-72 overflow-y-auto divide-y divide-neutral-900">
          {rows.map((r, i) => (
            <div key={`${r.left}-${i}`} className="grid grid-cols-[auto_1fr_auto] items-baseline gap-4 py-2.5">
              <div className="text-sm text-neutral-100">{r.left}</div>
              <div className="text-[10px] uppercase tracking-widest text-neutral-600">{r.mid}</div>
              <div className="text-right text-sm tabular-nums text-neutral-200">{r.right}</div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function shortIsoDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y!, (m! - 1), d!).toLocaleString('en-US', { month: 'short', day: 'numeric' });
}

