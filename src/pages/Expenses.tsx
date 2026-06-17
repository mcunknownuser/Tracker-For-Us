// =============================================================================
//  Expenses.tsx
//  All recorded expenses, grouped by month. Add/edit/delete via modal.
//  Manage categories and payment methods via the gear button → Settings.
// =============================================================================

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { Modal } from '../components/Modal';
import { Button, Field, Label, TextLink } from '../components/FormControls';
import { Select } from '../components/Select';
import { DatePicker } from '../components/DatePicker';
import { ROUTES } from '../lib/routes';
import {
  type Expense,
  type RecurrenceKind,
  listExpenses,
  createExpense,
  updateExpense,
  softDeleteExpense,
  listDueRecurring,
  logNextOccurrence,
  skipNextOccurrence,
  stopRecurring,
  monthKey,
  monthLabel,
} from '../lib/expenses';
import {
  type ExpenseCategory,
  listExpenseCategories,
} from '../lib/expenseCategories';
import {
  type PaymentMethod,
  listPaymentMethods,
} from '../lib/paymentMethods';
import {
  formatCents,
  parseDollarsToCents,
} from '../lib/money';
import { toast } from '../lib/toast';
import { confirm } from '../lib/confirm';

// =============================================================================
//  Page
// =============================================================================
export function Expenses() {
  const [expenses, setExpenses] = useState<Expense[] | null>(null);
  const [due, setDue] = useState<Expense[] | null>(null);
  const [categories, setCategories] = useState<ExpenseCategory[] | null>(null);
  const [methods, setMethods] = useState<PaymentMethod[] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [modal, setModal] = useState<
    { mode: 'create' } | { mode: 'edit'; expense: Expense } | null
  >(null);

  async function reload() {
    try {
      const [e, c, m, d] = await Promise.all([
        listExpenses(),
        listExpenseCategories(),
        listPaymentMethods(),
        listDueRecurring(),
      ]);
      setExpenses(e);
      setCategories(c);
      setMethods(m);
      setDue(d);
    } catch (err) {
      setError(err as Error);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  const loading = expenses === null || categories === null || methods === null;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        eyebrow="Spending"
        title="Expenses."
        subtitle="Track every dollar that leaves the agency. Manage categories with the gear icon."
        actions={
          <>
            <button
              onClick={() => setModal({ mode: 'create' })}
              disabled={loading}
              className="bg-neutral-50 px-5 py-3 text-[11px] font-medium uppercase tracking-widest text-neutral-950 transition-colors hover:bg-neutral-300 disabled:opacity-40"
            >
              Add expense
            </button>
            <Link
              to={ROUTES.settingsExpenses}
              title="Manage categories and payment methods"
              aria-label="Expense settings"
              className="flex items-center justify-center border border-neutral-800 px-4 text-neutral-400 transition-colors hover:border-neutral-500 hover:text-neutral-100"
            >
              <GearIcon />
            </Link>
          </>
        }
      />

      {error && (
        <div className="mb-6 border border-red-900/60 bg-red-950/30 p-4 text-sm text-red-200">
          {error.message}
        </div>
      )}

      {loading ? (
        <Loading />
      ) : (
        <>
          {due && due.length > 0 && (
            <DueBanner
              items={due}
              categories={categories!}
              methods={methods!}
              onAnyChange={() => void reload()}
            />
          )}
          {expenses!.length === 0 ? (
            <EmptyState onAdd={() => setModal({ mode: 'create' })} />
          ) : (
            <>
              <StatsRow expenses={expenses!} />
              <MonthlyList
                expenses={expenses!}
                categories={categories!}
                methods={methods!}
                onEdit={(ex) => setModal({ mode: 'edit', expense: ex })}
              />
            </>
          )}
        </>
      )}

      {modal && categories && methods && (
        <ExpenseFormModal
          modal={modal}
          categories={categories}
          methods={methods}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            void reload();
          }}
        />
      )}
    </div>
  );
}

