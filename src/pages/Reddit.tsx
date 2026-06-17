// =============================================================================
//  Reddit.tsx
//  Reddit marketing — accounts, monthly income, VA payouts.
// =============================================================================

import { useEffect, useMemo, useRef, useState } from 'react';
import { PageHeader } from '../components/PageHeader';
import { Modal } from '../components/Modal';
import { MemberEarningsModal, type ActivitySection } from '../components/MemberEarningsModal';
import { PaymentLedgerModal } from '../components/PaymentLedgerModal';
import { StatementExportModal, type ExportMember } from '../components/StatementExportModal';
import {
  monthsInRange,
  type Statement,
  type StatementLine,
  type StatementSection,
} from '../lib/statements';
import { Button, Field, Label, TextLink } from '../components/FormControls';
import { Select } from '../components/Select';
import { DatePicker } from '../components/DatePicker';
import {
  type RedditAccount,
  type RedditAccountIncome,
  type VASummary,
  listAccounts,
  listAllAccountsIncludingDeleted,
  createAccount,
  updateAccount,
  softDeleteAccount,
  listIncomeForMonth,
  setIncome,
  buildVASummaries,
} from '../lib/reddit';
import {
  type Payment,
  listPayments,
  createPayment,
  updatePayment,
  softDeletePayment,
  currentMonthKey,
  shiftMonthKey,
  monthLongLabel,
} from '../lib/ofm';
import {
  type TeamMember,
  listTeamMembers,
  listMemberNameMap,
  formatPayLine,
  isFormer,
} from '../lib/teamMembers';
import { confirm } from '../lib/confirm';
import { listDepartments } from '../lib/departments';
import { formatCents, parseDollarsToCents } from '../lib/money';
import { payStructureLabel } from '../lib/staffRoles';
import { toast } from '../lib/toast';

