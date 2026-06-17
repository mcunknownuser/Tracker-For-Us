// =============================================================================
//  InvitePanel.tsx
//  Self-contained UI for managing teammate invites: an inline create form
//  + a list of all invites with copy / regenerate / cancel actions.
//
//  Used in two places:
//    * Settings -> Team & invites section (inline)
//    * Employees page -> "Invite teammates" modal (in a Modal wrapper)
//
//  Assumes the caller has already confirmed the user is an admin/owner —
//  RLS would still block non-admins, but the inline UI doesn't gate itself.
// =============================================================================

import { useEffect, useMemo, useState } from 'react';
import {
  type AgencyRole,
  type InviteWithStatus,
  buildInviteUrl,
  cancelInvite,
  createInvite,
  listInvites,
  regenerateInvite,
} from '../lib/invites';
import { type Department, listDepartments } from '../lib/departments';
import { type StaffRole, listStaffRoles } from '../lib/staffRoles';
import { toast } from '../lib/toast';
import { confirm } from '../lib/confirm';

export function InvitePanel({ agencyId }: { agencyId: string }) {
  const [invites, setInvites] = useState<InviteWithStatus[] | null>(null);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [staffRoles, setStaffRoles] = useState<StaffRole[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);

  // Look up table: role_id -> "Department · Role". Used everywhere we
  // render a position label.
  const roleLabel = useMemo(() => {
    const deptName = new Map(departments.map((d) => [d.id, d.name]));
    const map = new Map<string, string>();
    for (const r of staffRoles) {
      const dept = deptName.get(r.department_id) ?? 'Unknown';
      map.set(r.id, `${dept} · ${r.name}`);
    }
    return map;
  }, [departments, staffRoles]);

  async function reload() {
    try {
      const rows = await listInvites(agencyId);
      setInvites(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load invites.');
    }
  }

  useEffect(() => {
    void reload();
    // Departments + staff_roles are agency-scoped via RLS; no agencyId arg
    // needed on the calls themselves.
    void (async () => {
      try {
        const [d, r] = await Promise.all([listDepartments(), listStaffRoles()]);
        setDepartments(d);
        setStaffRoles(r);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load positions.');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agencyId]);

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    if (sending) return;
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) {
      toast.error('Enter an email.');
      return;
    }
    setSending(true);
    try {
      // Everyone is invited as an admin so they get the same access as the
      // rest of the team. No staff role / position to assign.
      const created = await createInvite(agencyId, trimmed, 'admin', null);
      setEmail('');
      // Reload BEFORE the clipboard attempt so the new invite is visible
      // even if the auto-copy is blocked by the browser.
      await reload();

      // Best-effort auto-copy. Safari often rejects clipboard writes once
      // an `await` has run after the user gesture; in that case the user
      // just hits the explicit "Copy link" button on the row below.
      let copied = false;
      try {
        await copyToClipboard(buildInviteUrl(created.token));
        copied = true;
      } catch {
        /* fall through to the non-copied toast */
      }
      toast.success(
        copied
          ? 'Invite created. Link copied to clipboard.'
          : 'Invite created. Use the Copy link button to share it.',
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not invite.');
    } finally {
      setSending(false);
    }
  }

  async function handleCopy(inv: InviteWithStatus) {
    try {
      await copyToClipboard(buildInviteUrl(inv.token));
      toast.success('Link copied.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not copy link.');
    }
  }

  async function handleRegenerate(inv: InviteWithStatus) {
    try {
      const fresh = await regenerateInvite(inv.id);
      await copyToClipboard(buildInviteUrl(fresh.token));
      toast.success('New link generated and copied.');
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not regenerate.');
    }
  }

  async function handleCancel(inv: InviteWithStatus) {
    const ok = await confirm({
      title: `Cancel invite to ${inv.email}?`,
      message: 'The link will stop working immediately.',
      destructive: true,
      confirmLabel: 'Cancel invite',
    });
    if (!ok) return;
    try {
      await cancelInvite(inv.id);
      toast.success('Invite cancelled.');
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not cancel.');
    }
  }

  return (
    <div>
      {error && (
        <div className="mb-4 border border-red-900/60 bg-red-950/30 p-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {/* Create form */}
      <form
        onSubmit={handleInvite}
        className="mb-6 flex flex-col gap-3 border border-neutral-800 bg-neutral-950 p-4"
      >
        <div className="flex flex-col gap-3 md:flex-row md:items-end">
          <div className="flex-1">
            <div className="mb-2 text-[10px] uppercase tracking-widest text-neutral-500">
              Email
            </div>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="teammate@example.com"
              className="block w-full border border-neutral-800 bg-transparent px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
            />
          </div>
          <div>
            <div className="mb-2 text-[10px] uppercase tracking-widest text-neutral-500">
              Role
            </div>
            <div className="border border-neutral-50 bg-neutral-50 px-3 py-2 text-center text-[11px] uppercase tracking-widest text-neutral-950">
              Admin
            </div>
          </div>
        </div>

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={sending}
            className="border border-neutral-700 bg-transparent px-4 py-2 text-[11px] font-medium uppercase tracking-widest text-neutral-200 transition-colors hover:border-neutral-500 disabled:opacity-50"
          >
            {sending ? 'Sending…' : 'Create invite'}
          </button>
        </div>
      </form>

      {/* List */}
      {invites === null ? (
        <div className="flex h-24 items-center justify-center border border-dashed border-neutral-800 text-xs uppercase tracking-widest text-neutral-700">
          Loading…
        </div>
      ) : invites.length === 0 ? (
        <div className="flex h-24 items-center justify-center border border-dashed border-neutral-800 text-xs uppercase tracking-widest text-neutral-700">
          No invites yet.
        </div>
      ) : (
        <div className="divide-y divide-neutral-900 border border-neutral-900">
          {invites.map((inv) => (
            <InviteRow
              key={inv.id}
              invite={inv}
              url={buildInviteUrl(inv.token)}
              positionLabel={
                inv.staff_role_id ? roleLabel.get(inv.staff_role_id) ?? null : null
              }
              onCopy={() => void handleCopy(inv)}
              onRegenerate={() => void handleRegenerate(inv)}
              onCancel={() => void handleCancel(inv)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function InviteRow({
  invite,
  url,
  positionLabel,
  onCopy,
  onRegenerate,
  onCancel,
}: {
  invite: InviteWithStatus;
  url: string;
  positionLabel: string | null;
  onCopy: () => void;
  onRegenerate: () => void;
  onCancel: () => void;
}) {
  const isPending = invite.status === 'pending';
  return (
    <div className="flex flex-col gap-3 bg-neutral-950 p-4 md:flex-row md:items-center md:justify-between">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-serif text-base text-neutral-100">
            {invite.email}
          </span>
          <StatusBadge status={invite.status} />
          <RoleBadge role={invite.role} />
          {positionLabel && (
            <span className="border border-neutral-800 px-1.5 py-0.5 text-[9px] uppercase tracking-widest text-neutral-400">
              {positionLabel}
            </span>
          )}
        </div>
        <div className="mt-1 text-[10px] uppercase tracking-widest text-neutral-600">
          {invite.status === 'pending' && <>Expires {formatRel(invite.expires_at)}</>}
          {invite.status === 'expired' && <>Expired {formatRel(invite.expires_at)}</>}
          {invite.status === 'accepted' && invite.accepted_at && (
            <>Joined {formatRel(invite.accepted_at)}</>
          )}
        </div>
        {/* Fallback: show the full URL so the user can select-and-copy
            manually if the browser blocks clipboard writes. Only for
            pending invites — expired/accepted tokens are dead. */}
        {isPending && (
          <input
            type="text"
            readOnly
            value={url}
            onFocus={(e) => e.currentTarget.select()}
            onClick={(e) => e.currentTarget.select()}
            className="mt-2 block w-full select-all border border-neutral-800 bg-transparent px-2 py-1 font-mono text-[10px] text-neutral-500 focus:border-neutral-500 focus:outline-none"
          />
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {isPending && (
          <button
            type="button"
            onClick={onCopy}
            className="border border-neutral-800 px-3 py-1.5 text-[10px] uppercase tracking-widest text-neutral-300 transition-colors hover:border-neutral-500 hover:text-neutral-100"
          >
            Copy link
          </button>
        )}
        {invite.status !== 'accepted' && (
          <button
            type="button"
            onClick={onRegenerate}
            className="border border-neutral-800 px-3 py-1.5 text-[10px] uppercase tracking-widest text-neutral-300 transition-colors hover:border-neutral-500 hover:text-neutral-100"
          >
            New link
          </button>
        )}
        {invite.status !== 'accepted' && (
          <button
            type="button"
            onClick={onCancel}
            className="border border-neutral-800 px-3 py-1.5 text-[10px] uppercase tracking-widest text-neutral-500 transition-colors hover:border-neutral-600 hover:text-neutral-300"
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: InviteWithStatus['status'] }) {
  const map: Record<InviteWithStatus['status'], string> = {
    pending:  'border-neutral-700 text-neutral-300',
    expired:  'border-neutral-800 text-neutral-600',
    accepted: 'border-neutral-700 text-neutral-200',
  };
  return (
    <span
      className={
        'border px-1.5 py-0.5 text-[9px] uppercase tracking-widest ' + map[status]
      }
    >
      {status}
    </span>
  );
}

function RoleBadge({ role }: { role: AgencyRole }) {
  return (
    <span className="border border-neutral-800 px-1.5 py-0.5 text-[9px] uppercase tracking-widest text-neutral-500">
      {role}
    </span>
  );
}

function formatRel(iso: string): string {
  const d = new Date(iso);
  const diffMs = d.getTime() - Date.now();
  const absMin = Math.round(Math.abs(diffMs) / 60_000);
  const inPast = diffMs < 0;
  if (absMin < 60) return inPast ? `${absMin}m ago` : `in ${absMin}m`;
  const absHr = Math.round(absMin / 60);
  if (absHr < 24) return inPast ? `${absHr}h ago` : `in ${absHr}h`;
  const absDay = Math.round(absHr / 24);
  return inPast ? `${absDay}d ago` : `in ${absDay}d`;
}

async function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
}
