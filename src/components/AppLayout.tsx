// =============================================================================
//  AppLayout.tsx
//  Layout used by every signed-in page.
//    * Desktop — Sidebar on the left, scrollable content on the right
//    * Mobile  — top bar with hamburger + search; sidebar becomes a drawer
//    * Cmd/Ctrl+K opens the global GoTo palette from anywhere
//  Pages render into the <Outlet />.
// =============================================================================

import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { GoToPalette } from './GoToPalette';
import { SetupGuide } from './SetupGuide';
import type { Agency } from '../lib/agency';

type AppLayoutProps = {
  agency: Agency;
};

export function AppLayout({ agency }: AppLayoutProps) {
  const { pathname } = useLocation();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Cmd+K (Mac) / Ctrl+K (others) opens the global search palette.
  // Esc closes the mobile drawer if it's open (handled inside the drawer).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // h-screen (not min-h-screen) bounds the layout to the viewport so the
  // sidebar can stay put while only the <main> column scrolls. Without
  // this the whole page scrolls and the sidebar moves with it.
  return (
    <div className="flex h-screen bg-neutral-950 text-neutral-100">
      <Sidebar
        agency={agency}
        mobileOpen={mobileNavOpen}
        onMobileClose={() => setMobileNavOpen(false)}
      />

      <div className="flex min-w-0 flex-1 flex-col bg-neutral-950">
        {/* Mobile top bar — hidden on md+ since the sidebar is permanently
            visible there. Holds the hamburger, wordmark, and search. */}
        <header className="flex items-center justify-between border-b border-neutral-900 bg-neutral-950 px-4 py-3 md:hidden">
          <button
            type="button"
            aria-label="Open navigation"
            onClick={() => setMobileNavOpen(true)}
            className="text-neutral-300 transition-colors hover:text-neutral-50"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <span className="font-serif text-lg font-bold tracking-tight text-neutral-50">
            Traccr
          </span>
          <button
            type="button"
            aria-label="Open search"
            onClick={() => setPaletteOpen(true)}
            className="text-neutral-300 transition-colors hover:text-neutral-50"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </button>
        </header>

        <main className="flex-1 overflow-y-auto px-6 py-8 md:px-10 md:py-10">
          {/* Desktop-only search trigger pinned to the top right of the
              content column. Mobile users get the search icon in the top
              bar above. Both routes share the same Cmd+K palette. */}
          <div className="mb-6 hidden justify-end md:flex">
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              className="flex items-center gap-3 border border-neutral-800 bg-neutral-950 px-3 py-1.5 text-xs text-neutral-500 transition-colors hover:border-neutral-600 hover:text-neutral-100"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <span>Search…</span>
              <span className="ml-4 border border-neutral-800 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-neutral-600">
                ⌘ K
              </span>
            </button>
          </div>

          <div key={pathname} className="animate-fade-in-up">
            <Outlet />
          </div>
        </main>
      </div>

      <GoToPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        agencyId={agency.id}
      />

      <SetupGuide agency={agency} />
    </div>
  );
}
