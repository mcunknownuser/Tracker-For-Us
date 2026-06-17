// =============================================================================
//  Employees.tsx
//  Unified team page powered by user-editable departments and roles.
//
//    * Loads departments, roles, and team members on mount
//    * Groups team members by department, then by role within each
//    * Add / edit form picks department + role from the agency's own taxonomy
//    * Pay fields swap based on the chosen role's pay_structure
// =============================================================================

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { Modal } from '../components/Modal';
import { Button, Field, Label, TextLink } from '../components/FormControls';
import { Select } from '../components/Select';
import { DatePicker } from '../components/DatePicker';
import { ROUTES } from '../lib/routes';
import { type Department, listDepartments } from '../lib/departments';
import {
  type PayStructure,
  type StaffRole,
  listStaffRoles,
  payStructureLabel,
} from '../lib/staffRoles';
import {
  type TeamMember,
  type CreateTeamMemberInput,
  type UpdateTeamMemberInput,
  listTeamMembers,
  createTeamMember,
  updateTeamMember,
  softDeleteTeamMember,
  formatPayLine,
  isFormer,
} from '../lib/teamMembers';
import { parseDollarsToCents, parsePercentToRate } from '../lib/money';
import { toast } from '../lib/toast';
import { confirm } from '../lib/confirm';
import { getActiveAgencyId, getMyAgencyRole } from '../lib/agency';
import { InvitePanel } from '../components/InvitePanel';
import {
  type UnlinkedMember,
  listUnlinkedMembers,
} from '../lib/invites';

// =============================================================================
//  Page
// =============================================================================
export function Employees() {
  const [departments, setDepartments] = useState<Department[] | null>(null);
  const [roles, setRoles] = useState<StaffRole[] | null>(null);
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [invitesOpen, setInvitesOpen] = useState(false);
  // Track the caller's role so we hide the "Invite teammates" button from
  // staff users (RLS would block them anyway, but the button shouldn't tease).
  const [myRole, setMyRole] = useState<'owner' | 'admin' | 'staff' | null>(null);
  // People who accepted an invite but don't have a team_member row yet.
  // Admins see them and can click "Add as employee" to create one
  // pre-filled with the position they were invited as.
  const [pending, setPending] = useState<UnlinkedMember[]>([]);
  const agencyId = getActiveAgencyId();

  async function reloadPending() {
    if (!agencyId) return;
    try {
      setPending(await listUnlinkedMembers(agencyId));
    } catch {
      /* non-fatal — section just stays empty */
    }
  }

  async function reload() {
    try {
      const [d, r, m] = await Promise.all([
        listDepartments(),
        listStaffRoles(),
        listTeamMembers(),
      ]);
      setDepartments(d);
      setRoles(r);
      setMembers(m);
    } catch (e) {
      setError(e as Error);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  useEffect(() => {
    if (!agencyId) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await getMyAgencyRole(agencyId);
        if (cancelled) return;
        setMyRole(r);
        if (r === 'owner' || r === 'admin') {
          await reloadPending();
        }
      } catch {
        /* leave myRole null; button stays hidden */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agencyId]);

  const canInvite = myRole === 'owner' || myRole === 'admin';

  const loading = departments === null || roles === null || members === null;
  const total = members?.length ?? 0;

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        eyebrow="Team"
        title="Employees."
        subtitle="Manage departments and roles with the gear icon."
        actions={
          <>
            {canInvite && (
              <button
                onClick={() => setInvitesOpen(true)}
                className="border border-neutral-700 bg-transparent px-5 py-3 text-[11px] font-medium uppercase tracking-widest text-neutral-200 transition-colors hover:border-neutral-500"
              >
                Invite teammates
              </button>
            )}
            <button
              onClick={() => setModal({ mode: 'create' })}
              disabled={loading || (departments?.length ?? 0) === 0}
              className="bg-neutral-50 px-5 py-3 text-[11px] font-medium uppercase tracking-widest text-neutral-950 transition-colors hover:bg-neutral-300 disabled:opacity-40"
            >
              Add employee
            </button>
            <Link
              to={ROUTES.settings}
              title="Manage departments and roles"
              aria-label="Settings"
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

      {canInvite && pending.length > 0 && (
        <PendingMembers
          pending={pending}
          onAdd={(p) =>
            setModal({
              mode: 'create',
              prefill: {
                email: p.email,
                user_id: p.user_id,
                department_id: p.suggested_dept_id ?? undefined,
                role_id: p.suggested_role_id ?? undefined,
              },
            })
          }
        />
      )}

      {loading ? (
        <LoadingState />
      ) : total === 0 ? (
        <EmptyState onAdd={() => setModal({ mode: 'create' })} />
      ) : (
        <ActiveAndFormer
          departments={departments!}
          roles={roles!}
          members={members!}
          onEdit={(m) => setModal({ mode: 'edit', member: m })}
        />
      )}

      {modal && departments && roles && (
        <TeamFormModal
          modal={modal}
          departments={departments}
          roles={roles}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            void reload();
            void reloadPending();
          }}
        />
      )}

      {invitesOpen && agencyId && (
        <Modal
          open
          onClose={() => setInvitesOpen(false)}
          eyebrow="Team"
          title="Invite teammates"
          maxWidth="max-w-2xl"
        >
          <p className="mb-5 text-xs text-neutral-500">
            Generate a link to share. Links expire in 7 days and stop working
            after one use.
          </p>
          <InvitePanel agencyId={agencyId} />
        </Modal>
      )}
    </div>
  );
}

