// =============================================================================
//  Settings.tsx
//  Agency settings. Currently:
//    * Departments  — add/rename/delete (used to group team members)
//    * Roles        — add/rename/delete per department, each with a pay structure
// =============================================================================

import { useEffect, useMemo, useState } from 'react';
import { PageHeader } from '../components/PageHeader';
import { Modal } from '../components/Modal';
import { Button, Field, Label, TextLink } from '../components/FormControls';
import { Select } from '../components/Select';
import {
  type Department,
  type DepartmentLayout,
  listDepartments,
  createDepartment,
  updateDepartment,
  softDeleteDepartment,
} from '../lib/departments';
import {
  type PayStructure,
  type StaffRole,
  listStaffRoles,
  createStaffRole,
  updateStaffRole,
  softDeleteStaffRole,
  payStructureLabel,
} from '../lib/staffRoles';
import {
  type ExpenseCategory,
  listExpenseCategories,
  createExpenseCategory,
  updateExpenseCategory,
  softDeleteExpenseCategory,
} from '../lib/expenseCategories';
import {
  type PaymentMethod,
  listPaymentMethods,
  createPaymentMethod,
  updatePaymentMethod,
  softDeletePaymentMethod,
} from '../lib/paymentMethods';
import { toast } from '../lib/toast';
import { confirm } from '../lib/confirm';
import { ColorPicker } from '../components/ColorPicker';
import { DEFAULT_LUXE_COLOR } from '../lib/colors';
import {
  type ColumnKey,
  TRACKING_COLUMNS,
  defaultVisibleColumns,
  loadVisibleColumns,
  saveVisibleColumns,
} from '../lib/trackingColumns';
import { TrackingUploads } from '../components/TrackingUploads';
import { EmptyState } from '../components/EmptyState';
import { SectionSkeleton } from '../components/Skeleton';
import {
  type Theme,
  THEMES,
  applyTheme,
  loadTheme,
  saveTheme,
} from '../lib/theme';
import {
  type LocaleSettings,
  CURRENCY_OPTIONS,
  loadLocale,
  saveLocale,
} from '../lib/locale';
import {
  type Labels,
  type LabelKey,
  DEFAULT_LABELS,
  loadLabels,
  saveLabels,
} from '../lib/labels';
import { getActiveAgencyId, getMyAgencyRole } from '../lib/agency';
import { InvitePanel } from '../components/InvitePanel';
import { checkManually as checkForUpdatesManually } from '../lib/updater';

const PAY_OPTIONS: { value: PayStructure; label: string; hint: string }[] = [
  { value: 'flat',       label: 'Wage',       hint: '$X every Y days. Covers weekly, biweekly, monthly, etc.' },
  { value: 'commission', label: 'Commission', hint: '% of chatter sales.' },
  { value: 'share',      label: 'Share',      hint: '% of model withdrawals.' },
];

// =============================================================================
//  Page
// =============================================================================
// `scope` controls which subset of settings sections is shown:
//   * 'main'     — agency-wide controls (departments, roles, team, region,
//                  labels, appearance). Reached from the sidebar.
//   * 'expenses' — only expense categories + payment methods. Reached
//                  from the gear button on the Expenses page.
//   * 'tracking' — only tracking columns + CSV upload history. Reached
//                  from the gear button on the Tracking page.
export type SettingsScope = 'main' | 'expenses' | 'tracking';