// =============================================================================
//  Page
// =============================================================================
// `departmentId` (optional) scopes the page to one department: only members
// in that department are considered "VAs" here, and only accounts assigned
// to those members (plus accounts with no VA assigned) are shown.
// `departmentName` overrides the title when rendered as a department tab.
export function Reddit({
  departmentId,
  departmentName,
}: { departmentId?: string; departmentName?: string } = {}) {
  const [monthKey, setMonthKey] = useState(currentMonthKey());
  const [accounts, setAccounts] = useState<RedditAccount[] | null>(null);
  // Full active-accounts list across all depts (before dept-scoping).
  // Needed so we can tell "this income's account is in ANOTHER dept"
  // apart from "this income's account was soft-deleted".
  const [allAccounts, setAllAccounts] = useState<RedditAccount[]>([]);
  // All accounts including soft-deleted ones. Used only for resolving
  // labels + VA names when displaying historical income rows whose
  // underlying account has since been removed.
  const [allAccountsEver, setAllAccountsEver] = useState<RedditAccount[]>([]);
  // id → display name for every team member, including soft-deleted ones.
  // Used so the modal can show the VA's name on income rows whose VA
  // has since left, rather than falling back to "Unassigned".
  const [memberNameMap, setMemberNameMap] = useState<Map<string, string>>(new Map());
  const [incomes, setIncomes] = useState<RedditAccountIncome[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [editingAccount, setEditingAccount] = useState<RedditAccount | null>(null);
  const [creatingAccount, setCreatingAccount] = useState(false);
  const [payingVA, setPayingVA] = useState<{ va: TeamMember; prefillCents?: number } | null>(null);
  const [openStat, setOpenStat] = useState<RedditStatKey | null>(null);
  const [editingPayment, setEditingPayment] = useState<Payment | null>(null);
  const [activityVA, setActivityVA] = useState<VASummary | null>(null);
  const [ledgerMember, setLedgerMember] = useState<TeamMember | null>(null);
  const [exporting, setExporting] = useState(false);
  // Whether this page is the agency's first marketing department. The
  // dashboard uses that dept to absorb income from soft-deleted reddit
  // accounts (we have no other dept to attribute them to). The same
  // rule has to live here so this page's account-income total matches
  // the dashboard's matching card — otherwise the numbers diverge.
  const [isFirstMarketingDept, setIsFirstMarketingDept] = useState(false);

  async function reload(key = monthKey) {
    try {
      const [a, aAll, i, p, m, depts, nmap] = await Promise.all([
        listAccounts(),
        listAllAccountsIncludingDeleted(),
        listIncomeForMonth(key),
        listPayments(key),
        listTeamMembers(),
        listDepartments(),
        listMemberNameMap(),
      ]);
      setAllAccountsEver(aAll);
      setMemberNameMap(nmap);
      const firstMarketing = depts.find((d) => d.layout_type === 'marketing');
      setIsFirstMarketingDept(
        // No departmentId means we're on the legacy /reddit route. The
        // dashboard's catch-all rule doesn't apply there, so behave like
        // the first marketing dept (include orphans) to stay consistent
        // with what the dashboard would attribute.
        !departmentId || firstMarketing?.id === departmentId,
      );
      setAllAccounts(a);
      // If scoped to a department, drop members + accounts that don't belong.
      // Accounts with no assigned VA are kept (unassigned belongs everywhere).
      if (departmentId) {
        const scopedMembers = m.filter((x) => x.department_id === departmentId);
        const scopedIds = new Set(scopedMembers.map((x) => x.id));
        const scopedAccounts = a.filter(
          (x) => x.team_member_id === null || scopedIds.has(x.team_member_id),
        );
        setMembers(scopedMembers);
        setAccounts(scopedAccounts);
      } else {
        setMembers(m);
        setAccounts(a);
      }
      setIncomes(i);
      setPayments(p);
    } catch (e) {
      setError(e as Error);
    }
  }

  useEffect(() => {
    void reload(monthKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthKey, departmentId]);

  const loading = accounts === null;

  // Income rows split into two buckets:
  //   * scoped — rows for accounts that are currently visible on this
  //     page (an active account whose VA is in this dept, or unassigned).
  //   * archived — rows whose underlying account was soft-deleted. The
  //     account record is gone but the income persists; the dashboard
  //     attributes these to the first marketing dept, so this page does
  //     the same when it IS the first marketing dept.
  const scopedIncomes = useMemo(() => {
    if (!accounts) return [];
    const ids = new Set(accounts.map((a) => a.id));
    return incomes.filter((i) => ids.has(i.account_id));
  }, [accounts, incomes]);

  // Archived = income whose underlying account is not in the agency's
  // active accounts list (i.e. the account was soft-deleted). We use
  // `allAccounts` (not dept-scoped) so we don't accidentally flag
  // accounts that belong to OTHER marketing depts as archived.
  const archivedIncomes = useMemo(() => {
    if (!isFirstMarketingDept) return [];
    const liveIds = new Set(allAccounts.map((a) => a.id));
    return incomes.filter((i) => !liveIds.has(i.account_id));
  }, [incomes, allAccounts, isFirstMarketingDept]);

  // Combined for all downstream totals/VA rollups.
  const validIncomes = useMemo(
    () => (isFirstMarketingDept ? [...scopedIncomes, ...archivedIncomes] : scopedIncomes),
    [scopedIncomes, archivedIncomes, isFirstMarketingDept],
  );

  const incomeByAccount = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of validIncomes) m.set(i.account_id, i.amount_cents);
    return m;
  }, [validIncomes]);

  // Per-VA rollups: only includes members assigned to ≥1 Reddit account.
  const vaSummaries = useMemo<VASummary[]>(() => {
    if (!accounts) return [];
    // Filter payments to only those for VAs that own a Reddit account.
    const vaIds = new Set(accounts.map((a) => a.team_member_id).filter(Boolean) as string[]);
    const vaPayments = payments.filter((p) => vaIds.has(p.team_member_id));
    return buildVASummaries(accounts, validIncomes, members, vaPayments, monthKey);
  }, [accounts, validIncomes, members, payments, monthKey]);

  // Selectable people for export = VAs with at least one Reddit account.
  const exportMembers: ExportMember[] = vaSummaries.map((v) => ({
    id: v.member.id,
    name: v.member.name,
    roleLabel: v.member.role_label ?? payStructureLabel(v.member.pay_structure),
  }));

  // Build per-VA statements over a month range (sums monthly VA summaries).
  async function buildRedditStatements(ids: string[], from: string, to: string): Promise<Statement[]> {
    const idSet = new Set(ids);
    const accts = await listAllAccountsIncludingDeleted();
    const labelById = new Map(accts.map((a) => [a.id, a.label]));
    const memberByAccount = new Map(
      accts.filter((a) => a.team_member_id).map((a) => [a.id, a.team_member_id as string]),
    );
    type Acc = { income: number; earned: number; paid: number; incomeItems: StatementLine[]; payItems: StatementLine[] };
    const acc = new Map<string, Acc>();
    for (const id of ids) acc.set(id, { income: 0, earned: 0, paid: 0, incomeItems: [], payItems: [] });
    const months = monthsInRange(from, to);
    for (const mk of months) {
      const [incomes, pays] = await Promise.all([listIncomeForMonth(mk), listPayments(mk)]);
      for (const v of buildVASummaries(accts, incomes, members, pays, mk)) {
        const a = acc.get(v.member.id);
        if (!a) continue;
        a.income += v.incomeCents;
        a.earned += v.earnedCents;
        a.paid += v.paidCents;
      }
      for (const i of incomes) {
        const mid = memberByAccount.get(i.account_id);
        if (mid && idSet.has(mid)) acc.get(mid)!.incomeItems.push({ date: i.month_start, label: labelById.get(i.account_id) ?? 'Account', amountCents: i.amount_cents });
      }
      for (const p of pays) if (idSet.has(p.team_member_id)) acc.get(p.team_member_id)!.payItems.push({ date: p.paid_on, label: p.note ?? 'Payment', amountCents: p.amount_cents });
    }
    const pct = (r: number) => `${+((r ?? 0) * 100).toFixed(2)}%`;
    const out: Statement[] = [];
    for (const id of ids) {
      const m = members.find((mm) => mm.id === id);
      const a = acc.get(id);
      if (!m || !a) continue;
      const basisLine =
        m.pay_structure === 'flat'
          ? `${formatCents(m.flat_amount_cents ?? 0)} every ${m.flat_period_days ?? 0} days · ${months.length} month${months.length === 1 ? '' : 's'}`
          : `${formatCents(a.income)} account income × ${pct(m.rate ?? 0)}`;
      const sections: StatementSection[] = [];
      if (a.incomeItems.length) sections.push({ title: 'Account income', items: a.incomeItems });
      if (a.payItems.length) sections.push({ title: 'Payments', items: a.payItems });
      out.push({
        memberName: m.name,
        roleLabel: m.role_label ?? payStructureLabel(m.pay_structure),
        basisLine,
        earnedCents: a.earned,
        paidCents: a.paid,
        owedCents: Math.max(0, a.earned - a.paid),
        sections,
      });
    }
    return out;
  }

  // Per-VA lookups: monthly cost (earned) and outstanding owed for the
  // VA who owns each account. Same value shown on every card that VA owns.
  const vaInfoByMemberId = useMemo(() => {
    const m = new Map<string, { earned: number; owed: number }>();
    for (const v of vaSummaries) {
      m.set(v.member.id, { earned: v.earnedCents, owed: v.owedCents });
    }
    return m;
  }, [vaSummaries]);

  // Headline stats.
  const stats = useMemo(() => {
    if (!accounts) return null;
    const accountIncome = validIncomes.reduce((n, i) => n + i.amount_cents, 0);
    const paid = vaSummaries.reduce((n, v) => n + v.paidCents, 0);
    const employeeCost = vaSummaries.reduce((n, v) => n + v.earnedCents, 0);
    // Owed totals exclude former employees — once a VA has left we don't
    // want the page surfacing unpaid balances to ex-staff.
    const owed = vaSummaries
      .filter((v) => !isFormer(v.member))
      .reduce((n, v) => n + v.owedCents, 0);
    const netProfit = accountIncome - employeeCost;
    const accountsCount = accounts.length;
    return { accountIncome, employeeCost, netProfit, paid, owed, accountsCount };
  }, [accounts, validIncomes, vaSummaries]);

  return (
    <div className="dashboard-spotlight pb-24 text-neutral-100">
      <div className="mx-auto max-w-6xl px-8 pt-8">
        <PageHeader
          eyebrow={departmentName ? 'Department · Marketing' : 'Reddit marketing'}
          title={departmentName ? `${departmentName}.` : 'Reddit.'}
          subtitle="Accounts, monthly income, and payouts to your Reddit VAs."
          actions={
            <>
              <button
                onClick={() => setExporting(true)}
                disabled={loading}
                className="border border-white/10 px-4 py-3 text-[11px] font-medium uppercase tracking-widest text-neutral-200 transition-colors hover:border-white/20 disabled:opacity-40"
              >
                Export
              </button>
              <button
                onClick={() => setCreatingAccount(true)}
                disabled={loading}
                className="bg-neutral-50 px-4 py-3 text-[11px] font-medium uppercase tracking-widest text-neutral-950 transition-colors hover:bg-neutral-300 disabled:opacity-40"
              >
                Add account
              </button>
            </>
          }
        />

        {error && (
          <div className="mb-6 premium-card !border-red-900/60 !bg-red-950/30 p-4 text-sm text-red-200">
            {error.message}
          </div>
        )}

      <MonthPicker monthKey={monthKey} onChange={setMonthKey} />

      {loading ? (
        <Loading />
      ) : (
        <>
          {stats && <TopStats stats={stats} onOpen={setOpenStat} />}

          <AccountsSection
            accounts={accounts!}
            members={members}
            incomeByAccount={incomeByAccount}
            vaInfoByMemberId={vaInfoByMemberId}
            monthKey={monthKey}
            onEdit={setEditingAccount}
            onIncomeChanged={() => void reload(monthKey)}
            onPayOwed={(va, owedCents) =>
              setPayingVA({ va, prefillCents: owedCents > 0 ? owedCents : undefined })
            }
          />

          {/* Income from accounts the user previously deleted. Counted in
              the top stats so the page total matches the dashboard, but
              rendered separately so the rest of the UI stays clean. */}
          {archivedIncomes.length > 0 && (
            <ArchivedAccountsSection
              rows={archivedIncomes}
              accountsForLookup={allAccountsEver}
              memberNameMap={memberNameMap}
              monthKey={monthKey}
              onChanged={() => void reload(monthKey)}
            />
          )}

          <VASection
            summaries={vaSummaries}
            onPayVA={(va) => setPayingVA({ va })}
            onOpen={(v) => setActivityVA(v)}
          />
        </>
      )}

      {(creatingAccount || editingAccount) && (
        <AccountFormModal
          account={editingAccount}
          members={members}
          onClose={() => {
            setCreatingAccount(false);
            setEditingAccount(null);
          }}
          onSaved={() => {
            setCreatingAccount(false);
            setEditingAccount(null);
            void reload(monthKey);
          }}
        />
      )}

      {payingVA && (
        <PayVAModal
          va={payingVA.va}
          prefillCents={payingVA.prefillCents}
          onClose={() => setPayingVA(null)}
          onSaved={() => {
            setPayingVA(null);
            void reload(monthKey);
          }}
        />
      )}

      {openStat && stats && accounts && (
        <RedditStatModal
          statKey={openStat}
          monthLabel={monthLongLabel(monthKey)}
          stats={stats}
          // Includes soft-deleted accounts so the breakdown can still
          // resolve "juicy · Run by xo" for income rows whose account
          // was later removed (instead of falling back to "Unknown").
          accountsForLookup={allAccountsEver}
          members={members}
          memberNameMap={memberNameMap}
          incomes={validIncomes}
          payments={payments}
          vaSummaries={vaSummaries}
          onClose={() => setOpenStat(null)}
          onEditPayment={(p) => {
            setOpenStat(null);
            setEditingPayment(p);
          }}
          onPayVA={(va, owedCents) =>
            setPayingVA({ va, prefillCents: owedCents > 0 ? owedCents : undefined })
          }
        />
      )}

      {editingPayment && (
        <EditPaymentModal
          payment={editingPayment}
          memberName={
            members.find((m) => m.id === editingPayment.team_member_id)?.name ?? 'Unknown'
          }
          onClose={() => setEditingPayment(null)}
          onSaved={() => {
            setEditingPayment(null);
            void reload(monthKey);
          }}
        />
      )}

      {activityVA && (
        <VAActivityModal
          va={activityVA}
          monthLabel={monthLongLabel(monthKey)}
          incomes={validIncomes}
          payments={payments}
          onClose={() => setActivityVA(null)}
          onEditPayment={(p) => {
            setActivityVA(null);
            setEditingPayment(p);
          }}
          onViewHistory={() => {
            const m = activityVA.member;
            setActivityVA(null);
            setLedgerMember(m);
          }}
        />
      )}

      {ledgerMember && (
        <PaymentLedgerModal
          memberId={ledgerMember.id}
          memberName={ledgerMember.name}
          onClose={() => setLedgerMember(null)}
        />
      )}

      {exporting && (
        <StatementExportModal
          members={exportMembers}
          onBuild={buildRedditStatements}
          onClose={() => setExporting(false)}
        />
      )}
      </div>
    </div>
  );
}

