// =============================================================================
//  Onboarding.tsx
//  First-run wizard. Shown to the owner of a fresh agency exactly once
//  (gated by agency.onboarding_completed_at).
//
//  Three steps:
//    1. Welcome      — orientation to what each universal page does.
//    2. Departments  — REQUIRED. Owner defines their own departments, each
//                      tagged as Models or Marketing, each with one or more
//                      roles + a pay structure. These become sidebar tabs.
//    3. Invites      — optional. Generate join links to share with teammates.
// =============================================================================

import { useEffect, useMemo, useState } from 'react';
import type { Agency } from '../lib/agency';
import { completeOnboarding } from '../lib/agency';
import {
  type AgencyRole,
  buildInviteUrl,
  createInvite,
} from '../lib/invites';
import {
  type Department,
  type DepartmentLayout,
  createDepartment,
  listDepartments,
} from '../lib/departments';
import {
  type StaffRole,
  type PayStructure,
  createStaffRole,
  listStaffRoles,
} from '../lib/staffRoles';
import { Select } from '../components/Select';
import { toast } from '../lib/toast';

type Step = 'welcome' | 'departments' | 'invites';

export function Onboarding({
  agency,
  onComplete,
}: {
  agency: Agency;
  onComplete: () => void;
}) {
  const [step, setStep] = useState<Step>('welcome');
  const [finishing, setFinishing] = useState(false);

  async function finish() {
    if (finishing) return;
    setFinishing(true);
    try {
      await completeOnboarding(agency.id);
      onComplete();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not finish setup.');
      setFinishing(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-neutral-950 text-neutral-100">
      <header className="flex items-center justify-between px-8 py-8">
        <div className="font-serif text-2xl font-bold tracking-tight">VoltrisAi</div>
        <StepIndicator step={step} />
      </header>

      <main className="flex flex-1 items-start justify-center px-6 py-6">
        <div key={step} className="w-full max-w-3xl animate-fade-in-up">
          {step === 'welcome' && (
            <WelcomeStep
              agency={agency}
              onNext={() => setStep('departments')}
            />
          )}
          {step === 'departments' && (
            <DepartmentsStep
              onBack={() => setStep('welcome')}
              onDone={() => setStep('invites')}
            />
          )}
          {step === 'invites' && (
            <InvitesStep
              agency={agency}
              onBack={() => setStep('departments')}
              onFinish={() => void finish()}
              finishing={finishing}
            />
          )}
        </div>
      </main>

      <footer className="px-8 py-6 text-[11px] uppercase tracking-widest text-neutral-700">
        Setup &middot; {agency.name}
      </footer>
    </div>
  );
}

// -----------------------------------------------------------------------------

function StepIndicator({ step }: { step: Step }) {
  const order: Step[] = ['welcome', 'departments', 'invites'];
  const i = order.indexOf(step);
  return (
    <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-neutral-500">
      {order.map((s, idx) => (
        <span
          key={s}
          className={
            idx === i
              ? 'border border-neutral-50 bg-neutral-50 px-2 py-0.5 text-neutral-950'
              : idx < i
                ? 'border border-neutral-700 px-2 py-0.5 text-neutral-400'
                : 'border border-neutral-800 px-2 py-0.5 text-neutral-600'
          }
        >
          {idx + 1}
        </span>
      ))}
      <span>{order.length} total</span>
    </div>
  );
}

// -----------------------------------------------------------------------------

function WelcomeStep({
  agency,
  onNext,
}: {
  agency: Agency;
  onNext: () => void;
}) {
  return (
    <div>
      <div className="mb-6 text-[11px] font-medium uppercase tracking-editorial text-neutral-500">
        Welcome
      </div>
      <h1 className="font-serif text-5xl font-semibold leading-tight tracking-tight text-neutral-50">
        {agency.name} is live.
      </h1>
      <p className="mt-4 max-w-xl text-sm leading-relaxed text-neutral-400">
        A quick orientation, then you&rsquo;ll be on the dashboard. You can
        change anything later in Settings.
      </p>

      <div className="mt-10 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {TOUR.map((t) => (
          <div key={t.label} className="border border-neutral-800 bg-neutral-950 p-5">
            <div className="text-[10px] uppercase tracking-widest text-neutral-600">
              {t.label}
            </div>
            <div className="mt-1 font-serif text-lg font-medium tracking-tight text-neutral-100">
              {t.title}
            </div>
            <div className="mt-1 text-xs leading-relaxed text-neutral-500">
              {t.hint}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-10 flex justify-end">
        <button
          onClick={onNext}
          className="border border-neutral-50 bg-neutral-50 px-6 py-3 text-[11px] font-medium uppercase tracking-widest text-neutral-950 transition-colors hover:bg-neutral-200"
        >
          Continue
        </button>
      </div>
    </div>
  );
}

const TOUR: { label: string; title: string; hint: string }[] = [
  { label: 'Tab 1', title: 'Departments', hint: 'Your own — Models for sales/withdrawals, Marketing for accounts/income.' },
  { label: 'Tab 2', title: 'Tracking',    hint: 'Import Infloww CSVs to see daily growth per link.' },
  { label: 'Tab 3', title: 'Expenses',    hint: 'Recurring or one-off costs by category and method.' },
  { label: 'Tab 4', title: 'Employees',   hint: 'Your team, their roles, and how they get paid.' },
  { label: 'Tab 5', title: 'Dashboard',   hint: 'Totals, top performers, and what is owed.' },
  { label: 'Tab 6', title: 'Settings',    hint: 'Invite teammates, change theme, manage anything else.' },
];

// -----------------------------------------------------------------------------
//  FirstEmployeeStep — REQUIRED. The owner must add at least one employee
//  before they can continue to invites / finish. The form is intentionally
//  minimal: name, department, position, pay. Start/end dates and other
//  niceties live on the full Employees page.
// -----------------------------------------------------------------------------

// In-memory draft of one role inside a department, before any DB writes.
type DraftRole = {
  name: string;
  pay_structure: PayStructure;
};

type DraftDepartment = {
  name: string;
  layout_type: DepartmentLayout;
  roles: DraftRole[];
};

const PAY_LABELS: Record<PayStructure, string> = {
  flat:       'Wage',        // shown to user
  commission: 'Commission',
  share:      'Share',
};

const PAY_HINTS: Record<PayStructure, string> = {
  flat:       '$X every Y days',
  commission: '% of chatter sales',
  share:      '% of model withdrawals',
};

function emptyDepartment(): DraftDepartment {
  return {
    name: '',
    layout_type: 'models',
    roles: [{ name: '', pay_structure: 'flat' }],
  };
}

function DepartmentsStep({
  onBack,
  onDone,
}: {
  onBack: () => void;
  onDone: () => void;
}) {
  // If the agency already has departments (e.g. user came back to onboarding
  // after a prior partial setup, or it was seeded before migration 0018),
  // skip the step entirely to avoid double-creation.
  const [skipping, setSkipping] = useState(true);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const existing = await listDepartments();
        if (cancelled) return;
        if (existing.length > 0) {
          // Already has departments — bypass this step.
          onDone();
          return;
        }
      } catch {
        /* swallow — let them set up manually */
      }
      if (!cancelled) setSkipping(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [drafts, setDrafts] = useState<DraftDepartment[]>([emptyDepartment()]);
  const [submitting, setSubmitting] = useState(false);

  function updateDept(i: number, patch: Partial<DraftDepartment>) {
    setDrafts((ds) => ds.map((d, idx) => (idx === i ? { ...d, ...patch } : d)));
  }
  function addDept() {
    setDrafts((ds) => [...ds, emptyDepartment()]);
  }
  function removeDept(i: number) {
    setDrafts((ds) => ds.filter((_, idx) => idx !== i));
  }
  function updateRole(deptI: number, roleI: number, patch: Partial<DraftRole>) {
    setDrafts((ds) =>
      ds.map((d, i) =>
        i === deptI
          ? { ...d, roles: d.roles.map((r, j) => (j === roleI ? { ...r, ...patch } : r)) }
          : d,
      ),
    );
  }
  function addRole(deptI: number) {
    setDrafts((ds) =>
      ds.map((d, i) =>
        i === deptI ? { ...d, roles: [...d.roles, { name: '', pay_structure: 'flat' }] } : d,
      ),
    );
  }
  function removeRole(deptI: number, roleI: number) {
    setDrafts((ds) =>
      ds.map((d, i) =>
        i === deptI ? { ...d, roles: d.roles.filter((_, j) => j !== roleI) } : d,
      ),
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;

    // Validate every department + role.
    for (let i = 0; i < drafts.length; i++) {
      const d = drafts[i]!;
      if (!d.name.trim()) {
        toast.error(`Department ${i + 1} needs a name.`);
        return;
      }
      if (d.roles.length === 0) {
        toast.error(`Add at least one role to "${d.name.trim()}".`);
        return;
      }
      for (let j = 0; j < d.roles.length; j++) {
        if (!d.roles[j]!.name.trim()) {
          toast.error(`Role ${j + 1} in "${d.name.trim()}" needs a name.`);
          return;
        }
      }
    }

    setSubmitting(true);
    try {
      for (const d of drafts) {
        const created = await createDepartment(d.name.trim(), d.layout_type);
        for (const r of d.roles) {
          await createStaffRole({
            department_id: created.id,
            name: r.name.trim(),
            pay_structure: r.pay_structure,
          });
        }
      }
      toast.success('Departments created.');
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save departments.');
    } finally {
      setSubmitting(false);
    }
  }

  if (skipping) {
    return <div className="text-sm text-neutral-500">Loading…</div>;
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <div className="mb-6 text-[11px] font-medium uppercase tracking-editorial text-neutral-500">
        Departments
      </div>
      <h1 className="font-serif text-4xl font-semibold leading-tight tracking-tight text-neutral-50">
        Set up your tabs.
      </h1>
      <p className="mt-4 max-w-xl text-sm leading-relaxed text-neutral-400">
        Each department becomes a tab in your sidebar. Pick&nbsp;
        <strong className="text-neutral-300">Models</strong> for chatter sales +
        model withdrawals, or <strong className="text-neutral-300">Marketing</strong>{' '}
        for accounts + monthly income. Add as many of each as you need.
      </p>

      <div className="mt-8 flex flex-col gap-4">
        {drafts.map((d, i) => (
          <DepartmentCard
            key={i}
            index={i}
            draft={d}
            canRemove={drafts.length > 1}
            onUpdate={(patch) => updateDept(i, patch)}
            onRemove={() => removeDept(i)}
            onAddRole={() => addRole(i)}
            onUpdateRole={(j, patch) => updateRole(i, j, patch)}
            onRemoveRole={(j) => removeRole(i, j)}
          />
        ))}
        <button
          type="button"
          onClick={addDept}
          className="self-start border border-dashed border-neutral-800 px-4 py-2 text-[11px] uppercase tracking-widest text-neutral-400 transition-colors hover:border-neutral-500 hover:text-neutral-100"
        >
          + Add department
        </button>
      </div>

      <div className="mt-10 flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="text-[10px] uppercase tracking-widest text-neutral-500 transition-colors hover:text-neutral-200"
        >
          &larr; Back
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="border border-neutral-50 bg-neutral-50 px-6 py-3 text-[11px] font-medium uppercase tracking-widest text-neutral-950 transition-colors hover:bg-neutral-200 disabled:opacity-50"
        >
          {submitting ? 'Saving…' : 'Continue'}
        </button>
      </div>
    </form>
  );
}

// -----------------------------------------------------------------------------

function DepartmentCard({
  index,
  draft,
  canRemove,
  onUpdate,
  onRemove,
  onAddRole,
  onUpdateRole,
  onRemoveRole,
}: {
  index: number;
  draft: DraftDepartment;
  canRemove: boolean;
  onUpdate: (patch: Partial<DraftDepartment>) => void;
  onRemove: () => void;
  onAddRole: () => void;
  onUpdateRole: (j: number, patch: Partial<DraftRole>) => void;
  onRemoveRole: (j: number) => void;
}) {
  return (
    <div className="border border-neutral-800 bg-neutral-950 p-5">
      <div className="mb-4 flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-widest text-neutral-600">
          Department {index + 1}
        </div>
        {canRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="text-[10px] uppercase tracking-widest text-neutral-500 transition-colors hover:text-neutral-300"
          >
            Remove
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <div>
          <div className="mb-2 text-[10px] uppercase tracking-widest text-neutral-500">
            Name
          </div>
          <input
            type="text"
            value={draft.name}
            onChange={(e) => onUpdate({ name: e.target.value })}
            placeholder="e.g. OF Premium"
            className="block w-full border border-neutral-800 bg-transparent px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
          />
        </div>
        <div>
          <div className="mb-2 text-[10px] uppercase tracking-widest text-neutral-500">
            Type
          </div>
          <div className="flex gap-2">
            {(['models', 'marketing'] as DepartmentLayout[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => onUpdate({ layout_type: t })}
                className={
                  'flex-1 border px-3 py-2 text-[11px] uppercase tracking-widest transition-colors ' +
                  (draft.layout_type === t
                    ? 'border-neutral-50 bg-neutral-50 text-neutral-950'
                    : 'border-neutral-800 bg-transparent text-neutral-300 hover:border-neutral-500')
                }
              >
                {t}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[10px] uppercase tracking-widest text-neutral-700">
            {draft.layout_type === 'models'
              ? 'Chatter sales + model withdrawals'
              : 'Accounts + monthly income'}
          </p>
        </div>
      </div>

      <div className="mt-5">
        <div className="mb-2 text-[10px] uppercase tracking-widest text-neutral-500">
          Roles
        </div>
        <div className="flex flex-col gap-2">
          {draft.roles.map((r, j) => (
            <div
              key={j}
              className="flex flex-col gap-2 border border-neutral-800 bg-neutral-950 p-2 md:flex-row md:items-center"
            >
              <input
                type="text"
                value={r.name}
                onChange={(e) => onUpdateRole(j, { name: e.target.value })}
                placeholder={
                  draft.layout_type === 'models' ? 'e.g. Chatter' : 'e.g. Reddit VA'
                }
                className="flex-1 border border-neutral-800 bg-transparent px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
              />
              <div className="flex flex-wrap gap-1">
                {(['flat', 'commission', 'share'] as PayStructure[]).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => onUpdateRole(j, { pay_structure: p })}
                    title={PAY_HINTS[p]}
                    className={
                      'border px-2.5 py-1.5 text-[10px] uppercase tracking-widest transition-colors ' +
                      (r.pay_structure === p
                        ? 'border-neutral-50 bg-neutral-50 text-neutral-950'
                        : 'border-neutral-800 bg-transparent text-neutral-300 hover:border-neutral-500')
                    }
                  >
                    {PAY_LABELS[p]}
                  </button>
                ))}
              </div>
              {draft.roles.length > 1 && (
                <button
                  type="button"
                  onClick={() => onRemoveRole(j)}
                  aria-label="Remove role"
                  className="border border-neutral-800 px-2 py-1.5 text-[11px] text-neutral-500 transition-colors hover:border-neutral-600 hover:text-neutral-300"
                >
                  &times;
                </button>
              )}
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={onAddRole}
          className="mt-2 text-[10px] uppercase tracking-widest text-neutral-500 transition-colors hover:text-neutral-200"
        >
          + Add role
        </button>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------

type DraftInvite = {
  email: string;
  role: AgencyRole;
  staffRoleId: string;
};

function InvitesStep({
  agency,
  onBack,
  onFinish,
  finishing,
}: {
  agency: Agency;
  onBack: () => void;
  onFinish: () => void;
  finishing: boolean;
}) {
  const [drafts, setDrafts] = useState<DraftInvite[]>([
    { email: '', role: 'staff', staffRoleId: '' },
  ]);
  const [sending, setSending] = useState(false);
  const [createdLinks, setCreatedLinks] = useState<{ email: string; url: string }[]>([]);

  // Load positions so users can pick one per row.
  const [departments, setDepartments] = useState<Department[]>([]);
  const [staffRoles, setStaffRoles] = useState<StaffRole[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [d, r] = await Promise.all([listDepartments(), listStaffRoles()]);
        if (cancelled) return;
        setDepartments(d);
        setStaffRoles(r);
      } catch (err) {
        if (!cancelled) {
          toast.error(err instanceof Error ? err.message : 'Could not load positions.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const positionOptions = useMemo(() => {
    const byDept = new Map<string, StaffRole[]>();
    for (const r of staffRoles) {
      const arr = byDept.get(r.department_id) ?? [];
      arr.push(r);
      byDept.set(r.department_id, arr);
    }
    const opts: { value: string; label: string; detail?: string }[] = [];
    for (const d of departments) {
      const rs = (byDept.get(d.id) ?? []).slice().sort((a, b) => a.sort_order - b.sort_order);
      for (const r of rs) {
        opts.push({ value: r.id, label: r.name, detail: d.name });
      }
    }
    return opts;
  }, [departments, staffRoles]);

  function updateDraft(i: number, patch: Partial<DraftInvite>) {
    setDrafts((ds) => ds.map((d, idx) => (idx === i ? { ...d, ...patch } : d)));
  }

  function addRow() {
    setDrafts((ds) => [...ds, { email: '', role: 'staff', staffRoleId: '' }]);
  }

  function removeRow(i: number) {
    setDrafts((ds) => ds.filter((_, idx) => idx !== i));
  }

  async function sendAll() {
    const validDrafts = drafts
      .map((d) => ({ ...d, email: d.email.trim().toLowerCase() }))
      .filter((d) => d.email.length > 0);

    if (validDrafts.length === 0) {
      // Nothing to send — just continue.
      onFinish();
      return;
    }

    // Validate before any RPC calls.
    const missingPosition = validDrafts.find(
      (d) => d.role === 'staff' && !d.staffRoleId,
    );
    if (missingPosition) {
      toast.error(`Pick a position for ${missingPosition.email}.`);
      return;
    }

    setSending(true);
    try {
      const created: { email: string; url: string }[] = [];
      for (const d of validDrafts) {
        const inv = await createInvite(
          agency.id,
          d.email,
          d.role,
          d.role === 'staff' ? d.staffRoleId : null,
        );
        created.push({ email: d.email, url: buildInviteUrl(inv.token) });
      }
      setCreatedLinks(created);
      toast.success(`${created.length} invite${created.length === 1 ? '' : 's'} created.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create invites.');
    } finally {
      setSending(false);
    }
  }

  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Link copied.');
    } catch {
      toast.error('Could not copy. Select the link and copy manually.');
    }
  }

  // After creation, switch to the "share these" view.
  if (createdLinks.length > 0) {
    return (
      <div>
        <div className="mb-6 text-[11px] font-medium uppercase tracking-editorial text-neutral-500">
          Invites ready
        </div>
        <h1 className="font-serif text-4xl font-semibold leading-tight tracking-tight text-neutral-50">
          Share these links.
        </h1>
        <p className="mt-4 max-w-xl text-sm leading-relaxed text-neutral-400">
          Each link is valid for 7 days and works once. You can resend or
          cancel any of them from Settings &rarr; Team &amp; invites.
        </p>

        <div className="mt-8 divide-y divide-neutral-900 border border-neutral-900">
          {createdLinks.map((l) => (
            <div key={l.email} className="flex flex-col gap-2 bg-neutral-950 p-4 md:flex-row md:items-center md:justify-between">
              <div className="min-w-0">
                <div className="truncate font-serif text-base text-neutral-100">
                  {l.email}
                </div>
                <div className="mt-1 truncate font-mono text-xs text-neutral-600">
                  {l.url}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void copyLink(l.url)}
                className="border border-neutral-800 px-3 py-1.5 text-[10px] uppercase tracking-widest text-neutral-300 transition-colors hover:border-neutral-500 hover:text-neutral-100"
              >
                Copy
              </button>
            </div>
          ))}
        </div>

        <div className="mt-10 flex justify-end">
          <button
            onClick={onFinish}
            disabled={finishing}
            className="border border-neutral-50 bg-neutral-50 px-6 py-3 text-[11px] font-medium uppercase tracking-widest text-neutral-950 transition-colors hover:bg-neutral-200 disabled:opacity-50"
          >
            {finishing ? 'Finishing…' : 'Go to dashboard'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 text-[11px] font-medium uppercase tracking-editorial text-neutral-500">
        Invite teammates
      </div>
      <h1 className="font-serif text-4xl font-semibold leading-tight tracking-tight text-neutral-50">
        Bring your team in.
      </h1>
      <p className="mt-4 max-w-xl text-sm leading-relaxed text-neutral-400">
        Optional. Add emails, choose a role, and we&rsquo;ll generate a link
        for each one. You can also do this later in Settings.
      </p>

      <div className="mt-8 flex flex-col gap-2">
        {drafts.map((d, i) => (
          <div key={i} className="flex flex-col gap-2 border border-neutral-800 bg-neutral-950 p-3">
            <div className="flex flex-col gap-2 md:flex-row md:items-center">
              <input
                type="email"
                value={d.email}
                onChange={(e) => updateDraft(i, { email: e.target.value })}
                placeholder="teammate@example.com"
                className="flex-1 border border-neutral-800 bg-transparent px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
              />
              <div className="flex gap-2">
                {(['staff', 'admin'] as AgencyRole[]).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() =>
                      updateDraft(i, { role: r, ...(r === 'admin' ? { staffRoleId: '' } : {}) })
                    }
                    className={
                      'border px-3 py-2 text-[11px] uppercase tracking-widest transition-colors ' +
                      (d.role === r
                        ? 'border-neutral-50 bg-neutral-50 text-neutral-950'
                        : 'border-neutral-800 bg-transparent text-neutral-300 hover:border-neutral-500')
                    }
                  >
                    {r}
                  </button>
                ))}
                {drafts.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeRow(i)}
                    className="border border-neutral-800 px-2 py-2 text-[11px] uppercase tracking-widest text-neutral-500 transition-colors hover:border-neutral-600 hover:text-neutral-300"
                    aria-label="Remove"
                  >
                    &times;
                  </button>
                )}
              </div>
            </div>
            {d.role === 'staff' && (
              <div className="flex flex-col gap-2 md:flex-row md:items-center">
                <span className="text-[10px] uppercase tracking-widest text-neutral-500 md:w-20">
                  Position
                </span>
                <div className="flex-1">
                  <Select
                    value={d.staffRoleId}
                    onChange={(v) => updateDraft(i, { staffRoleId: v })}
                    options={positionOptions}
                    placeholder={positionOptions.length === 0 ? 'No positions yet' : 'Pick a position'}
                    disabled={positionOptions.length === 0}
                  />
                </div>
              </div>
            )}
          </div>
        ))}
        <button
          type="button"
          onClick={addRow}
          className="self-start text-[10px] uppercase tracking-widest text-neutral-500 transition-colors hover:text-neutral-200"
        >
          + Add another
        </button>
      </div>

      <div className="mt-10 flex items-center justify-between">
        <button
          onClick={onBack}
          className="text-[10px] uppercase tracking-widest text-neutral-500 transition-colors hover:text-neutral-200"
        >
          &larr; Back
        </button>
        <div className="flex items-center gap-3">
          <button
            onClick={onFinish}
            disabled={sending || finishing}
            className="text-[11px] uppercase tracking-widest text-neutral-500 transition-colors hover:text-neutral-200 disabled:opacity-50"
          >
            Skip for now
          </button>
          <button
            onClick={() => void sendAll()}
            disabled={sending || finishing}
            className="border border-neutral-50 bg-neutral-50 px-6 py-3 text-[11px] font-medium uppercase tracking-widest text-neutral-950 transition-colors hover:bg-neutral-200 disabled:opacity-50"
          >
            {sending ? 'Creating…' : 'Create invites'}
          </button>
        </div>
      </div>
    </div>
  );
}