// =============================================================================
//  Due banner — recurring expenses whose next_due_on is today or earlier.
// =============================================================================
function DueBanner({
  items,
  categories,
  methods,
  onAnyChange,
}: {
  items: Expense[];
  categories: ExpenseCategory[];
  methods: PaymentMethod[];
  onAnyChange: () => void;
}) {
  const categoryMap = new Map(categories.map((c) => [c.id, c]));
  const methodMap   = new Map(methods.map((m) => [m.id, m]));

  return (
    <section className="mb-10 border border-neutral-700 bg-neutral-950">
      <div className="border-b border-neutral-800 px-6 py-3">
        <div className="text-[10px] font-medium uppercase tracking-editorial text-neutral-400">
          {items.length} {items.length === 1 ? 'expense' : 'expenses'} due
        </div>
      </div>
      <div className="divide-y divide-neutral-900">
        {items.map((item) => (
          <DueRow
            key={item.id}
            item={item}
            category={item.category_id ? categoryMap.get(item.category_id) : undefined}
            method={item.payment_method_id ? methodMap.get(item.payment_method_id) : undefined}
            onChange={onAnyChange}
          />
        ))}
      </div>
    </section>
  );
}

function DueRow({
  item,
  category,
  method,
  onChange,
}: {
  item: Expense;
  category?: ExpenseCategory;
  method?: PaymentMethod;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState<'log' | 'skip' | 'stop' | null>(null);

  async function handleLog() {
    if (busy) return;
    setBusy('log');
    try {
      await logNextOccurrence(item);
      toast.success(`Logged "${item.name}".`);
      onChange();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not log.');
    } finally {
      setBusy(null);
    }
  }

  async function handleSkip() {
    if (busy) return;
    setBusy('skip');
    try {
      await skipNextOccurrence(item);
      toast.success(`Skipped one occurrence of "${item.name}".`);
      onChange();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not skip.');
    } finally {
      setBusy(null);
    }
  }

  async function handleStop() {
    if (busy) return;
    const ok = await confirm({
      title: `Stop "${item.name}" from recurring?`,
      message:
        'Future occurrences will not be scheduled. Existing entries stay in your history. You can always add a new recurring expense later.',
      confirmLabel: 'Stop recurring',
      destructive: true,
    });
    if (!ok) return;
    setBusy('stop');
    try {
      await stopRecurring(item);
      toast.success(`Stopped recurring "${item.name}".`);
      onChange();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not stop.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid grid-cols-[1fr,auto] items-start gap-6 px-4 py-3">
      {/* Left column: all info (name, meta, note). Grows as needed. */}
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-neutral-100">
            {item.name}
          </span>
          <span className="shrink-0 border border-neutral-800 px-1.5 py-px text-[9px] font-medium uppercase tracking-widest text-neutral-500">
            {item.recurrence_kind ?? 'recurring'}
          </span>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
          <span>
            Due {formatShortDate(item.next_due_on ?? '')} · {formatCents(item.amount_cents)}
          </span>
          {category && <TagChip color={category.color} label={category.name} />}
          {method && <TagChip color={method.color} label={method.name} />}
        </div>
        {item.note && (
          <div className="mt-1.5 truncate text-xs text-neutral-500">
            {item.note}
          </div>
        )}
      </div>

      {/* Right column: action buttons anchored at the top. Width is fixed
          regardless of how tall the left column grows. */}
      <div className="flex flex-col items-stretch gap-2">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleSkip}
            disabled={!!busy}
            className="border border-neutral-800 px-4 py-2 text-[11px] font-medium uppercase tracking-widest text-neutral-400 transition-colors hover:border-neutral-600 hover:text-neutral-200 disabled:opacity-40"
          >
            {busy === 'skip' ? '…' : 'Skip'}
          </button>
          <button
            type="button"
            onClick={handleLog}
            disabled={!!busy}
            className="bg-neutral-50 px-4 py-2 text-[11px] font-medium uppercase tracking-widest text-neutral-950 transition-colors hover:bg-neutral-300 disabled:opacity-40"
          >
            {busy === 'log' ? '…' : 'Log it'}
          </button>
        </div>
        <button
          type="button"
          onClick={handleStop}
          disabled={!!busy}
          className="border border-neutral-900 px-3 py-1 text-[10px] uppercase tracking-widest text-neutral-600 transition-colors hover:border-neutral-700 hover:text-neutral-400 disabled:opacity-40"
        >
          {busy === 'stop' ? '…' : 'Stop recurring'}
        </button>
      </div>
    </div>
  );
}

// =============================================================================
//  Stats row
// =============================================================================
function StatsRow({ expenses }: { expenses: Expense[] }) {
  const stats = useMemo(() => {
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const thisMonth = expenses.filter((e) => e.incurred_on.startsWith(ym));
    const totalThisMonth = thisMonth.reduce((sum, e) => sum + e.amount_cents, 0);
    const recurringThisMonth = thisMonth
      .filter((e) => e.is_recurring)
      .reduce((sum, e) => sum + e.amount_cents, 0);
    return {
      totalThisMonth,
      recurringThisMonth,
      countAllTime: expenses.length,
    };
  }, [expenses]);

  return (
    <div className="mb-8 grid grid-cols-1 gap-3 sm:grid-cols-3">
      <Stat label="This month" value={formatCents(stats.totalThisMonth)} tone="cost" />
      <Stat label="Recurring (this month)" value={formatCents(stats.recurringThisMonth)} tone="dept" />
      <Stat label="Entries on file" value={stats.countAllTime.toLocaleString()} tone="neutral" />
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

function Stat({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: StatTone }) {
  const t = TONE_STYLES[tone];
  return (
    <div className="relative text-left transition-all premium-card-primary p-7">
      <div className="flex items-center gap-2">
        <span aria-hidden className={'inline-block h-2 w-2 ' + t.dot} />
        <div className={'text-[11px] font-bold uppercase tracking-editorial ' + t.label}>
          {label}
        </div>
      </div>
      <div className="mt-3 font-serif text-4xl font-semibold tabular-nums tracking-tight text-neutral-50">
        {value}
      </div>
    </div>
  );
}

// =============================================================================
//  Monthly list
// =============================================================================
function MonthlyList({
  expenses,
  categories,
  methods,
  onEdit,
}: {
  expenses: Expense[];
  categories: ExpenseCategory[];
  methods: PaymentMethod[];
  onEdit: (e: Expense) => void;
}) {
  const categoryMap = useMemo(
    () => new Map(categories.map((c) => [c.id, c])),
    [categories],
  );
  const methodMap = useMemo(
    () => new Map(methods.map((m) => [m.id, m])),
    [methods],
  );

  // Group by YYYY-MM, preserving the descending date order from the query.
  const grouped = useMemo(() => {
    const map = new Map<string, Expense[]>();
    for (const e of expenses) {
      const k = monthKey(e.incurred_on);
      const arr = map.get(k) ?? [];
      arr.push(e);
      map.set(k, arr);
    }
    return Array.from(map.entries()); // already in date order
  }, [expenses]);

  return (
    <div className="space-y-6">
      {grouped.map(([key, group]) => {
        const total = group.reduce((s, e) => s + e.amount_cents, 0);
        return (
          <section key={key} className="border border-neutral-800 bg-neutral-950">
            <div className="flex items-baseline justify-between border-b border-neutral-800 px-4 py-3">
              <div className="flex items-baseline gap-3">
                <h2 className="font-serif text-lg font-semibold tracking-tight text-neutral-100">
                  {monthLabel(key)}
                </h2>
                <span className="text-[10px] font-medium uppercase tracking-editorial text-neutral-600">
                  {group.length} {group.length === 1 ? 'entry' : 'entries'}
                </span>
              </div>
              <div className="text-sm font-medium tabular-nums text-neutral-200">
                {formatCents(total)}
              </div>
            </div>

            <div className="divide-y divide-neutral-900">
              {group.map((e) => (
                <ExpenseRow
                  key={e.id}
                  expense={e}
                  category={e.category_id ? categoryMap.get(e.category_id) : undefined}
                  method={e.payment_method_id ? methodMap.get(e.payment_method_id) : undefined}
                  onClick={() => onEdit(e)}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function ExpenseRow({
  expense,
  category,
  method,
  onClick,
}: {
  expense: Expense;
  category?: ExpenseCategory;
  method?: PaymentMethod;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="group flex w-full items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-neutral-900/60"
    >
      <span className="w-14 shrink-0 text-xs tabular-nums text-neutral-500">
        {formatShortDate(expense.incurred_on)}
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-neutral-100">
            {expense.name}
          </span>
          {expense.is_recurring && (
            <span className="shrink-0 border border-neutral-800 px-1.5 py-px text-[9px] font-medium uppercase tracking-widest text-neutral-500">
              Recurring
            </span>
          )}
        </span>
        {expense.note && (
          <span className="mt-0.5 block truncate text-xs text-neutral-500">
            {expense.note}
          </span>
        )}
      </span>

      <span className="hidden shrink-0 items-center gap-2 sm:flex">
        {category && <TagChip color={category.color} label={category.name} />}
        {method && <TagChip color={method.color} label={method.name} />}
      </span>

      <span className="w-24 shrink-0 text-right text-sm font-medium tabular-nums text-neutral-100">
        {formatCents(expense.amount_cents)}
      </span>
    </button>
  );
}

function TagChip({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex max-w-[10rem] items-center gap-1.5 border border-neutral-800 bg-neutral-900/60 px-2 py-0.5 text-[11px] text-neutral-400">
      <span className="h-1.5 w-1.5 shrink-0" style={{ backgroundColor: color }} />
      <span className="truncate">{label}</span>
    </span>
  );
}

function formatShortDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y!, (m! - 1), d!).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
  });
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

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex h-64 flex-col items-center justify-center gap-4 border border-dashed border-neutral-800 px-6 text-center">
      <div>
        <div className="font-serif text-xl text-neutral-200">No expenses logged yet.</div>
        <div className="mt-1 text-xs uppercase tracking-widest text-neutral-600">
          Start with anything you spent today.
        </div>
      </div>
      <button
        onClick={onAdd}
        className="border border-neutral-700 bg-transparent px-5 py-2.5 text-[11px] font-medium uppercase tracking-widest text-neutral-200 transition-colors hover:border-neutral-500"
      >
        Add your first expense
      </button>
    </div>
  );
}

// =============================================================================
//  Add / Edit modal
// =============================================================================
function ExpenseFormModal({
  modal,
  categories,
  methods,
  onClose,
  onSaved,
}: {
  modal: { mode: 'create' } | { mode: 'edit'; expense: Expense };
  categories: ExpenseCategory[];
  methods: PaymentMethod[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = modal.mode === 'edit' ? modal.expense : null;
  const navigate = useNavigate();
  // Close the modal and jump to the expense settings page (e.g. when the user
  // picks "+ Add new category" from inside a dropdown).
  function goToSettings() {
    onClose();
    navigate(ROUTES.settingsExpenses);
  }

  const [name, setName] = useState(editing?.name ?? '');
  const [amountDollars, setAmountDollars] = useState(
    editing != null ? (editing.amount_cents / 100).toString() : '',
  );
  const [incurredOn, setIncurredOn] = useState(
    editing?.incurred_on ?? new Date().toISOString().slice(0, 10),
  );
  const [categoryId, setCategoryId] = useState<string>(editing?.category_id ?? '');
  const [methodId, setMethodId] = useState<string>(editing?.payment_method_id ?? '');
  const [note, setNote] = useState(editing?.note ?? '');
  const [isRecurring, setIsRecurring] = useState(editing?.is_recurring ?? false);
  const [recurrenceKind, setRecurrenceKind] = useState<RecurrenceKind>(
    editing?.recurrence_kind ?? 'monthly',
  );

  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    if (!name.trim()) {
      toast.error('Name is required.');
      return;
    }
    const cents = parseDollarsToCents(amountDollars);
    if (cents == null || cents <= 0) {
      toast.error('Amount must be greater than zero.');
      return;
    }
    if (!incurredOn) {
      toast.error('Date is required.');
      return;
    }
    setSubmitting(true);
    try {
      const recurrenceFields = isRecurring
        ? { is_recurring: true,  recurrence_kind: recurrenceKind }
        : { is_recurring: false, recurrence_kind: null as RecurrenceKind | null,
            next_due_on: null as string | null };

      if (modal.mode === 'create') {
        await createExpense({
          name,
          amount_cents: cents,
          incurred_on: incurredOn,
          category_id: categoryId || null,
          payment_method_id: methodId || null,
          note: note.trim() || null,
          ...recurrenceFields,
        });
        toast.success('Expense added.');
      } else {
        await updateExpense(editing!.id, {
          name: name.trim(),
          amount_cents: cents,
          incurred_on: incurredOn,
          category_id: categoryId || null,
          payment_method_id: methodId || null,
          note: note.trim() || null,
          ...recurrenceFields,
        });
        toast.success('Expense updated.');
      }
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    if (modal.mode !== 'edit' || deleting) return;
    const ok = await confirm({
      title: `Delete "${modal.expense.name}"?`,
      destructive: true,
      confirmLabel: 'Delete expense',
    });
    if (!ok) return;
    setDeleting(true);
    try {
      await softDeleteExpense(modal.expense.id);
      toast.success('Expense removed.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete.');
    } finally {
      setDeleting(false);
    }
  }

  // Option lists with "no selection" sentinel for nullable fields.
  const categoryOptions = [
    { value: '', label: '— None —' },
    ...categories.map((c) => ({ value: c.id, label: c.name })),
  ];
  const methodOptions = [
    { value: '', label: '— None —' },
    ...methods.map((m) => ({ value: m.id, label: m.name })),
  ];

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow={modal.mode === 'create' ? 'Add expense' : 'Edit expense'}
      title={modal.mode === 'create' ? 'New expense' : modal.expense.name}
    >
      <form onSubmit={handleSave} noValidate>
        <Field
          id="name"
          label="Name"
          type="text"
          required
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Office rent"
        />

        <Field
          id="amount"
          label="Amount"
          type="text"
          inputMode="decimal"
          required
          value={amountDollars}
          onChange={(e) => setAmountDollars(e.target.value)}
          placeholder="e.g. 199.99"
          hint="Dollars."
        />

        <div className="mb-5">
          <Label htmlFor="incurred-on">Date</Label>
          <DatePicker id="incurred-on" value={incurredOn} onChange={setIncurredOn} />
        </div>

        <div className="mb-5">
          <Label htmlFor="category">Category</Label>
          {categories.length === 0 ? (
            <AddYourOwnLink onClose={onClose} kind="category" />
          ) : (
            <Select
              id="category"
              value={categoryId}
              onChange={setCategoryId}
              options={categoryOptions}
              footer={{ label: 'Add new category', onSelect: goToSettings }}
            />
          )}
        </div>

        <div className="mb-5">
          <Label htmlFor="method">Payment method</Label>
          {methods.length === 0 ? (
            <AddYourOwnLink onClose={onClose} kind="method" />
          ) : (
            <Select
              id="method"
              value={methodId}
              onChange={setMethodId}
              options={methodOptions}
              footer={{ label: 'Add new payment method', onSelect: goToSettings }}
            />
          )}
        </div>

        <div className="mb-5">
          <Label htmlFor="note">Note (optional)</Label>
          <textarea
            id="note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder="e.g. December rent for studio."
            className="block w-full border border-neutral-800 bg-neutral-950 px-3.5 py-3 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
          />
        </div>

        <label className="mb-3 flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={isRecurring}
            onChange={(e) => setIsRecurring(e.target.checked)}
            className="mt-0.5 h-4 w-4 border-neutral-700 bg-neutral-950 accent-neutral-50"
          />
          <span>
            <span className="block text-sm text-neutral-100">Recurring expense</span>
            <span className="mt-0.5 block text-xs text-neutral-500">
              When due, you'll get a "log it" prompt at the top of this page.
            </span>
          </span>
        </label>

        {isRecurring && (
          <div className="mb-5">
            <Label htmlFor="recurrence">Repeats every</Label>
            <Select
              id="recurrence"
              value={recurrenceKind}
              onChange={(v) => setRecurrenceKind(v as RecurrenceKind)}
              options={[
                { value: 'weekly',   label: 'Week',  detail: '7 days'   },
                { value: 'biweekly', label: '2 Weeks', detail: '14 days' },
                { value: 'monthly',  label: 'Month', detail: 'same day next month' },
                { value: 'yearly',   label: 'Year',  detail: 'same day next year'  },
              ]}
            />
          </div>
        )}

        <div className="mt-8 flex flex-col gap-3">
          <Button type="submit" loading={submitting}>
            {modal.mode === 'create' ? 'Add expense' : 'Save changes'}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>

        {modal.mode === 'edit' && (
          <div className="mt-6 border-t border-neutral-900 pt-5 text-right">
            <TextLink onClick={handleDelete}>
              {deleting ? 'Deleting…' : 'Delete expense'}
            </TextLink>
          </div>
        )}
      </form>
    </Modal>
  );
}

// =============================================================================
//  AddYourOwnLink — placeholder shown in place of an empty Select. Routes
//  the user to Settings with a single tap.
// =============================================================================
function AddYourOwnLink({
  kind,
  onClose,
}: {
  kind: 'category' | 'method';
  onClose: () => void;
}) {
  const label = kind === 'category' ? 'categories' : 'payment methods';
  return (
    <Link
      to={ROUTES.settingsExpenses}
      onClick={onClose}
      className="group flex w-full items-center justify-between border border-dashed border-neutral-700 bg-neutral-950 px-3.5 py-3 text-sm text-neutral-400 transition-colors hover:border-neutral-500 hover:text-neutral-100"
    >
      <span>Add your own {label}</span>
      <span className="text-[10px] uppercase tracking-widest text-neutral-600 transition-colors group-hover:text-neutral-300">
        Settings →
      </span>
    </Link>
  );
}

// =============================================================================
//  GearIcon — duplicated from Employees.tsx for now (small enough to inline)
// =============================================================================
function GearIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