// =============================================================================
//  Month picker (matches OFM)
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
//  Top stats — 4 boxes (primary tier)
// =============================================================================
type Stats = {
  accountIncome: number;
  employeeCost: number;
  netProfit: number;
  paid: number;
  owed: number;
  accountsCount: number;
};

type RedditStatKey = 'account-income' | 'employee-cost' | 'net-profit' | 'currently-owed';

function TopStats({
  stats,
  onOpen,
}: {
  stats: Stats;
  onOpen: (key: RedditStatKey) => void;
}) {
  return (
    <div className="mb-12 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Stat
        tone="revenue"
        label="Account income"
        value={formatCents(stats.accountIncome)}
        hint={`${stats.accountsCount} account${stats.accountsCount === 1 ? '' : 's'}`}
        onClick={() => onOpen('account-income')}
      />
      <Stat
        tone="cost"
        label="Employee cost"
        value={formatCents(stats.employeeCost)}
        hint="What VAs accrue this month"
        onClick={() => onOpen('employee-cost')}
      />
      <Stat
        tone="key"
        label="Net profit"
        value={formatCents(stats.netProfit)}
        hint="Income − cost"
        onClick={() => onOpen('net-profit')}
      />
      <Stat
        tone="warn"
        label="Outstanding payment to employees"
        value={formatCents(stats.owed)}
        hint={`${formatCents(stats.paid)} paid this month`}
        onClick={() => onOpen('currently-owed')}
      />
    </div>
  );
}

type StatTone = 'revenue' | 'cost' | 'key' | 'warn' | 'dept' | 'neutral';

const TONE_STYLES: Record<StatTone, { accent: string; label: string; dot: string }> = {
  revenue: { accent: 'before:bg-[#b8956a]', label: 'text-[#b8956a]', dot: 'bg-[#b8956a]' },
  cost:    { accent: 'before:bg-[#b8857a]', label: 'text-[#b8857a]', dot: 'bg-[#b8857a]' },
  key:     { accent: 'before:bg-[#c8b896]', label: 'text-[#c8b896]', dot: 'bg-[#c8b896]' },
  warn:    { accent: 'before:bg-[#b8754d]', label: 'text-[#b8754d]', dot: 'bg-[#b8754d]' },
  dept:    { accent: 'before:bg-[#a89890]', label: 'text-[#a89890]', dot: 'bg-[#a89890]' },
  neutral: { accent: 'before:bg-[#7c706a]', label: 'text-[#7c706a]', dot: 'bg-[#7c706a]' },
};