export function Settings({ scope = 'main' }: { scope?: SettingsScope } = {}) {
  const [departments, setDepartments] = useState<Department[] | null>(null);
  const [roles, setRoles] = useState<StaffRole[] | null>(null);
  const [categories, setCategories] = useState<ExpenseCategory[] | null>(null);
  const [methods, setMethods] = useState<PaymentMethod[] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [modal, setModal] = useState<ModalState | null>(null);

  // Each section opts in to a list of scopes. Cheap predicate so the
  // JSX stays readable below.
  const show = (...scopes: SettingsScope[]) => scopes.includes(scope);

  async function reload() {
    try {
      const [d, r, c, m] = await Promise.all([
        listDepartments(),
        listStaffRoles(),
        listExpenseCategories(),
        listPaymentMethods(),
      ]);
      setDepartments(d);
      setRoles(r);
      setCategories(c);
      setMethods(m);
    } catch (e) {
      setError(e as Error);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  // Header copy depends on scope so the page reads naturally regardless
  // of which gear / link the user followed in.
  const header = (() => {
    switch (scope) {
      case 'expenses':
        return {
          eyebrow: 'Expense settings',
          title: 'Expense settings.',
          subtitle: 'Categories and payment methods for the Expenses page.',
        };
      case 'tracking':
        return {
          eyebrow: 'Tracking settings',
          title: 'Tracking settings.',
          subtitle: 'Visible columns and CSV upload history.',
        };
      default:
        return {
          eyebrow: 'Settings',
          title: 'Settings.',
          subtitle: 'Manage your departments, roles, team, and app preferences.',
        };
    }
  })();

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        eyebrow={header.eyebrow}
        title={header.title}
        subtitle={header.subtitle}
      />

      {error && (
        <div className="mb-6 border border-red-900/60 bg-red-950/30 p-4 text-sm text-red-200">
          {error.message}
        </div>
      )}

      {/* Departments */}
      {show('main') && (
      <section className="mb-14">
        <div className="mb-4 flex flex-col gap-2 border-b border-neutral-800 pb-4 md:flex-row md:items-end md:justify-between">
          <div>
            <h2 className="font-serif text-2xl font-semibold tracking-tight text-neutral-100">
              Departments
            </h2>
            <p className="mt-1 text-sm text-neutral-500">
              Groups your team into top-level categories (e.g. OFM, Reddit, Staff).
            </p>
          </div>
          <button
            onClick={() => setModal({ kind: 'department-create' })}
            className="self-start border border-neutral-700 bg-transparent px-4 py-2 text-[11px] font-medium uppercase tracking-widest text-neutral-200 transition-colors hover:border-neutral-500 md:self-auto"
          >
            + Add department
          </button>
        </div>

        {departments === null ? (
          <Loading />
        ) : departments.length === 0 ? (
          <EmptyState
            title="No departments yet."
            message="Departments group your team into top-level categories like OFM, Reddit, or Staff. Each one becomes a tab in the sidebar."
            ctaLabel="+ Add department"
            onCta={() => setModal({ kind: 'department-create' })}
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {departments.map((d) => (
              <button
                key={d.id}
                onClick={() => setModal({ kind: 'department-edit', department: d })}
                className="group flex items-center justify-between border border-neutral-800 bg-neutral-950 p-5 text-left transition-colors hover:border-neutral-700 hover:bg-neutral-900"
              >
                <div className="font-serif text-lg font-medium tracking-tight text-neutral-50">
                  {d.name}
                </div>
                <div className="text-[10px] uppercase tracking-widest text-neutral-700 opacity-0 transition-opacity group-hover:opacity-100">
                  Edit
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      )}

      {/* Roles (one block per department) */}
      {show('main') && (
      <section>
        <div className="mb-4 flex flex-col gap-2 border-b border-neutral-800 pb-4 md:flex-row md:items-end md:justify-between">
          <div>
            <h2 className="font-serif text-2xl font-semibold tracking-tight text-neutral-100">
              Roles
            </h2>
            <p className="mt-1 text-sm text-neutral-500">
              Named positions inside each department. Each role has a fixed pay structure.
            </p>
          </div>
        </div>

        {departments === null || roles === null ? (
          <Loading />
        ) : departments.length === 0 ? (
          <EmptyTile>Add a department first.</EmptyTile>
        ) : (
          <div className="space-y-10">
            {departments.map((d) => (
              <RoleBlockForDepartment
                key={d.id}
                department={d}
                roles={roles.filter((r) => r.department_id === d.id)}
                onAdd={() => setModal({ kind: 'role-create', department: d })}
                onEdit={(r) => setModal({ kind: 'role-edit', role: r })}
              />
            ))}
          </div>
        )}
      </section>

      )}

      {/* Expense categories — shown in 'main' overview AND on the
          gear-driven /settings/expenses page. */}
      {show('main', 'expenses') && (
      <section className="mt-14">
        <div className="mb-4 flex flex-col gap-2 border-b border-neutral-800 pb-4 md:flex-row md:items-end md:justify-between">
          <div>
            <h2 className="font-serif text-2xl font-semibold tracking-tight text-neutral-100">
              Expense categories
            </h2>
            <p className="mt-1 text-sm text-neutral-500">
              Buckets to organize expenses (Subscriptions, Rent, Software, etc.).
            </p>
          </div>
          <button
            onClick={() => setModal({ kind: 'category-create' })}
            className="self-start border border-neutral-700 bg-transparent px-4 py-2 text-[11px] font-medium uppercase tracking-widest text-neutral-200 transition-colors hover:border-neutral-500 md:self-auto"
          >
            + Add category
          </button>
        </div>
        {categories === null ? (
          <Loading />
        ) : categories.length === 0 ? (
          <EmptyState
            title="No categories yet."
            message="Categories help you organize expenses (e.g. Subscriptions, Software, Rent) and group them in reports."
            ctaLabel="+ Add category"
            onCta={() => setModal({ kind: 'category-create' })}
          />
        ) : (
          <NamedColorGrid
            items={categories}
            onEdit={(c) => setModal({ kind: 'category-edit', category: c })}
          />
        )}
      </section>

      )}

      {/* Payment methods — same scope as expense categories. */}
      {show('main', 'expenses') && (
      <section className="mt-14">
        <div className="mb-4 flex flex-col gap-2 border-b border-neutral-800 pb-4 md:flex-row md:items-end md:justify-between">
          <div>
            <h2 className="font-serif text-2xl font-semibold tracking-tight text-neutral-100">
              Payment methods
            </h2>
            <p className="mt-1 text-sm text-neutral-500">
              How expenses were paid (Wise, Skrill, Crypto, etc.).
            </p>
          </div>
          <button
            onClick={() => setModal({ kind: 'method-create' })}
            className="self-start border border-neutral-700 bg-transparent px-4 py-2 text-[11px] font-medium uppercase tracking-widest text-neutral-200 transition-colors hover:border-neutral-500 md:self-auto"
          >
            + Add method
          </button>
        </div>
        {methods === null ? (
          <Loading />
        ) : methods.length === 0 ? (
          <EmptyState
            title="No payment methods yet."
            message="Track how expenses were paid (Wise, Skrill, Crypto, etc.) for easier reconciliation later."
            ctaLabel="+ Add method"
            onCta={() => setModal({ kind: 'method-create' })}
          />
        ) : (
          <NamedColorGrid
            items={methods}
            onEdit={(m) => setModal({ kind: 'method-edit', method: m })}
          />
        )}
      </section>

      )}

      {/* Sections below are agency-wide; not scoped to the per-page
          gears. They only appear on the main Settings landing page. */}
      {show('main') && <TeamSection />}
      {show('main') && <RegionSection />}
      {show('main') && <LabelsSection />}
      {show('main') && <AppearanceSection />}
      {show('main') && <AppUpdatesSection />}

      {/* Tracking columns + CSV upload history — shown on /settings/tracking
          (gear from the Tracking page) and also on the main Settings page. */}
      {show('main', 'tracking') && <TrackingColumnsSection />}

      {show('main', 'tracking') && (
        <section className="mt-14">
          <div className="mb-4 flex items-baseline justify-between border-b border-neutral-800 pb-3">
            <h2 className="font-serif text-2xl font-semibold tracking-tight text-neutral-100">
              CSV upload history
            </h2>
            <span className="text-xs text-neutral-500">
              Past Infloww imports. Deleting removes their snapshots only.
            </span>
          </div>
          <TrackingUploads />
        </section>
      )}

      {modal && (
        <SettingsModal
          modal={modal}
          departments={departments ?? []}
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
//  Helpers
// =============================================================================
function Loading() {
  return <SectionSkeleton rows={3} />;
}

function EmptyTile({ children }: { children: React.ReactNode }) {
  // Kept for inline use inside role sub-blocks; the page-level emptiness
  // now uses <EmptyState /> for a richer CTA layout.
  return (
    <div className="flex h-24 items-center justify-center border border-dashed border-neutral-800 text-xs uppercase tracking-widest text-neutral-700">
      {children}
    </div>
  );
}

// Grid of name+color tiles. Used for both expense categories and payment methods.
function NamedColorGrid<T extends { id: string; name: string; color: string }>({
  items,
  onEdit,
}: {
  items: T[];
  onEdit: (item: T) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item) => (
        <button
          key={item.id}
          onClick={() => onEdit(item)}
          className="group flex items-center justify-between border border-neutral-800 bg-neutral-950 p-5 text-left transition-colors hover:border-neutral-700 hover:bg-neutral-900"
        >
          <div className="flex items-center gap-3 min-w-0">
            <span
              className="inline-block h-2.5 w-2.5 shrink-0"
              style={{ backgroundColor: item.color }}
            />
            <span className="truncate font-serif text-lg font-medium tracking-tight text-neutral-50">
              {item.name}
            </span>
          </div>
          <div className="text-[10px] uppercase tracking-widest text-neutral-700 opacity-0 transition-opacity group-hover:opacity-100">
            Edit
          </div>
        </button>
      ))}
    </div>
  );
}

function RoleBlockForDepartment({
  department,
  roles,
  onAdd,
  onEdit,
}: {
  department: Department;
  roles: StaffRole[];
  onAdd: () => void;
  onEdit: (r: StaffRole) => void;
}) {
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-baseline gap-3">
          <h3 className="font-serif text-xl font-medium tracking-tight text-neutral-200">
            {department.name}
          </h3>
          <span className="text-[10px] font-medium uppercase tracking-editorial text-neutral-600">
            {roles.length}
          </span>
        </div>
        <button
          onClick={onAdd}
          className="text-[10px] uppercase tracking-widest text-neutral-500 transition-colors hover:text-neutral-100"
        >
          + Add role
        </button>
      </div>
      {roles.length === 0 ? (
        <EmptyTile>No roles in {department.name} yet.</EmptyTile>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {roles
            .slice()
            .sort((a, b) => a.sort_order - b.sort_order)
            .map((r) => (
              <button
                key={r.id}
                onClick={() => onEdit(r)}
                className="group flex items-center justify-between border border-neutral-800 bg-neutral-950 p-5 text-left transition-colors hover:border-neutral-700 hover:bg-neutral-900"
              >
                <div>
                  <div className="font-serif text-lg font-medium tracking-tight text-neutral-50">
                    {r.name}
                  </div>
                  <div className="mt-1 text-[10px] uppercase tracking-editorial text-neutral-600">
                    {payStructureLabel(r.pay_structure)}
                  </div>
                </div>
                <div className="text-[10px] uppercase tracking-widest text-neutral-700 opacity-0 transition-opacity group-hover:opacity-100">
                  Edit
                </div>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

// =============================================================================
//  Modal
// =============================================================================
type ModalState =
  | { kind: 'department-create' }
  | { kind: 'department-edit'; department: Department }
  | { kind: 'role-create'; department: Department }
  | { kind: 'role-edit'; role: StaffRole }
  | { kind: 'category-create' }
  | { kind: 'category-edit'; category: ExpenseCategory }
  | { kind: 'method-create' }
  | { kind: 'method-edit'; method: PaymentMethod };

function SettingsModal({
  modal,
  departments,
  onClose,
  onSaved,
}: {
  modal: ModalState;
  departments: Department[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isRoleEdit  = modal.kind === 'role-edit';
  const isRoleForm  = modal.kind === 'role-create' || modal.kind === 'role-edit';
  const isDeptForm  = modal.kind === 'department-create' || modal.kind === 'department-edit';
  const isColorForm =
    modal.kind === 'category-create' ||
    modal.kind === 'category-edit' ||
    modal.kind === 'method-create' ||
    modal.kind === 'method-edit';
  const isEdit =
    modal.kind === 'department-edit' ||
    modal.kind === 'role-edit' ||
    modal.kind === 'category-edit' ||
    modal.kind === 'method-edit';

  // Initial values.
  const initial = useMemo(() => {
    if (modal.kind === 'department-edit') {
      return { name: modal.department.name, payStructure: 'flat' as PayStructure, departmentId: '' };
    }
    if (modal.kind === 'role-create') {
      return { name: '', payStructure: 'flat' as PayStructure, departmentId: modal.department.id };
    }
    if (modal.kind === 'role-edit') {
      return {
        name: modal.role.name,
        payStructure: modal.role.pay_structure,
        departmentId: modal.role.department_id,
      };
    }
    if (modal.kind === 'category-edit') {
      return { name: modal.category.name, payStructure: 'flat' as PayStructure, departmentId: '' };
    }
    if (modal.kind === 'method-edit') {
      return { name: modal.method.name, payStructure: 'flat' as PayStructure, departmentId: '' };
    }
    return { name: '', payStructure: 'flat' as PayStructure, departmentId: '' };
  }, [modal]);

  const [name, setName] = useState(initial.name);
  const [payStructure, setPayStructure] = useState<PayStructure>(initial.payStructure);
  const [departmentId, setDepartmentId] = useState(initial.departmentId);
  // Layout choice for department-create/edit. Used by the create RPC and
  // also for renaming/changing existing departments' layout from Settings.
  const [layoutType, setLayoutType] = useState<DepartmentLayout>(
    modal.kind === 'department-edit' ? modal.department.layout_type : 'models',
  );
  const [color, setColor] = useState<string>(
    modal.kind === 'category-edit'
      ? modal.category.color
      : modal.kind === 'method-edit'
        ? modal.method.color
        : DEFAULT_LUXE_COLOR,
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
    setSubmitting(true);
    try {
      switch (modal.kind) {
        case 'department-create':
          await createDepartment(name, layoutType);
          toast.success('Department added.');
          break;
        case 'department-edit':
          await updateDepartment(modal.department.id, { name, layout_type: layoutType });
          toast.success('Department updated.');
          break;
        case 'role-create':
          await createStaffRole({
            department_id: modal.department.id,
            name,
            pay_structure: payStructure,
          });
          toast.success('Role added.');
          break;
        case 'role-edit':
          await updateStaffRole(modal.role.id, {
            name,
            pay_structure: payStructure,
            department_id: departmentId,
          });
          toast.success('Role updated.');
          break;
        case 'category-create':
          await createExpenseCategory({ name, color });
          toast.success('Category added.');
          break;
        case 'category-edit':
          await updateExpenseCategory(modal.category.id, { name, color });
          toast.success('Category updated.');
          break;
        case 'method-create':
          await createPaymentMethod({ name, color });
          toast.success('Method added.');
          break;
        case 'method-edit':
          await updatePaymentMethod(modal.method.id, { name, color });
          toast.success('Method updated.');
          break;
      }
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    if (deleting) return;

    let title = '';
    let message = '';
    let confirmLabel = 'Delete';
    let doDelete: (() => Promise<void>) | null = null;

    switch (modal.kind) {
      case 'department-edit':
        title = `Delete "${modal.department.name}"?`;
        message = 'If any team members are in this department, the delete will fail. Move them first.';
        confirmLabel = 'Delete department';
        doDelete = () => softDeleteDepartment(modal.department.id);
        break;
      case 'role-edit':
        title = `Delete role "${modal.role.name}"?`;
        message = "Team members using this role keep their record. They just won't see this role as an option going forward.";
        confirmLabel = 'Delete role';
        doDelete = () => softDeleteStaffRole(modal.role.id);
        break;
      case 'category-edit':
        title = `Delete "${modal.category.name}"?`;
        message = 'Expenses using this category will lose the category label.';
        confirmLabel = 'Delete category';
        doDelete = () => softDeleteExpenseCategory(modal.category.id);
        break;
      case 'method-edit':
        title = `Delete "${modal.method.name}"?`;
        message = 'Expenses using this method will lose the method label.';
        confirmLabel = 'Delete method';
        doDelete = () => softDeletePaymentMethod(modal.method.id);
        break;
      default:
        return;
    }

    const ok = await confirm({ title, message, destructive: true, confirmLabel });
    if (!ok) return;

    setDeleting(true);
    try {
      await doDelete!();
      toast.success('Removed.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete.');
    } finally {
      setDeleting(false);
    }
  }

  // Title + eyebrow per kind.
  const meta = (() => {
    switch (modal.kind) {
      case 'department-create':
        return { eyebrow: 'Add department',  title: 'New department',  fieldLabel: 'Department name', placeholder: 'e.g. Operations' };
      case 'department-edit':
        return { eyebrow: 'Edit department', title: modal.department.name, fieldLabel: 'Department name', placeholder: '' };
      case 'role-create':
        return { eyebrow: 'Add role',  title: `New role · ${modal.department.name}`, fieldLabel: 'Role name', placeholder: 'e.g. Senior Chatter' };
      case 'role-edit':
        return { eyebrow: 'Edit role', title: modal.role.name, fieldLabel: 'Role name', placeholder: '' };
      case 'category-create':
        return { eyebrow: 'Add category',  title: 'New expense category', fieldLabel: 'Category name', placeholder: 'e.g. Subscriptions' };
      case 'category-edit':
        return { eyebrow: 'Edit category', title: modal.category.name, fieldLabel: 'Category name', placeholder: '' };
      case 'method-create':
        return { eyebrow: 'Add method',  title: 'New payment method', fieldLabel: 'Method name', placeholder: 'e.g. Wise' };
      case 'method-edit':
        return { eyebrow: 'Edit method', title: modal.method.name, fieldLabel: 'Method name', placeholder: '' };
    }
  })();
  const titleText = meta.title;
  const eyebrowText = meta.eyebrow;

  return (
    <Modal open onClose={onClose} eyebrow={eyebrowText} title={titleText}>
      <form onSubmit={handleSave} noValidate>
        <Field
          id="name"
          label={meta.fieldLabel}
          type="text"
          required
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={meta.placeholder}
        />

        {/* Department picker — only when editing a role, so you can move it. */}
        {isRoleEdit && (
          <div className="mb-5">
            <Label htmlFor="role-department">Department</Label>
            <Select
              id="role-department"
              value={departmentId}
              onChange={setDepartmentId}
              options={departments.map((d) => ({ value: d.id, label: d.name }))}
            />
          </div>
        )}

        {/* Layout picker — only on department create/edit. */}
        {isDeptForm && (
          <div className="mb-5">
            <Label htmlFor="layout-type">Layout</Label>
            <div className="grid grid-cols-2 gap-2">
              {(['models', 'marketing'] as DepartmentLayout[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setLayoutType(t)}
                  className={
                    'flex flex-col items-start px-4 py-3 text-left transition-colors ' +
                    (t === layoutType
                      ? 'border border-neutral-50 bg-neutral-50 text-neutral-950'
                      : 'border border-neutral-800 bg-transparent text-neutral-200 hover:border-neutral-600')
                  }
                >
                  <div className="text-[11px] font-medium uppercase tracking-widest">
                    {t}
                  </div>
                  <div
                    className={
                      'mt-0.5 text-xs ' +
                      (t === layoutType ? 'text-neutral-700' : 'text-neutral-500')
                    }
                  >
                    {t === 'models'
                      ? 'Sales + withdrawals'
                      : 'Accounts + monthly income'}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Color picker — only for categories / methods. */}
        {isColorForm && (
          <div className="mb-5">
            <Label htmlFor="color">Color</Label>
            <ColorPicker value={color} onChange={setColor} />
          </div>
        )}

        {/* Pay structure — only on role create/edit. */}
        {isRoleForm && (
          <div className="mb-5">
            <Label htmlFor="pay-structure">Pay structure</Label>
            <div className="grid grid-cols-1 gap-2">
              {PAY_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setPayStructure(opt.value)}
                  className={
                    'flex flex-col items-start px-4 py-3 text-left transition-colors ' +
                    (opt.value === payStructure
                      ? 'border border-neutral-50 bg-neutral-50 text-neutral-950'
                      : 'border border-neutral-800 bg-transparent text-neutral-200 hover:border-neutral-600')
                  }
                >
                  <div className="text-[11px] font-medium uppercase tracking-widest">
                    {opt.label}
                  </div>
                  <div
                    className={
                      'mt-0.5 text-xs ' +
                      (opt.value === payStructure ? 'text-neutral-700' : 'text-neutral-500')
                    }
                  >
                    {opt.hint}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="mt-8 flex flex-col gap-3">
          <Button type="submit" loading={submitting}>
            {isEdit ? 'Save changes' : 'Add'}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>

        {isEdit && (
          <div className="mt-6 border-t border-neutral-900 pt-5 text-right">
            <TextLink onClick={handleDelete}>
              {deleting
                ? 'Deleting…'
                : isDeptForm
                  ? 'Delete department'
                  : isRoleForm
                    ? 'Delete role'
                    : modal.kind === 'category-edit'
                      ? 'Delete category'
                      : 'Delete method'}
            </TextLink>
          </div>
        )}
      </form>
    </Modal>
  );
}

// =============================================================================
//  TeamSection — Settings entry point for teammate invites. Admins only;
//  staff see nothing. The actual UI lives in <InvitePanel /> so the same
//  experience can also be opened as a modal from the Employees page.
// =============================================================================
function TeamSection() {
  const agencyId = getActiveAgencyId();
  const [role, setRole] = useState<'owner' | 'admin' | 'staff' | null>(null);

  useEffect(() => {
    if (!agencyId) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await getMyAgencyRole(agencyId);
        if (!cancelled) setRole(r);
      } catch {
        /* show nothing on error */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agencyId]);

  if (!agencyId) return null;
  if (role !== null && role !== 'owner' && role !== 'admin') return null;

  return (
    <section className="mt-14">
      <div className="mb-4 flex flex-col gap-2 border-b border-neutral-800 pb-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h2 className="font-serif text-2xl font-semibold tracking-tight text-neutral-100">
            Team &amp; invites
          </h2>
          <p className="mt-1 text-sm text-neutral-500">
            Invite teammates to sign in to your agency. Links expire in 7 days
            and stop working after one use.
          </p>
        </div>
      </div>
      <InvitePanel agencyId={agencyId} />
    </section>
  );
}

// =============================================================================
//  AppearanceSection — pick the app's color theme. Synced via prefs.
// =============================================================================
function AppearanceSection() {
  const [theme, setTheme] = useState<Theme>('dark');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const t = await loadTheme();
        if (!cancelled) {
          setTheme(t);
          setLoaded(true);
        }
      } catch (err) {
        if (!cancelled) {
          toast.error(err instanceof Error ? err.message : 'Could not load theme.');
          setLoaded(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function pick(next: Theme) {
    if (next === theme) return;
    const prev = theme;
    setTheme(next);
    applyTheme(next);
    setSaving(true);
    try {
      await saveTheme(next);
    } catch (err) {
      setTheme(prev);
      applyTheme(prev);
      toast.error(err instanceof Error ? err.message : 'Could not save theme.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mt-14">
      <div className="mb-4 flex items-baseline justify-between border-b border-neutral-800 pb-3">
        <h2 className="font-serif text-2xl font-semibold tracking-tight text-neutral-100">
          Appearance
        </h2>
        <span className="text-xs text-neutral-500">
          {saving ? 'Saving…' : 'Synced across your devices'}
        </span>
      </div>

      {!loaded ? (
        <Loading />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {THEMES.map((t) => (
            <ThemeTile
              key={t.value}
              theme={t.value}
              label={t.label}
              hint={t.hint}
              selected={theme === t.value}
              onPick={() => void pick(t.value)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

// A single theme option. Renders a tiny preview swatch using the same
// CSS variables the real themes use, so users can see roughly what
// each one looks like before committing.
function ThemeTile({
  theme,
  label,
  hint,
  selected,
  onPick,
}: {
  theme: Theme;
  label: string;
  hint: string;
  selected: boolean;
  onPick: () => void;
}) {
  const swatch = THEME_SWATCHES[theme];
  return (
    <button
      type="button"
      onClick={onPick}
      className={
        'group flex items-center gap-4 border p-5 text-left transition-colors ' +
        (selected
          ? 'border-neutral-50 bg-neutral-900'
          : 'border-neutral-800 bg-neutral-950 hover:border-neutral-700 hover:bg-neutral-900')
      }
    >
      <div
        className="flex h-12 w-16 shrink-0 overflow-hidden border border-neutral-800"
        aria-hidden
      >
        <div className="flex-1" style={{ backgroundColor: swatch.bg }} />
        <div className="flex-1" style={{ backgroundColor: swatch.surface }} />
        <div className="flex-1" style={{ backgroundColor: swatch.text }} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-serif text-lg font-medium tracking-tight text-neutral-50">
            {label}
          </span>
          {selected && (
            <span className="text-[10px] uppercase tracking-widest text-neutral-500">
              Current
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate text-xs text-neutral-500">{hint}</div>
      </div>
    </button>
  );
}

// =============================================================================
//  RegionSection — currency + locale. Drives formatCents app-wide.
// =============================================================================
function RegionSection() {
  const [settings, setSettings] = useState<LocaleSettings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const s = await loadLocale();
        if (!cancelled) setSettings(s);
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error ? err.message : 'Could not load region.');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function pick(currency: LocaleSettings['currency']) {
    if (!settings || currency === settings.currency) return;
    const match = CURRENCY_OPTIONS.find((c) => c.value === currency);
    const next: LocaleSettings = {
      currency,
      locale: match?.locale ?? 'en-US',
    };
    const prev = settings;
    setSettings(next);
    setSaving(true);
    try {
      await saveLocale(next);
      toast.success('Region updated. Money displays now use your chosen currency.');
    } catch (err) {
      setSettings(prev);
      toast.error(err instanceof Error ? err.message : 'Could not save region.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mt-14">
      <div className="mb-4 flex items-baseline justify-between border-b border-neutral-800 pb-3">
        <div>
          <h2 className="font-serif text-2xl font-semibold tracking-tight text-neutral-100">
            Region &amp; currency
          </h2>
          <p className="mt-1 text-sm text-neutral-500">
            How money is displayed across the app. Stored data is unchanged —
            this is purely a display format.
          </p>
        </div>
        <span className="text-xs text-neutral-500">
          {saving ? 'Saving…' : 'Synced across your devices'}
        </span>
      </div>

      {!settings ? (
        <Loading />
      ) : (
        <div className="max-w-md">
          <Label htmlFor="currency-select">Currency</Label>
          <Select
            id="currency-select"
            value={settings.currency}
            onChange={(v) => void pick(v as LocaleSettings['currency'])}
            options={CURRENCY_OPTIONS.map((c) => ({ value: c.value, label: c.label }))}
          />
          <p className="mt-3 text-xs text-neutral-500">
            Example: 1,234.56 in your chosen currency renders as
            <span className="ml-1 font-medium text-neutral-300">
              {new Intl.NumberFormat(
                CURRENCY_OPTIONS.find((c) => c.value === settings.currency)?.locale ?? 'en-US',
                { style: 'currency', currency: settings.currency },
              ).format(1234.56)}
            </span>
            .
          </p>
        </div>
      )}
    </section>
  );
}

// =============================================================================
//  LabelsSection — rename built-in terminology (chatter/model/sale/…) so the
//  app reads naturally for your business. Income source labels are no longer
//  here — they come from your Departments.
//
//  UX: a single key/value table. Edit any cell; saves automatically on blur.
//  Empty value = revert to default. No save/discard buttons.
// =============================================================================
function LabelsSection() {
  const [labels, setLabels] = useState<Labels | null>(null);
  const [savingKey, setSavingKey] = useState<LabelKey | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const l = await loadLabels();
        if (!cancelled) setLabels(l);
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error ? err.message : 'Could not load labels.');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const rows: { key: LabelKey; example: string }[] = [
    { key: 'chatter',    example: 'e.g. Sales rep, Agent, Closer' },
    { key: 'model',      example: 'e.g. Creator, Talent, Client' },
    { key: 'sale',       example: 'e.g. Booking, Order, Deal' },
    { key: 'withdrawal', example: 'e.g. Payout, Cashout, Invoice' },
    { key: 'payout',     example: 'e.g. Payment, Disbursement' },
  ];

  async function persist(key: LabelKey, raw: string) {
    if (!labels) return;
    const next = (raw.trim() || DEFAULT_LABELS[key]);
    if (next === labels[key]) return; // No change.
    const prev = labels;
    setLabels({ ...labels, [key]: next });
    setSavingKey(key);
    try {
      await saveLabels({ [key]: next });
    } catch (err) {
      setLabels(prev);
      toast.error(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setSavingKey(null);
    }
  }

  return (
    <section className="mt-14">
      <div className="mb-4 border-b border-neutral-800 pb-3">
        <h2 className="font-serif text-2xl font-semibold tracking-tight text-neutral-100">
          Vocabulary
        </h2>
        <p className="mt-1 text-sm text-neutral-500">
          Rename built-in words to fit your business. Changes save when you
          tab away from the field.
        </p>
      </div>

      {!labels ? (
        <Loading />
      ) : (
        <div className="border border-neutral-900">
          {rows.map((r, i) => (
            <LabelRow
              key={r.key}
              labelKey={r.key}
              defaultLabel={DEFAULT_LABELS[r.key]}
              currentValue={labels[r.key]}
              example={r.example}
              saving={savingKey === r.key}
              first={i === 0}
              onCommit={(v) => void persist(r.key, v)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function LabelRow({
  labelKey,
  defaultLabel,
  currentValue,
  example,
  saving,
  first,
  onCommit,
}: {
  labelKey: LabelKey;
  defaultLabel: string;
  currentValue: string;
  example: string;
  saving: boolean;
  first: boolean;
  onCommit: (raw: string) => void;
}) {
  const [draft, setDraft] = useState(currentValue);
  useEffect(() => { setDraft(currentValue); }, [currentValue]);

  const isCustom = currentValue !== defaultLabel;

  return (
    <div
      className={
        'grid grid-cols-[120px_1fr_auto] items-center gap-3 px-4 py-3 md:grid-cols-[160px_1fr_auto] md:gap-4 md:px-5 ' +
        (first ? '' : 'border-t border-neutral-900')
      }
    >
      <div className="min-w-0">
        <div className="truncate text-sm text-neutral-300">{defaultLabel}</div>
        <div className="mt-0.5 truncate text-[10px] uppercase tracking-widest text-neutral-600">
          {example}
        </div>
      </div>
      <input
        id={`label-${labelKey}`}
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => onCommit(draft)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
          if (e.key === 'Escape') { setDraft(currentValue); (e.currentTarget as HTMLInputElement).blur(); }
        }}
        placeholder={defaultLabel}
        className="w-full bg-transparent text-sm text-neutral-100 placeholder:text-neutral-600 focus:outline-none"
      />
      <div className="text-[10px] uppercase tracking-widest text-neutral-600">
        {saving ? 'Saving' : isCustom ? 'Custom' : 'Default'}
      </div>
    </div>
  );
}

// =============================================================================
//  AppUpdatesSection — manual "Check for updates" trigger. Only shown
//  when running inside the Tauri desktop app (the browser version has
//  nothing to update — it's served fresh on every reload).
// =============================================================================
function AppUpdatesSection() {
  const isDesktop =
    typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  const [checking, setChecking] = useState(false);

  if (!isDesktop) return null;

  return (
    <section className="mt-14">
      <div className="mb-4 flex items-baseline justify-between border-b border-neutral-800 pb-3">
        <div>
          <h2 className="font-serif text-2xl font-semibold tracking-tight text-neutral-100">
            App updates
          </h2>
          <p className="mt-1 text-sm text-neutral-500">
            The app checks for updates automatically when it starts. You can
            also check manually here.
          </p>
        </div>
        <button
          type="button"
          disabled={checking}
          onClick={async () => {
            setChecking(true);
            try {
              await checkForUpdatesManually();
            } finally {
              setChecking(false);
            }
          }}
          className="border border-neutral-700 bg-transparent px-4 py-2 text-[11px] font-medium uppercase tracking-widest text-neutral-200 transition-colors hover:border-neutral-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {checking ? 'Checking…' : 'Check for updates'}
        </button>
      </div>
    </section>
  );
}

const THEME_SWATCHES: Record<Theme, { bg: string; surface: string; text: string }> = {
  'dark':          { bg: '#0a0a0a', surface: '#171717', text: '#fafafa' },
  'light':         { bg: '#ffffff', surface: '#f5f5f5', text: '#0a0a0a' },
  'nighttime':     { bg: '#000000', surface: '#0a0a0a', text: '#e8d9b8' },
  'sepia':         { bg: '#f4ecd8', surface: '#e8dcc4', text: '#3a2f1a' },
  'high-contrast': { bg: '#000000', surface: '#000000', text: '#ffffff' },
};

// =============================================================================
//  TrackingColumnsSection — toggle which columns the Tracking page table
//  shows. Saves to user_preferences (synced across devices).
// =============================================================================
function TrackingColumnsSection() {
  const [visible, setVisible] = useState<Set<ColumnKey>>(() => defaultVisibleColumns());
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const v = await loadVisibleColumns();
        if (!cancelled) {
          setVisible(v);
          setLoaded(true);
        }
      } catch (err) {
        if (!cancelled) {
          toast.error(err instanceof Error ? err.message : 'Could not load columns.');
          setLoaded(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggle(key: ColumnKey) {
    const next = new Set(visible);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    // Optimistic update.
    setVisible(next);
    setSaving(true);
    try {
      await saveVisibleColumns(next);
    } catch (err) {
      // Revert on failure.
      setVisible(visible);
      toast.error(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mt-14">
      <div className="mb-4 flex items-baseline justify-between border-b border-neutral-800 pb-3">
        <h2 className="font-serif text-2xl font-semibold tracking-tight text-neutral-100">
          Tracking columns
        </h2>
        <span className="text-xs text-neutral-500">
          {saving ? 'Saving…' : `${visible.size} of ${TRACKING_COLUMNS.length} shown`}
        </span>
      </div>

      {!loaded ? (
        <Loading />
      ) : (
        <>
          {/* Shown — click ✕ to hide. */}
          <div className="mb-6">
            <div className="mb-2 text-[10px] uppercase tracking-widest text-neutral-500">
              Shown
            </div>
            <div className="flex flex-wrap gap-2">
              {TRACKING_COLUMNS.filter((c) => visible.has(c.key)).map((col) => (
                <button
                  key={col.key}
                  type="button"
                  onClick={() => void toggle(col.key)}
                  title={col.hint}
                  className="group flex items-center gap-2 border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-[11px] uppercase tracking-widest text-neutral-200 transition-colors hover:border-neutral-500 hover:bg-neutral-800"
                >
                  {col.label}
                  <span aria-hidden className="text-neutral-600 transition-colors group-hover:text-neutral-300">
                    ✕
                  </span>
                </button>
              ))}
              {visible.size === 0 && (
                <span className="text-[10px] uppercase tracking-widest text-neutral-600">
                  No columns shown — pick from below.
                </span>
              )}
            </div>
          </div>

          {/* Hidden — click + to show. */}
          <div>
            <div className="mb-2 text-[10px] uppercase tracking-widest text-neutral-500">
              Hidden
            </div>
            <div className="flex flex-wrap gap-2">
              {TRACKING_COLUMNS.filter((c) => !visible.has(c.key)).map((col) => (
                <button
                  key={col.key}
                  type="button"
                  onClick={() => void toggle(col.key)}
                  title={col.hint}
                  className="flex items-center gap-2 border border-neutral-800 px-3 py-1.5 text-[11px] uppercase tracking-widest text-neutral-400 transition-colors hover:border-neutral-500 hover:text-neutral-100"
                >
                  <span aria-hidden className="text-neutral-600">+</span>
                  {col.label}
                </button>
              ))}
              {visible.size === TRACKING_COLUMNS.length && (
                <span className="text-[10px] uppercase tracking-widest text-neutral-600">
                  All columns shown.
                </span>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
