// =============================================================================
//  GoToPalette.tsx
//  Global Cmd/Ctrl+K search palette. Searches across the agency's data and
//  jumps the user to the relevant page on selection. Indexes:
//    * Built-in pages (Dashboard, Tracking, Expenses, Employees, Settings)
//    * Departments
//    * Team members
//    * Expenses (by name)
//    * Reddit accounts (by label)
//
//  Designed as a one-off modal — kept simple, ranking is plain substring
//  matching on a lowercased haystack.
// =============================================================================

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { ROUTES, departmentPath } from '../lib/routes';
import { listDepartments, type Department } from '../lib/departments';
import { listTeamMembers, type TeamMember } from '../lib/teamMembers';
import { listExpenses, type Expense } from '../lib/expenses';
import { listAccounts as listRedditAccounts, type RedditAccount } from '../lib/reddit';

type Item = {
  id: string;
  group: 'Pages' | 'Departments' | 'Team' | 'Expenses' | 'Accounts';
  label: string;
  hint?: string;
  path: string;
};

type Props = {
  open: boolean;
  onClose: () => void;
  // Used to bust the cache when the active agency changes — we don't want
  // the palette showing stale rows from a previously-active agency.
  agencyId: string;
};

export function GoToPalette({ open, onClose, agencyId }: Props) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  // Load + index agency data each time the palette opens. Keeping it lazy
  // avoids pulling tables on every page load — Cmd+K usage is the trigger.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const [departments, members, expenses, accounts]: [
          Department[], TeamMember[], Expense[], RedditAccount[],
        ] = await Promise.all([
          listDepartments(),
          listTeamMembers(),
          listExpenses(),
          listRedditAccounts(),
        ]);
        if (cancelled) return;
        const pages: Item[] = [
          { id: 'p:dashboard',  group: 'Pages', label: 'Dashboard',   path: ROUTES.dashboard },
          { id: 'p:tracking',   group: 'Pages', label: 'Tracking',    path: ROUTES.tracking },
          { id: 'p:expenses',   group: 'Pages', label: 'Expenses',    path: ROUTES.expenses },
          { id: 'p:employees',  group: 'Pages', label: 'Employees',   path: ROUTES.employees },
          { id: 'p:settings',   group: 'Pages', label: 'Settings',    path: ROUTES.settings },
        ];
        const depItems: Item[] = departments.map((d) => ({
          id: `d:${d.id}`,
          group: 'Departments',
          label: d.name,
          hint: d.layout_type === 'models' ? 'Models layout' : 'Marketing layout',
          path: departmentPath(d.id),
        }));
        const memberItems: Item[] = members.map((m) => ({
          id: `m:${m.id}`,
          group: 'Team',
          label: m.name,
          hint: m.role_label ?? undefined,
          path: ROUTES.employees,
        }));
        const expenseItems: Item[] = expenses.map((e) => ({
          id: `e:${e.id}`,
          group: 'Expenses',
          label: e.name,
          hint: e.incurred_on,
          path: ROUTES.expenses,
        }));
        const accountItems: Item[] = accounts.map((a) => ({
          id: `a:${a.id}`,
          group: 'Accounts',
          label: a.label,
          path: ROUTES.dashboard,
        }));
        setItems([
          ...pages,
          ...depItems,
          ...memberItems,
          ...expenseItems,
          ...accountItems,
        ]);
      } catch {
        if (!cancelled) setItems([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, agencyId]);

  // Reset state + focus when opened.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  // Filter items by substring (case-insensitive). Caps the visible list
  // so the palette stays scannable on first open.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = q
      ? items.filter((it) =>
          it.label.toLowerCase().includes(q) || (it.hint?.toLowerCase().includes(q) ?? false),
        )
      : items;
    return rows.slice(0, 30);
  }, [items, query]);

  // Group visible items, preserving the canonical order.
  const groups = useMemo(() => {
    const out = new Map<Item['group'], Item[]>();
    for (const it of filtered) {
      if (!out.has(it.group)) out.set(it.group, []);
      out.get(it.group)!.push(it);
    }
    return Array.from(out.entries());
  }, [filtered]);

  // Lock scroll + keyboard nav while open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((v) => Math.min(filtered.length - 1, v + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((v) => Math.max(0, v - 1));
      } else if (e.key === 'Enter') {
        const pick = filtered[active];
        if (pick) {
          navigate(pick.path);
          onClose();
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [open, filtered, active, navigate, onClose]);

  useEffect(() => { setActive(0); }, [query]);

  if (!open) return null;
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]"
    >
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 flex max-h-[70vh] w-full max-w-xl flex-col border border-neutral-800 bg-neutral-950 shadow-2xl">
        <div className="flex items-center gap-3 border-b border-neutral-900 px-4 py-3">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="text-neutral-500" aria-hidden>
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search pages, departments, team, expenses…"
            className="flex-1 bg-transparent text-sm text-neutral-100 placeholder:text-neutral-600 focus:outline-none"
          />
          <span className="text-[10px] uppercase tracking-widest text-neutral-600">Esc</span>
        </div>

        <div className="flex-1 overflow-y-auto py-2">
          {loading ? (
            <div className="px-4 py-6 text-center text-xs uppercase tracking-widest text-neutral-600">
              Indexing…
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs uppercase tracking-widest text-neutral-600">
              No matches.
            </div>
          ) : (
            <>
              {groups.map(([group, rows]) => (
                <div key={group} className="mb-2 last:mb-0">
                  <div className="px-4 pb-1 pt-3 text-[10px] uppercase tracking-widest text-neutral-600">
                    {group}
                  </div>
                  {rows.map((it) => {
                    const idx = filtered.indexOf(it);
                    const isActive = idx === active;
                    return (
                      <button
                        key={it.id}
                        type="button"
                        onMouseEnter={() => setActive(idx)}
                        onClick={() => {
                          navigate(it.path);
                          onClose();
                        }}
                        className={
                          'flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-sm transition-colors ' +
                          (isActive ? 'bg-neutral-900 text-neutral-50' : 'text-neutral-200 hover:bg-neutral-900')
                        }
                      >
                        <span className="truncate">{it.label}</span>
                        {it.hint && (
                          <span className="ml-3 shrink-0 text-[10px] uppercase tracking-widest text-neutral-600">
                            {it.hint}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))}
            </>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-neutral-900 px-4 py-2 text-[10px] uppercase tracking-widest text-neutral-600">
          <div className="flex items-center gap-3">
            <span><kbd className="border border-neutral-800 px-1">↑</kbd> <kbd className="border border-neutral-800 px-1">↓</kbd> navigate</span>
            <span><kbd className="border border-neutral-800 px-1">↵</kbd> open</span>
          </div>
          <span>{filtered.length} {filtered.length === 1 ? 'result' : 'results'}</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