function Stat({
  label,
  value,
  hint,
  tone = 'neutral',
  onClick,
}: {
  label: string;
  value: string;
  hint: string;
  tone?: StatTone;
  onClick: () => void;
}) {
  const t = TONE_STYLES[tone];
  const baseClasses =
    'relative text-left transition-all premium-card-primary p-7' +
    ' focus:outline-none focus:ring-2 focus:ring-white/20';

  return (
    <button type="button" onClick={onClick} className={baseClasses}>
      <div className="flex items-center gap-2">
        <span aria-hidden className={'inline-block h-2 w-2 ' + t.dot} />
        <div className={'text-[11px] font-bold uppercase tracking-editorial ' + t.label}>
          {label}
        </div>
      </div>
      <div className="mt-3 font-serif text-4xl font-semibold tabular-nums tracking-tight text-neutral-50">
        {value}
      </div>
      <div className="mt-2 text-[10px] font-medium uppercase tracking-widest text-neutral-500">
        {hint}
      </div>
    </button>
  );
}

// =============================================================================
//  ArchivedAccountsSection — income rows from accounts the user has
//  soft-deleted. The income lives on (no FK cascade), so we surface it
//  here with a per-row Delete so the user can clear it. This is shown
//  only on the agency's first marketing department, matching the
//  dashboard's attribution rule.
// =============================================================================
function ArchivedAccountsSection({
  rows,
  accountsForLookup,
  memberNameMap,
  monthKey,
  onChanged,
}: {
  rows: RedditAccountIncome[];
  // All reddit accounts including soft-deleted — used to recover labels
  // and original VA assignments for these archived income rows.
  accountsForLookup: RedditAccount[];
  // id → name for every team member, including soft-deleted ones.
  memberNameMap: Map<string, string>;
  monthKey: string;
  onChanged: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const totalCents = rows.reduce((n, r) => n + r.amount_cents, 0);
  const accountById = new Map(accountsForLookup.map((a) => [a.id, a]));

  async function handleDelete(r: RedditAccountIncome) {
    const ok = await confirm({
      title: 'Delete this income entry?',
      message:
        'The underlying account is already deleted. Removing this row drops the amount from your monthly income.',
      destructive: true,
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    setBusyId(r.id);
    try {
      // setIncome with amount=0 deletes the row outright.
      await setIncome(r.account_id, monthKey, 0);
      toast.success('Removed.');
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="mb-12">
      <div className="mb-4 flex items-baseline justify-between border-b border-neutral-800 pb-3">
        <div className="flex items-baseline gap-3">
          <h2 className="font-serif text-2xl font-semibold tracking-tight text-neutral-100">
            Archived accounts
          </h2>
          <span className="text-[10px] font-medium uppercase tracking-editorial text-neutral-500">
            {rows.length}
          </span>
        </div>
        <span className="text-xs text-neutral-500">
          {formatCents(totalCents)} · income from deleted accounts
        </span>
      </div>

      <div className="premium-card">
        <div className="divide-y divide-white/5">
          {rows.map((r) => {
            const acct = accountById.get(r.account_id);
            const vaName = acct?.team_member_id
              ? memberNameMap.get(acct.team_member_id) ?? null
              : null;
            return (
              <div
                key={r.id}
                className="grid grid-cols-[1fr_auto_auto] items-baseline gap-4 px-5 py-3"
              >
                <div>
                  <div className="font-serif text-base text-neutral-100">
                    {acct?.label ?? `Account ${r.account_id.slice(0, 8)}`}
                    <span className="ml-2 text-[10px] uppercase tracking-widest text-neutral-600">
                      Deleted
                    </span>
                  </div>
                  <div className="mt-0.5 text-[10px] uppercase tracking-widest text-neutral-600">
                    {vaName ? `Was run by ${vaName} · ` : ''}Month start {r.month_start}
                  </div>
                </div>
                <span className="text-sm tabular-nums text-neutral-200">
                  {formatCents(r.amount_cents)}
                </span>
                <button
                  type="button"
                  disabled={busyId === r.id}
                  onClick={() => void handleDelete(r)}
                  className="border border-neutral-800 px-2.5 py-1 text-[10px] uppercase tracking-widest text-neutral-400 transition-colors hover:border-red-700 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busyId === r.id ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

// =============================================================================
//  Accounts section — card grid (Income / Cost / Profit, Owed button)
// =============================================================================
function AccountsSection({
  accounts,
  members,
  incomeByAccount,
  vaInfoByMemberId,
  monthKey,
  onEdit,
  onIncomeChanged,
  onPayOwed,
}: {
  accounts: RedditAccount[];
  members: TeamMember[];
  incomeByAccount: Map<string, number>;
  vaInfoByMemberId: Map<string, { earned: number; owed: number }>;
  monthKey: string;
  onEdit: (a: RedditAccount) => void;
  onIncomeChanged: () => void;
  onPayOwed: (va: TeamMember, owedCents: number) => void;
}) {
  const memberById = useMemo(() => {
    const m = new Map<string, TeamMember>();
    for (const tm of members) m.set(tm.id, tm);
    return m;
  }, [members]);

  return (
    <section className="mb-12">
      <div className="mb-4 flex items-baseline justify-between border-b border-neutral-800 pb-3">
        <div className="flex items-baseline gap-3">
          <h2 className="font-serif text-2xl font-semibold tracking-tight text-neutral-100">
            Accounts
          </h2>
          <span className="text-[10px] font-medium uppercase tracking-editorial text-neutral-500">
            {accounts.length}
          </span>
        </div>
        <span className="text-xs text-neutral-500">Income · Cost · Profit per account.</span>
      </div>

      {accounts.length === 0 ? (
        <div className="flex h-32 flex-col items-center justify-center gap-2 border border-dashed border-neutral-800 px-6 text-center">
          <div className="font-serif text-lg text-neutral-200">No Reddit accounts yet.</div>
          <div className="text-[10px] uppercase tracking-widest text-neutral-600">
            Use Add account to get started.
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {accounts.map((a) => {
            const va = a.team_member_id ? memberById.get(a.team_member_id) ?? null : null;
            const vaInfo = va ? vaInfoByMemberId.get(va.id) : undefined;
            return (
              <AccountCard
                key={a.id}
                account={a}
                va={va}
                incomeCents={incomeByAccount.get(a.id) ?? 0}
                costCents={vaInfo?.earned ?? 0}
                vaOwedCents={vaInfo?.owed ?? 0}
                monthKey={monthKey}
                onEdit={() => onEdit(a)}
                onIncomeSaved={onIncomeChanged}
                onPayOwed={() => va && onPayOwed(va, vaInfo?.owed ?? 0)}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

function AccountCard({
  account,
  va,
  incomeCents,
  costCents,
  vaOwedCents,
  monthKey,
  onEdit,
  onIncomeSaved,
  onPayOwed,
}: {
  account: RedditAccount;
  va: TeamMember | null;
  incomeCents: number;
  costCents: number;
  vaOwedCents: number;
  monthKey: string;
  onEdit: () => void;
  onIncomeSaved: () => void;
  onPayOwed: () => void;
}) {
  const profitCents = incomeCents - costCents;
  const profitTone =
    profitCents < 0 ? 'text-rose-400' : profitCents > 0 ? 'text-emerald-400' : 'text-neutral-400';

  return (
    <div className="flex flex-col premium-card p-5 hover:-translate-y-[2px] transition-transform">
      {/* Header */}
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h3 className="font-serif text-xl tracking-tight text-neutral-50">
            {account.label}
          </h3>
          <div className="mt-1 text-[10px] uppercase tracking-widest text-neutral-600">
            {va ? <>Run by {va.name}</> : <span className="italic text-neutral-700">Unassigned</span>}
          </div>
        </div>
        <span className="text-[9px] uppercase tracking-widest text-neutral-700">
          Account
        </span>
      </div>

      {/* Stats */}
      <div className="mt-5 grid grid-cols-3 gap-3 border-y border-neutral-900 py-4">
        <CardStat
          label="Account income"
          value={formatCents(incomeCents)}
          valueClass="text-neutral-50"
        />
        <CardStat
          label="Employee cost"
          value={formatCents(costCents)}
          valueClass={costCents > 0 ? 'text-rose-400' : 'text-neutral-500'}
        />
        <CardStat
          label="Net profit"
          value={formatCents(profitCents)}
          valueClass={profitTone}
        />
      </div>

      {/* VA pay line */}
      {va && (
        <div className="mt-3 text-[10px] uppercase tracking-widest text-neutral-600">
          {va.name} · {formatPayLine(va)}
        </div>
      )}
      {account.client_notes && (
        <div className="mt-2 text-[11px] italic text-neutral-500">
          {account.client_notes}
        </div>
      )}

      {/* Inline income edit */}
      <div className="mt-4 flex items-baseline justify-between border-t border-neutral-900 pt-4">
        <span className="text-[10px] uppercase tracking-widest text-neutral-600">
          Update income
        </span>
        <InlineIncome
          accountId={account.id}
          monthKey={monthKey}
          initialCents={incomeCents}
          onSaved={onIncomeSaved}
        />
      </div>

      {/* Actions */}
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={onPayOwed}
          disabled={!va || vaOwedCents <= 0}
          className="flex-1 border border-neutral-700 px-3 py-2.5 text-[11px] font-medium uppercase tracking-widest text-neutral-100 transition-colors hover:border-neutral-400 disabled:cursor-not-allowed disabled:border-neutral-900 disabled:text-neutral-700"
          title={
            !va
              ? 'Assign a VA first.'
              : vaOwedCents <= 0
                ? 'Nothing currently owed to this VA.'
                : `Pay ${va.name} ${formatCents(vaOwedCents)}`
          }
        >
          {va
            ? `Owed to ${va.name} · ${formatCents(vaOwedCents)}`
            : `Owed · ${formatCents(vaOwedCents)}`}
        </button>
        <button
          type="button"
          onClick={onEdit}
          className="border border-neutral-800 px-3 py-2.5 text-[11px] uppercase tracking-widest text-neutral-500 transition-colors hover:border-neutral-500 hover:text-neutral-200"
          title="Edit account"
        >
          Edit
        </button>
      </div>
    </div>
  );
}

function CardStat({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass: string;
}) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-widest text-neutral-600">
        {label}
      </div>
      <div className={'mt-1 font-serif text-lg font-semibold tabular-nums ' + valueClass}>
        {value}
      </div>
    </div>
  );
}

// Click-to-edit income cell. Shows formatted dollars; click to reveal an input.
function InlineIncome({
  accountId,
  monthKey,
  initialCents,
  onSaved,
}: {
  accountId: string;
  monthKey: string;
  initialCents: number;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initialCents > 0 ? (initialCents / 100).toString() : '');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setDraft(initialCents > 0 ? (initialCents / 100).toString() : '');
  }, [initialCents]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  async function commit() {
    if (saving) return;
    const cents = draft.trim() === '' ? 0 : parseDollarsToCents(draft);
    if (cents == null || cents < 0) {
      toast.error('Income must be a positive amount or blank.');
      setDraft(initialCents > 0 ? (initialCents / 100).toString() : '');
      setEditing(false);
      return;
    }
    if (cents === initialCents) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await setIncome(accountId, monthKey, cents);
      toast.success('Income saved.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save income.');
    } finally {
      setSaving(false);
      setEditing(false);
    }
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="text-sm tabular-nums text-neutral-100 transition-colors hover:text-neutral-400"
        title="Click to edit"
      >
        {initialCents > 0 ? formatCents(initialCents) : <span className="text-neutral-700">— set —</span>}
      </button>
    );
  }

  return (
    <input
      ref={inputRef}
      type="text"
      inputMode="decimal"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void commit();
        if (e.key === 'Escape') {
          setDraft(initialCents > 0 ? (initialCents / 100).toString() : '');
          setEditing(false);
        }
      }}
      disabled={saving}
      placeholder="0.00"
      className="w-28 border border-neutral-700 bg-neutral-950 px-2 py-1 text-right text-sm tabular-nums text-neutral-100 focus:border-neutral-400 focus:outline-none"
    />
  );
}

// =============================================================================
//  Per-VA section
// =============================================================================
function VASection({
  summaries,
  onPayVA,
  onOpen,
}: {
  summaries: VASummary[];
  onPayVA: (m: TeamMember) => void;
  onOpen: (v: VASummary) => void;
}) {
  if (summaries.length === 0) {
    return null;
  }
  return (
    <section className="mb-12">
      <div className="mb-4 flex items-baseline justify-between border-b border-neutral-800 pb-3">
        <div className="flex items-baseline gap-3">
          <h2 className="font-serif text-2xl font-semibold tracking-tight text-neutral-100">
            VAs
          </h2>
          <span className="text-[10px] font-medium uppercase tracking-editorial text-neutral-500">
            {summaries.length}
          </span>
        </div>
        <span className="text-xs text-neutral-500">Performance by VA this month.</span>
      </div>

      <div className="divide-y divide-neutral-900">
        {summaries.map((v) => (
          <div key={v.member.id} className="py-5">
            <div
              style={{ gridTemplateColumns: '1fr 8rem 8rem 8rem 8rem' }}
              className="grid items-center gap-4 px-2"
            >
              <div>
                <button
                  type="button"
                  onClick={() => onOpen(v)}
                  className="font-serif text-lg text-neutral-50 transition-colors hover:text-neutral-300"
                  title={`View ${v.member.name}'s earnings breakdown`}
                >
                  {v.member.name}
                </button>
                <div className="mt-0.5 text-[10px] uppercase tracking-widest text-neutral-600">
                  {v.member.role_label ?? payStructureLabel(v.member.pay_structure)} · {formatPayLine(v.member)}
                </div>
              </div>
              <div className="text-right text-sm tabular-nums text-neutral-300">
                {formatCents(v.incomeCents)}
                <div className="mt-0.5 text-[9px] uppercase tracking-widest text-neutral-600">
                  Account income
                </div>
              </div>
              <div className="text-right text-sm tabular-nums text-neutral-100">
                {formatCents(v.earnedCents)}
                <div className="mt-0.5 text-[9px] uppercase tracking-widest text-neutral-600">
                  Employee cost
                </div>
              </div>
              <div className="text-right text-sm tabular-nums text-neutral-300">
                {formatCents(v.paidCents)}
                <div className="mt-0.5 text-[9px] uppercase tracking-widest text-neutral-600">
                  Paid
                </div>
              </div>
              <div className="flex flex-col items-end gap-1">
                <button
                  type="button"
                  onClick={() => onPayVA(v.member)}
                  disabled={v.owedCents <= 0}
                  className={
                    'text-sm tabular-nums transition-colors disabled:cursor-default ' +
                    (v.owedCents > 0
                      ? 'text-neutral-50 hover:text-neutral-300'
                      : 'text-neutral-600')
                  }
                  title={v.owedCents > 0 ? `Pay ${v.member.name}` : 'Nothing owed right now.'}
                >
                  {formatCents(v.owedCents)}
                </button>
                <div className="text-[9px] uppercase tracking-widest text-neutral-600">
                  Owed
                </div>
              </div>
            </div>

            {/* Accounts this VA owns */}
            <div className="mt-3 flex flex-wrap gap-2 px-2">
              {v.accounts.map((a) => (
                <span
                  key={a.id}
                  className="border border-neutral-800 px-2 py-1 text-[10px] uppercase tracking-widest text-neutral-500"
                >
                  {a.label}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// Human-readable description of how a VA's earnings were derived. Flat shows
// the prorated wage; commission/share both collapse to "% of account income"
// on the marketing side.
function redditBasisLine(m: TeamMember, incomeCents: number): string {
  const pct = (r: number) => `${+((r ?? 0) * 100).toFixed(2)}%`;
  const periods = (n: number) => (Number.isInteger(n) ? `${n}` : n.toFixed(2));
  if (m.pay_structure === 'flat') {
    const period = m.flat_period_days ?? 0;
    const amount = m.flat_amount_cents ?? 0;
    let perMonth = 0;
    if (period > 0) {
      if (period === 7) perMonth = 4;
      else if (period === 14) perMonth = 2;
      else if (period === 30) perMonth = 1;
      else if (period >= 360) perMonth = 1 / 12;
      else perMonth = 30 / period;
    }
    return `${formatCents(amount)} every ${period} days × ${periods(perMonth)} this month`;
  }
  return `${formatCents(incomeCents)} account income × ${pct(m.rate ?? 0)}`;
}

// Earnings drill-down for a Reddit VA: the basis math, payments, and the
// per-account income line items that built their number.
function VAActivityModal({
  va,
  monthLabel,
  incomes,
  payments,
  onClose,
  onEditPayment,
  onViewHistory,
}: {
  va: VASummary;
  monthLabel: string;
  incomes: RedditAccountIncome[];
  payments: Payment[];
  onClose: () => void;
  onEditPayment: (p: Payment) => void;
  onViewHistory: () => void;
}) {
  const accountIds = new Set(va.accounts.map((a) => a.id));
  const labelById = new Map(va.accounts.map((a) => [a.id, a.label]));

  const sections: ActivitySection[] = [
    {
      title: 'Account income',
      empty: 'No income recorded this month.',
      items: incomes
        .filter((i) => accountIds.has(i.account_id))
        .map((i) => ({
          id: i.id,
          date: i.month_start,
          amountCents: i.amount_cents,
          note: labelById.get(i.account_id) ?? null,
        })),
    },
    {
      title: 'Payments',
      empty: 'No payments this month.',
      items: payments
        .filter((p) => p.team_member_id === va.member.id)
        .map((p) => ({
          id: p.id,
          date: p.paid_on,
          amountCents: p.amount_cents,
          note: p.note,
          onClick: () => onEditPayment(p),
        })),
    },
  ];

  return (
    <MemberEarningsModal
      title={va.member.name}
      eyebrow={`${monthLabel} · ${va.member.role_label ?? payStructureLabel(va.member.pay_structure)}`}
      basisLine={redditBasisLine(va.member, va.incomeCents)}
      earnedCents={va.earnedCents}
      paidCents={va.paidCents}
      sections={sections}
      onClose={onClose}
      onViewHistory={onViewHistory}
    />
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

// =============================================================================
//  Add / Edit account modal
// =============================================================================
function AccountFormModal({
  account,
  members,
  onClose,
  onSaved,
}: {
  account: RedditAccount | null;
  members: TeamMember[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEditing = account !== null;
  const [label, setLabel] = useState(account?.label ?? '');
  const [memberId, setMemberId] = useState<string>(account?.team_member_id ?? '');
  const [notes, setNotes] = useState(account?.client_notes ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    if (!label.trim()) {
      toast.error('Label is required.');
      return;
    }
    setSubmitting(true);
    try {
      if (isEditing && account) {
        await updateAccount(account.id, {
          label,
          team_member_id: memberId || null,
          client_notes: notes,
        });
      } else {
        await createAccount({
          label,
          team_member_id: memberId || null,
          client_notes: notes,
        });
      }
      toast.success(isEditing ? 'Account updated.' : 'Account added.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    if (!account || deleting) return;
    const ok = await confirm({
      title: 'Delete this account?',
      message: 'Its income history and VA assignment will be removed too.',
      destructive: true,
      confirmLabel: 'Delete account',
    });
    if (!ok) return;
    setDeleting(true);
    try {
      await softDeleteAccount(account.id);
      toast.success('Account removed.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete.');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow={isEditing ? 'Edit account' : 'Add account'}
      title={isEditing ? account!.label : 'New Reddit account'}
    >
      <form onSubmit={handleSubmit} noValidate>
        <Field
          id="label"
          label="Account label"
          type="text"
          required
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. u/handle_name"
          hint="The Reddit handle or a nickname."
        />

        <div className="mb-5">
          <Label htmlFor="va">VA (optional)</Label>
          <Select
            id="va"
            value={memberId}
            onChange={setMemberId}
            options={[
              { value: '', label: 'Unassigned', detail: '' },
              ...members.map((m) => ({
                value: m.id,
                label: m.name,
                detail: m.role_label ?? payStructureLabel(m.pay_structure),
              })),
            ]}
          />
        </div>

        <div className="mb-5">
          <Label htmlFor="notes">Notes (optional)</Label>
          <textarea
            id="notes"
            value={notes ?? ''}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            placeholder="e.g. ban risk: high, primary VIP funnel"
            className="block w-full border border-neutral-800 bg-neutral-950 px-3.5 py-3 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
          />
        </div>

        <div className="mt-8 flex flex-col gap-3">
          <Button type="submit" loading={submitting}>
            {isEditing ? 'Save changes' : 'Add account'}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>

        {isEditing && (
          <div className="mt-6 border-t border-neutral-900 pt-5 text-right">
            <TextLink onClick={handleDelete}>
              {deleting ? 'Deleting…' : 'Delete account'}
            </TextLink>
          </div>
        )}
      </form>
    </Modal>
  );
}

// =============================================================================
//  Pay a Reddit VA — small wrapper around createPayment
// =============================================================================
function PayVAModal({
  va,
  prefillCents,
  onClose,
  onSaved,
}: {
  va: TeamMember;
  prefillCents?: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [amountDollars, setAmountDollars] = useState(
    prefillCents && prefillCents > 0 ? (prefillCents / 100).toFixed(2) : '',
  );
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState(
    prefillCents && prefillCents > 0 ? 'Paid outstanding balance' : '',
  );
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    const cents = parseDollarsToCents(amountDollars);
    if (cents == null || cents <= 0) {
      toast.error('Amount must be greater than zero.');
      return;
    }
    setSubmitting(true);
    try {
      await createPayment({
        team_member_id: va.id,
        amount_cents: cents,
        paid_on: date,
        note: note.trim() || null,
      });
      toast.success(`Logged payment to ${va.name}.`);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Log payment"
      title={`Pay ${va.name}`}
    >
      <form onSubmit={handleSubmit} noValidate>
        <Field
          id="amount"
          label="Amount"
          type="text"
          inputMode="decimal"
          required
          value={amountDollars}
          onChange={(e) => setAmountDollars(e.target.value)}
          placeholder="e.g. 500.00"
          hint="Dollars."
        />

        <div className="mb-5">
          <Label htmlFor="date">Date</Label>
          <DatePicker id="date" value={date} onChange={setDate} />
        </div>

        <div className="mb-5">
          <Label htmlFor="note">Note (optional)</Label>
          <textarea
            id="note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder="e.g. May payout"
            className="block w-full border border-neutral-800 bg-neutral-950 px-3.5 py-3 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
          />
        </div>

        <div className="mt-8 flex flex-col gap-3">
          <Button type="submit" loading={submitting}>
            Log payment
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
//  RedditStatModal — breakdown of where each top-of-page stat comes from
// =============================================================================
function RedditStatModal({
  statKey,
  monthLabel,
  stats,
  accountsForLookup,
  members,
  memberNameMap,
  incomes,
  payments,
  vaSummaries,
  onClose,
  onEditPayment,
  onPayVA,
}: {
  statKey: RedditStatKey;
  monthLabel: string;
  stats: Stats;
  // Reddit accounts including soft-deleted, used for label + VA lookup
  // so historical income rows still resolve to their real names.
  accountsForLookup: RedditAccount[];
  members: TeamMember[];
  // id → name for every member, including soft-deleted. Falls back via
  // `memberById` for live names so we get up-to-date renames; this map
  // only kicks in when the active list doesn't have the id.
  memberNameMap: Map<string, string>;
  incomes: RedditAccountIncome[];
  payments: Payment[];
  vaSummaries: VASummary[];
  onClose: () => void;
  onEditPayment: (p: Payment) => void;
  onPayVA: (va: TeamMember, owedCents: number) => void;
}) {
  const meta = REDDIT_STAT_META[statKey];
  const headline = (() => {
    switch (statKey) {
      case 'account-income': return formatCents(stats.accountIncome);
      case 'employee-cost':  return formatCents(stats.employeeCost);
      case 'net-profit':     return formatCents(stats.netProfit);
      case 'currently-owed': return formatCents(stats.owed);
    }
  })();

  const memberById = new Map(members.map((m) => [m.id, m]));
  const accountById = new Map(accountsForLookup.map((a) => [a.id, a]));

  // Resolve a member id to a display name, preferring the active roster
  // (so renames show up) and falling back to the full name map (so
  // soft-deleted VAs still resolve to their real name).
  const resolveMemberName = (id: string): string =>
    memberById.get(id)?.name ?? memberNameMap.get(id) ?? 'Unknown';

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
          {headline}
        </div>
        <div className="mt-2 text-xs leading-relaxed text-neutral-500">
          {meta.formula}
        </div>
      </div>

      {statKey === 'account-income' && (
        <BreakdownGroup
          title="Income by account"
          total={stats.accountIncome}
          empty="No income logged this month."
          rows={incomes
            .map((i) => {
              const acct = accountById.get(i.account_id);
              return {
                left: acct?.label ?? `Account ${i.account_id.slice(0, 8)}`,
                mid:
                  acct?.team_member_id
                    ? `Run by ${resolveMemberName(acct.team_member_id)}`
                    : 'Unassigned',
                right: formatCents(i.amount_cents),
              };
            })
            .sort((a, b) => (a.right < b.right ? 1 : -1))}
        />
      )}

      {statKey === 'employee-cost' && (
        <BreakdownGroup
          title="VA monthly accrual"
          total={stats.employeeCost}
          empty="No VAs assigned to any accounts."
          rows={vaSummaries.map((v) => ({
            left: v.member.name,
            mid: `${v.accounts.length} account${v.accounts.length === 1 ? '' : 's'} · ${formatPayLine(v.member)}`,
            right: formatCents(v.earnedCents),
          }))}
        />
      )}

      {statKey === 'net-profit' && (
        <FormulaList
          rows={[
            { left: 'Account income',  right: formatCents(stats.accountIncome) },
            { left: 'Employee cost',   right: `− ${formatCents(stats.employeeCost)}` },
          ]}
          total={{ left: 'Net profit', right: formatCents(stats.netProfit) }}
        />
      )}

      {statKey === 'currently-owed' && (
        <>
          <BreakdownGroup
            title="Outstanding by VA"
            total={stats.owed}
            empty="Nobody is owed money right now."
            rows={vaSummaries
              .filter((v) => v.owedCents > 0 && !isFormer(v.member))
              .sort((a, b) => b.owedCents - a.owedCents)
              .map((v) => ({
                left: v.member.name,
                mid: `${formatCents(v.earnedCents)} earned · ${formatCents(v.paidCents)} paid · click to log payment`,
                right: formatCents(v.owedCents),
                // Click the row to open the Pay VA modal prefilled with what
                // they're owed. We close this breakdown first so the payment
                // modal isn't covered by the dimmed backdrop.
                onClick: () => {
                  onClose();
                  onPayVA(v.member, v.owedCents);
                },
              }))}
          />
          {/* Only show payments to VAs assigned to a Reddit account so the
              breakdown matches the "$X paid this month" total. */}
          <BreakdownGroup
            title="Payments logged this month"
            total={stats.paid}
            empty="No VA payments logged this month."
            rows={payments
              .filter((p) => vaSummaries.some((v) => v.member.id === p.team_member_id))
              .sort((a, b) => (a.paid_on < b.paid_on ? 1 : -1))
              .map((p) => ({
                left: resolveMemberName(p.team_member_id),
                mid: `${shortDate(p.paid_on)}${p.note ? ' · ' + displayNote(p.note) : ''}`,
                right: formatCents(p.amount_cents),
                onClick: () => onEditPayment(p),
              }))}
          />
        </>
      )}
    </Modal>
  );
}

const REDDIT_STAT_META: Record<RedditStatKey, { title: string; formula: string }> = {
  'account-income': {
    title: 'Account income',
    formula: 'Sum of every account’s logged income for this month.',
  },
  'employee-cost': {
    title: 'Employee cost',
    formula: 'Total monthly pay accruing to every VA assigned to a Reddit account.',
  },
  'net-profit': {
    title: 'Net profit',
    formula: 'Account income minus employee cost.',
  },
  'currently-owed': {
    title: 'Currently owed',
    formula: 'VAs whose monthly accrual exceeds what you’ve already paid them this month.',
  },
};

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
        <span className="text-sm tabular-nums text-neutral-300">{formatCents(total)}</span>
      </div>
      {rows.length === 0 ? (
        <div className="flex h-14 items-center justify-center border border-dashed border-neutral-800 text-[10px] uppercase tracking-widest text-neutral-600">
          {empty}
        </div>
      ) : (
        <div className="divide-y divide-neutral-900">
          {rows.map((r, i) => {
            const inner = (
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
            const key = `${r.left}-${i}`;
            return r.onClick ? (
              <button
                key={key}
                type="button"
                onClick={r.onClick}
                className="grid w-full grid-cols-[auto_1fr_auto] items-baseline gap-4 py-2.5 text-left transition-colors hover:bg-neutral-900"
                title="Click to edit"
              >
                {inner}
              </button>
            ) : (
              <div
                key={key}
                className="grid grid-cols-[auto_1fr_auto] items-baseline gap-4 py-2.5"
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

function FormulaList({
  rows,
  total,
}: {
  rows: { left: string; right: string }[];
  total: { left: string; right: string };
}) {
  return (
    <section>
      <div className="divide-y divide-neutral-900">
        {rows.map((r) => (
          <div
            key={r.left}
            className="flex items-baseline justify-between py-2.5 text-sm"
          >
            <span className="text-neutral-300">{r.left}</span>
            <span className="tabular-nums text-neutral-200">{r.right}</span>
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-baseline justify-between border-t border-neutral-700 pt-3">
        <span className="font-serif text-lg text-neutral-50">{total.left}</span>
        <span className="font-serif text-lg tabular-nums text-neutral-50">
          {total.right}
        </span>
      </div>
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

// Display-time fix for payment notes auto-generated by older builds of the
// app. The previous prefill text used progressive tense; we now use past
// tense. Old DB rows still carry the old wording — normalize them on render
// so the user doesn't see "Paying" on a payment that's already been made.
function displayNote(note: string): string {
  if (note === 'Paying outstanding balance') return 'Paid outstanding balance';
  return note;
}

// =============================================================================
//  EditPaymentModal — edit or delete an existing VA payment
// =============================================================================
function EditPaymentModal({
  payment,
  memberName,
  onClose,
  onSaved,
}: {
  payment: Payment;
  memberName: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [amountDollars, setAmountDollars] = useState((payment.amount_cents / 100).toString());
  const [date, setDate] = useState(payment.paid_on);
  const [note, setNote] = useState(payment.note ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    const cents = parseDollarsToCents(amountDollars);
    if (cents == null || cents <= 0) {
      toast.error('Amount must be greater than zero.');
      return;
    }
    setSubmitting(true);
    try {
      await updatePayment(payment.id, {
        amount_cents: cents,
        paid_on: date,
        note,
      });
      toast.success('Payment updated.');
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
      title: 'Delete this payment?',
      message: 'It will be removed from the activity log and totals will recalculate.',
      destructive: true,
      confirmLabel: 'Delete payment',
    });
    if (!ok) return;
    setDeleting(true);
    try {
      await softDeletePayment(payment.id);
      toast.success('Payment removed.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete.');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Modal open onClose={onClose} eyebrow="Edit payment" title={`Pay ${memberName}`}>
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
          <Label htmlFor="edit-note">Note</Label>
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
            {deleting ? 'Deleting…' : 'Delete payment'}
          </TextLink>
        </div>
      </form>
    </Modal>
  );
}
