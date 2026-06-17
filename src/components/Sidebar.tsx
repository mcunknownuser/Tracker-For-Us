// =============================================================================
//  Sidebar.tsx
//  Left-rail navigation for the signed-in app. Editorial dark styling:
//    * Serif wordmark up top
//    * Nav items as small caps with wide tracking
//    * Agency name + sequential number at the bottom
//    * Sign out tucked in the footer
//
//  Renders in two modes:
//    * Desktop (md+) — fixed rail on the left
//    * Mobile — slide-in drawer (controlled by AppLayout via the `mobileOpen`
//      prop) with a translucent backdrop
// =============================================================================

import { NavLink, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { ROUTES, UNIVERSAL_NAV, departmentPath } from '../lib/routes';
import { signOut } from '../lib/auth';
import type { Agency } from '../lib/agency';
import { type Department, listDepartments } from '../lib/departments';

type SidebarProps = {
  agency: Agency;
  // Mobile drawer open state. AppLayout owns it because the hamburger lives
  // in the top bar, but the close button + backdrop here also need to flip
  // it back to false.
  mobileOpen?: boolean;
  onMobileClose?: () => void;
};

export function Sidebar({ agency, mobileOpen = false, onMobileClose }: SidebarProps) {
  const location = useLocation();
  const [departments, setDepartments] = useState<Department[]>([]);

  // Load the agency's departments so we can render them as nav items.
  // Re-runs when prefs change (e.g. someone added/renamed a department).
  useEffect(() => {
    let cancelled = false;
    async function reload() {
      try {
        const d = await listDepartments();
        if (!cancelled) setDepartments(d);
      } catch {
        if (!cancelled) setDepartments([]);
      }
    }
    void reload();
    const handler = () => void reload();
    window.addEventListener('voltrisai:departments-changed', handler);
    return () => {
      cancelled = true;
      window.removeEventListener('voltrisai:departments-changed', handler);
    };
  }, [agency.id]);

  // Auto-close the mobile drawer on route change so the sidebar doesn't
  // remain open on top of the page the user just navigated to.
  useEffect(() => {
    onMobileClose?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  const inner = (
    <>
      <div className="flex items-center justify-between px-6 py-7">
        <NavLink to="/" className="font-serif text-2xl font-bold tracking-tight text-neutral-50">
          Traccr
        </NavLink>
        {/* Mobile-only close affordance */}
        <button
          type="button"
          onClick={onMobileClose}
          aria-label="Close navigation"
          className="md:hidden text-neutral-500 transition-colors hover:text-neutral-100"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <nav className="flex-1 px-3 py-2 overflow-y-auto">
        <ul className="flex flex-col gap-1">
          <NavItem
            path={ROUTES.dashboard}
            label="Dashboard"
            active={location.pathname === '/'}
            tourId="dashboard"
          />

          {departments.length > 0 && (
            <li
              data-tour="departments"
              className="mt-3 px-3 pb-1 text-[10px] uppercase tracking-editorial text-neutral-700"
            >
              Departments
            </li>
          )}
          {departments.map((d) => {
            const path = departmentPath(d.id);
            return (
              <NavItem
                key={d.id}
                path={path}
                label={d.name}
                active={location.pathname === path}
              />
            );
          })}

          <li className="mt-3 px-3 pb-1 text-[10px] uppercase tracking-editorial text-neutral-700">
            Tools
          </li>
          {UNIVERSAL_NAV.map((item) => {
            const isActive =
              location.pathname === item.path ||
              location.pathname.startsWith(item.path + '/');
            return (
              <NavItem
                key={item.path}
                path={item.path}
                label={item.label}
                active={isActive}
                tourId={item.label.toLowerCase()}
              />
            );
          })}

          {/* Settings is the agency-wide control center (departments,
              roles, team, region, labels, appearance). The scoped
              variants (/settings/expenses, /settings/tracking) are
              reached from gear buttons on those specific pages. */}
          <li className="mt-3 px-3 pb-1 text-[10px] uppercase tracking-editorial text-neutral-700">
            Account
          </li>
          <NavItem
            path={ROUTES.settings}
            label="Settings"
            active={location.pathname === ROUTES.settings}
            tourId="settings"
          />
        </ul>
      </nav>

      <div className="border-t border-neutral-900 px-6 py-5">
        <div className="font-serif text-lg font-semibold tracking-tight text-neutral-100">
          {agency.name}
        </div>
        <SignOutButton />
      </div>
    </>
  );

  return (
    <>
      {/* Desktop rail */}
      <aside className="hidden w-[220px] shrink-0 flex-col border-r border-neutral-900 bg-neutral-950 md:flex">
        {inner}
      </aside>

      {/* Mobile drawer + backdrop */}
      <div
        className={
          'fixed inset-0 z-40 md:hidden transition-opacity duration-200 ' +
          (mobileOpen ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0')
        }
        aria-hidden={!mobileOpen}
      >
        <button
          type="button"
          aria-label="Close navigation backdrop"
          onClick={onMobileClose}
          className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        />
        <aside
          className={
            'absolute left-0 top-0 flex h-full w-[260px] flex-col border-r border-neutral-900 bg-neutral-950 shadow-2xl transition-transform duration-200 ' +
            (mobileOpen ? 'translate-x-0' : '-translate-x-full')
          }
        >
          {inner}
        </aside>
      </div>
    </>
  );
}

function NavItem({
  path,
  label,
  active,
  tourId,
}: {
  path: string;
  label: string;
  active: boolean;
  tourId?: string;
}) {
  return (
    <li>
      <NavLink
        to={path}
        data-tour={tourId}
        className={
          'block px-3 py-2.5 text-[11px] font-medium uppercase tracking-widest transition-colors ' +
          (active
            ? 'bg-neutral-900 text-neutral-50'
            : 'text-neutral-500 hover:text-neutral-100')
        }
      >
        {label}
      </NavLink>
    </li>
  );
}

function SignOutButton() {
  const [busy, setBusy] = useState(false);
  return (
    <button
      onClick={async () => {
        if (busy) return;
        setBusy(true);
        await signOut();
      }}
      disabled={busy}
      className="mt-4 text-[10px] uppercase tracking-widest text-neutral-600 transition-colors hover:text-neutral-200 disabled:opacity-50"
    >
      Sign out
    </button>
  );
}