// =============================================================================
//  Grouped list
// =============================================================================
function DepartmentList({
  departments,
  roles,
  members,
  onEdit,
}: {
  departments: Department[];
  roles: StaffRole[];
  members: TeamMember[];
  onEdit: (m: TeamMember) => void;
}) {
  // Build a map for quick role lookup.
  const roleMap = useMemo(() => new Map(roles.map((r) => [r.id, r])), [roles]);

  return (
    <div className="space-y-16">
      {departments.map((d) => {
        const inDept = members.filter((m) => m.department_id === d.id);
        if (inDept.length === 0) return null;

        // Group members in this department by role.
        const deptRoles = roles
          .filter((r) => r.department_id === d.id)
          .sort((a, b) => a.sort_order - b.sort_order);

        // Members with a known role come first (grouped), then "Unassigned".
        const groups: { label: string; members: TeamMember[] }[] = [];
        for (const r of deptRoles) {
          const ms = inDept.filter((m) => m.role_id === r.id);
          if (ms.length > 0) groups.push({ label: r.name, members: ms });
        }
        const unassigned = inDept.filter(
          (m) => !m.role_id || !roleMap.has(m.role_id),
        );
        if (unassigned.length > 0) groups.push({ label: 'Unassigned', members: unassigned });

        return (
          <section key={d.id}>
            <div className="mb-8 flex items-baseline gap-3 border-b border-neutral-800 pb-4">
              <h2 className="font-serif text-3xl font-semibold tracking-tight text-neutral-50">
                {d.name}
              </h2>
              <span className="text-[11px] font-medium uppercase tracking-editorial text-neutral-500">
                {inDept.length}
              </span>
            </div>

            <div className="space-y-10">
              {groups.map((g) => (
                <div key={g.label}>
                  <div className="mb-4 flex items-baseline gap-3">
                    <h3 className="font-serif text-xl font-medium tracking-tight text-neutral-200">
                      {g.label}
                    </h3>
                    <span className="text-[10px] font-medium uppercase tracking-editorial text-neutral-600">
                      {g.members.length}
                    </span>
                  </div>
                  <CardGrid>
                    {g.members.map((m) => (
                      <TeamCard
                        key={m.id}
                        member={m}
                        roleName={
                          m.role_id ? roleMap.get(m.role_id)?.name : m.role_label
                        }
                        onClick={() => onEdit(m)}
                      />
                    ))}
                  </CardGrid>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

// =============================================================================
//  ActiveAndFormer — splits the team into currently-employed and former
//  members. Active members render in the normal department/role grouping.
//  Former members live in a collapsed section at the bottom.
// =============================================================================
function ActiveAndFormer({
  departments,
  roles,
  members,
  onEdit,
}: {
  departments: Department[];
  roles: StaffRole[];
  members: TeamMember[];
  onEdit: (m: TeamMember) => void;
}) {
  const active = members.filter((m) => !isFormer(m));
  const former = members.filter((m) => isFormer(m));
  const [showFormer, setShowFormer] = useState(false);

  return (
    <>
      {active.length > 0 && (
        <DepartmentList
          departments={departments}
          roles={roles}
          members={active}
          onEdit={onEdit}
        />
      )}

      {former.length > 0 && (
        <section className="mt-16 border-t border-neutral-900 pt-8">
          <button
            type="button"
            onClick={() => setShowFormer((v) => !v)}
            className="group flex w-full items-center justify-between"
          >
            <span className="flex items-baseline gap-3">
              <span className="font-serif text-xl font-medium tracking-tight text-neutral-400 group-hover:text-neutral-200">
                Former employees
              </span>
              <span className="text-[10px] font-medium uppercase tracking-editorial text-neutral-600">
                {former.length}
              </span>
            </span>
            <span className="text-[10px] uppercase tracking-widest text-neutral-600 group-hover:text-neutral-300">
              {showFormer ? 'Hide' : 'Show'}
            </span>
          </button>

          {showFormer && (
            <div className="mt-6 opacity-70">
              <CardGrid>
                {former.map((m) => (
                  <TeamCard
                    key={m.id}
                    member={m}
                    roleName={m.role_label ?? null}
                    onClick={() => onEdit(m)}
                  />
                ))}
              </CardGrid>
            </div>
          )}
        </section>
      )}
    </>
  );
}

function CardGrid({ children }: { children: React.ReactNode }) {
  // Real gaps + bordered cards (instead of the old 1px-divider trick)
  // so each employee reads as its own box on every theme. The thin
  // divider lines disappear on light backgrounds, leaving the cards
  // looking like floating text — borders fix that everywhere.
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {children}
    </div>
  );
}

function TeamCard({
  member,
  roleName,
  onClick,
}: {
  member: TeamMember;
  roleName: string | null | undefined;
  onClick: () => void;
}) {
  const initial = member.name.trim().charAt(0).toUpperCase() || '·';
  const pay = formatPayLine(member);

  return (
    <button
      onClick={onClick}
      className="group flex flex-col border border-neutral-800 bg-neutral-950 p-6 text-left transition-colors hover:border-neutral-700 hover:bg-neutral-900"
    >
      <div className="flex items-start gap-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center border border-neutral-800 font-serif text-base font-semibold text-neutral-300">
          {initial}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-serif text-lg font-medium tracking-tight text-neutral-50">
            {member.name}
          </div>
          {roleName && (
            <div className="mt-0.5 truncate text-xs text-neutral-500">{roleName}</div>
          )}
        </div>
        <div className="text-[10px] uppercase tracking-widest text-neutral-700 opacity-0 transition-opacity group-hover:opacity-100">
          Edit
        </div>
      </div>
      <div className="mt-6 border-t border-neutral-900 pt-4">
        <div className="text-[10px] uppercase tracking-editorial text-neutral-600">Pay</div>
        <div className="mt-1 text-sm text-neutral-200">{pay}</div>
      </div>
    </button>
  );
}

// =============================================================================
//  States
// =============================================================================
function LoadingState() {
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
        <div className="font-serif text-xl text-neutral-200">No one on the team yet.</div>
        <div className="mt-1 text-xs uppercase tracking-widest text-neutral-600">
          Manage departments and roles in Settings, then add your first employee.
        </div>
      </div>
      <button
        onClick={onAdd}
        className="border border-neutral-700 bg-transparent px-5 py-2.5 text-[11px] font-medium uppercase tracking-widest text-neutral-200 transition-colors hover:border-neutral-500"
      >
        Add your first employee
      </button>
    </div>
  );
}

// =============================================================================
//  PendingMembers — users who accepted an invite but have no team_member.
//  Each row has a "Add as employee" button that opens the create modal
//  pre-filled with their email + the position picked at invite time.
// =============================================================================
function PendingMembers({
  pending,
  onAdd,
}: {
  pending: UnlinkedMember[];
  onAdd: (p: UnlinkedMember) => void;
}) {
  return (
    <section className="mb-10">
      <div className="mb-3 flex items-baseline justify-between border-b border-neutral-800 pb-2">
        <h2 className="font-serif text-lg font-medium tracking-tight text-neutral-200">
          Needs an employee record
        </h2>
        <span className="text-[10px] uppercase tracking-widest text-neutral-600">
          {pending.length} pending
        </span>
      </div>
      <div className="divide-y divide-neutral-900 border border-neutral-900">
        {pending.map((p) => (
          <div
            key={p.user_id}
            className="flex flex-col gap-3 bg-neutral-950 p-4 md:flex-row md:items-center md:justify-between"
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate font-serif text-base text-neutral-100">
                  {p.email}
                </span>
                <span className="border border-neutral-800 px-1.5 py-0.5 text-[9px] uppercase tracking-widest text-neutral-500">
                  {p.membership_role}
                </span>
                {p.suggested_role_name && (
                  <span className="border border-neutral-800 px-1.5 py-0.5 text-[9px] uppercase tracking-widest text-neutral-400">
                    {p.suggested_dept_name
                      ? `${p.suggested_dept_name} · ${p.suggested_role_name}`
                      : p.suggested_role_name}
                  </span>
                )}
              </div>
              <div className="mt-1 text-[10px] uppercase tracking-widest text-neutral-600">
                Joined {formatJoined(p.joined_at)} · no pay set
              </div>
            </div>
            <button
              type="button"
              onClick={() => onAdd(p)}
              className="border border-neutral-700 bg-transparent px-4 py-2 text-[10px] uppercase tracking-widest text-neutral-200 transition-colors hover:border-neutral-500"
            >
              Add as employee
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function formatJoined(iso: string): string {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const min = Math.round(diffMs / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

// =============================================================================
//  Add / Edit modal
// =============================================================================
// Create supports optional prefill — used when converting a pending agency
// member (someone who accepted an invite but has no team_member yet) into
// a full employee record.
type CreatePrefill = {
  name?: string;
  email?: string;
  department_id?: string;
  role_id?: string;
  user_id?: string;
};
type ModalState =
  | { mode: 'create'; prefill?: CreatePrefill }
  | { mode: 'edit'; member: TeamMember };

function TeamFormModal({
  modal,
  departments,
  roles,
  onClose,
  onSaved,
}: {
  modal: ModalState;
  departments: Department[];
  roles: StaffRole[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = modal.mode === 'edit' ? modal.member : null;
  const prefill = modal.mode === 'create' ? modal.prefill : undefined;
  const navigate = useNavigate();
  // Close the modal and jump to Settings (departments + roles live there) —
  // used by the "+ Add new…" rows inside the dropdowns.
  function goToSettings() {
    onClose();
    navigate(ROUTES.settings);
  }

  const [departmentId, setDepartmentId] = useState<string>(
    editing?.department_id ?? prefill?.department_id ?? departments[0]?.id ?? '',
  );

  // Roles in the currently selected department.
  const deptRoles = useMemo(
    () => roles.filter((r) => r.department_id === departmentId),
    [roles, departmentId],
  );

  const [roleId, setRoleId] = useState<string>(
    editing?.role_id ?? prefill?.role_id ?? deptRoles[0]?.id ?? '',
  );

  // When department changes, reset roleId to first valid role.
  useEffect(() => {
    if (deptRoles.length > 0 && !deptRoles.some((r) => r.id === roleId)) {
      setRoleId(deptRoles[0]!.id);
    }
  }, [departmentId, deptRoles, roleId]);

  const selectedRole = roles.find((r) => r.id === roleId);
  const payStructure: PayStructure | null = selectedRole?.pay_structure ?? null;

  // Form fields
  const [name, setName] = useState(editing?.name ?? prefill?.name ?? '');
  const [flatDollars, setFlatDollars] = useState(
    editing?.flat_amount_cents != null
      ? (editing.flat_amount_cents / 100).toString()
      : '',
  );
  const [flatPeriodDays, setFlatPeriodDays] = useState(
    editing?.flat_period_days != null ? editing.flat_period_days.toString() : '7',
  );
  const [ratePercent, setRatePercent] = useState(
    editing?.rate != null ? (editing.rate * 100).toString() : '',
  );
  const [startDate, setStartDate] = useState<string>(editing?.start_date ?? '');
  const [endDate, setEndDate] = useState<string>(editing?.end_date ?? '');

  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    if (!name.trim()) {
      toast.error('Name is required.');
      return;
    }
    if (!departmentId) {
      toast.error('Pick a department.');
      return;
    }
    if (!selectedRole || !payStructure) {
      toast.error('Pick a role.');
      return;
    }
    setSubmitting(true);
    try {
      const dateFields = {
        start_date: startDate || null,
        end_date:   endDate || null,
      };

      if (payStructure === 'flat') {
        const cents = parseDollarsToCents(flatDollars);
        if (cents == null || cents < 0) throw new Error('Income is required.');
        const period = parseInt(flatPeriodDays, 10);
        if (!Number.isFinite(period) || period <= 0)
          throw new Error('Period (days) must be a positive number.');

        if (modal.mode === 'create') {
          await createTeamMember({
            department_id: departmentId,
            role_id: selectedRole.id,
            role_label: selectedRole.name,
            name,
            email:   prefill?.email   ?? null,
            user_id: prefill?.user_id ?? null,
            pay_structure: 'flat',
            flat_amount_cents: cents,
            flat_period_days: period,
            ...dateFields,
          } as CreateTeamMemberInput);
        } else {
          // If pay_structure changed, we need to clear opposite fields.
          const patch: UpdateTeamMemberInput = {
            department_id: departmentId,
            role_id: selectedRole.id,
            role_label: selectedRole.name,
            name: name.trim(),
            pay_structure: 'flat',
            flat_amount_cents: cents,
            flat_period_days: period,
            rate: null,
            ...dateFields,
          };
          await updateTeamMember(editing!.id, patch);
        }
      } else {
        const rate = parsePercentToRate(ratePercent);
        if (rate == null || rate < 0 || rate > 1)
          throw new Error('Rate must be between 0 and 100%.');
        if (modal.mode === 'create') {
          await createTeamMember({
            department_id: departmentId,
            role_id: selectedRole.id,
            role_label: selectedRole.name,
            name,
            email:   prefill?.email   ?? null,
            user_id: prefill?.user_id ?? null,
            pay_structure: payStructure,
            rate,
            ...dateFields,
          } as CreateTeamMemberInput);
        } else {
          const patch: UpdateTeamMemberInput = {
            department_id: departmentId,
            role_id: selectedRole.id,
            role_label: selectedRole.name,
            name: name.trim(),
            pay_structure: payStructure,
            rate,
            flat_amount_cents: null,
            flat_period_days: null,
            ...dateFields,
          };
          await updateTeamMember(editing!.id, patch);
        }
      }
      toast.success(modal.mode === 'create' ? 'Employee added.' : 'Employee updated.');
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
      title: `Delete ${modal.member.name}?`,
      message: 'Their historical data is preserved.',
      destructive: true,
      confirmLabel: 'Delete employee',
    });
    if (!ok) return;
    setDeleting(true);
    try {
      await softDeleteTeamMember(modal.member.id);
      toast.success('Employee removed.');
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
      eyebrow={
        modal.mode === 'create'
          ? prefill?.email ? 'Add as employee' : 'Add employee'
          : 'Edit employee'
      }
      title={
        modal.mode === 'create'
          ? prefill?.email ?? 'New employee'
          : modal.member.name
      }
    >
      <form onSubmit={handleSave} noValidate>
        {/* Department */}
        <div className="mb-5">
          <Label htmlFor="department">Department</Label>
          <Select
            id="department"
            value={departmentId}
            onChange={setDepartmentId}
            options={departments.map((d) => ({ value: d.id, label: d.name }))}
            footer={{ label: 'Add new department', onSelect: goToSettings }}
          />
        </div>

        {/* Role */}
        <div className="mb-5">
          <Label htmlFor="role">Role</Label>
          {deptRoles.length === 0 ? (
            <button
              type="button"
              onClick={goToSettings}
              className="group flex w-full items-center justify-between border border-dashed border-neutral-700 bg-neutral-950 px-3.5 py-3 text-sm text-neutral-400 transition-colors hover:border-neutral-500 hover:text-neutral-100"
            >
              <span>No roles in this department yet — add one</span>
              <span className="text-[10px] uppercase tracking-widest text-neutral-600 transition-colors group-hover:text-neutral-300">
                Settings →
              </span>
            </button>
          ) : (
            <Select
              id="role"
              value={roleId}
              onChange={setRoleId}
              options={deptRoles.map((r) => ({
                value: r.id,
                label: r.name,
                detail: payStructureLabel(r.pay_structure),
              }))}
              footer={{ label: 'Add new role', onSelect: goToSettings }}
            />
          )}
        </div>

        {/* Name */}
        <Field
          id="name"
          label="Name"
          type="text"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Sofia"
        />

        {/* Pay fields */}
        {payStructure === 'flat' && (
          <>
            <Field
              id="flat-amount"
              label="Income"
              type="text"
              inputMode="decimal"
              required
              value={flatDollars}
              onChange={(e) => setFlatDollars(e.target.value)}
              placeholder="e.g. 500.00"
              hint="Dollars per pay period."
            />
            <div className="mb-5">
              <Label htmlFor="flat-period">Pay period</Label>
              <Select
                id="flat-period"
                value={flatPeriodDays}
                onChange={setFlatPeriodDays}
                options={[
                  { value: '7',  label: 'Every Week',    detail: '7 days'  },
                  { value: '14', label: 'Every 2 Weeks', detail: '14 days' },
                  { value: '30', label: 'Every Month',   detail: '30 days' },
                ]}
              />
            </div>
          </>
        )}
        {(payStructure === 'commission' || payStructure === 'share') && (
          <Field
            id="rate"
            label={payStructure === 'commission' ? 'Commission rate' : 'Share rate'}
            type="text"
            inputMode="decimal"
            required
            value={ratePercent}
            onChange={(e) => setRatePercent(e.target.value)}
            placeholder="e.g. 50"
            hint={
              payStructure === 'commission'
                ? 'Percent of their sales the team member keeps.'
                : 'Percent of their withdrawals the team member keeps.'
            }
          />
        )}

        {/* Employment dates — both optional */}
        <div className="mb-5 grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="start-date">Start date</Label>
            <DatePicker
              id="start-date"
              value={startDate}
              onChange={setStartDate}
              placeholder="Optional"
            />
            {startDate && (
              <button
                type="button"
                onClick={() => setStartDate('')}
                className="mt-1.5 text-[10px] uppercase tracking-widest text-neutral-600 hover:text-neutral-300"
              >
                Clear
              </button>
            )}
          </div>
          <div>
            <Label htmlFor="end-date">End date</Label>
            <DatePicker
              id="end-date"
              value={endDate}
              onChange={setEndDate}
              placeholder="Still working"
            />
            {endDate && (
              <button
                type="button"
                onClick={() => setEndDate('')}
                className="mt-1.5 text-[10px] uppercase tracking-widest text-neutral-600 hover:text-neutral-300"
              >
                Clear
              </button>
            )}
          </div>
        </div>

        <div className="mt-8 flex flex-col gap-3">
          <Button type="submit" loading={submitting} disabled={!selectedRole}>
            {modal.mode === 'create' ? 'Add employee' : 'Save changes'}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>

        {modal.mode === 'edit' && (
          <div className="mt-6 border-t border-neutral-900 pt-5 text-right">
            <TextLink onClick={handleDelete}>
              {deleting ? 'Deleting…' : 'Delete employee'}
            </TextLink>
          </div>
        )}
      </form>
    </Modal>
  );
}

// -----------------------------------------------------------------------------
//  GearIcon — inline SVG so we don't pull an icon library for one icon.
// -----------------------------------------------------------------------------
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
