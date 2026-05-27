// =============================================================================
//  App.tsx
//  Root component. Decides what to show based on auth + agency state:
//    * Reset-password page (URL contains a recovery token)
//    * Auth page (no session)
//    * CreateAgency wizard (session, no agency yet)
//    * Routed app (session + agency)
// =============================================================================

import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useSession } from './lib/auth';
import { useActiveAgency } from './lib/agency';
import { ROUTES } from './lib/routes';
import { applyTheme, getLocalTheme, loadTheme } from './lib/theme';
import { primeLabelsFromLocal, loadLabels } from './lib/labels';
import { primeLocaleFromLocal, loadLocale } from './lib/locale';
import { checkOnStartup as checkForUpdatesOnStartup } from './lib/updater';
import { Auth } from './pages/Auth';
import { ResetPassword } from './pages/ResetPassword';
import { CreateAgency } from './pages/CreateAgency';
import { Dashboard } from './pages/Dashboard';
import { Tracking } from './pages/Tracking';
import { Expenses } from './pages/Expenses';
import { Employees } from './pages/Employees';
import { Settings } from './pages/Settings';
import { DepartmentPage } from './pages/DepartmentPage';
import { AppLayout } from './components/AppLayout';
import { ToastContainer } from './components/ToastContainer';
import { ConfirmContainer } from './components/ConfirmContainer';
import { AcceptInvite } from './pages/AcceptInvite';
import { Onboarding } from './pages/Onboarding';

// Apply the locally-cached theme immediately at module load so we never
// flash the default dark palette before the user's preference kicks in.
// Same idea for labels + locale: prime the in-memory cache from
// localStorage so formatCents() and getLabel() return the user's choices
// on the very first render, instead of momentarily showing USD / "OFM".
if (typeof document !== 'undefined') {
  applyTheme(getLocalTheme());
  primeLabelsFromLocal();
  primeLocaleFromLocal();
}

// Pulls the invite token out of `/invite/<token>` URLs. Returns null on any
// other path. Used before any other routing so the AcceptInvite page renders
// regardless of session/agency state.
function inviteTokenFromUrl(): string | null {
  const m = window.location.pathname.match(/^\/invite\/(.+)$/);
  return m ? decodeURIComponent(m[1]!) : null;
}

export default function App() {
  // Kick off the auto-updater check once when the app first mounts.
  // No-ops in the browser; in Tauri it pings the configured endpoint
  // and shows a confirm dialog if a newer version is available.
  useEffect(() => {
    checkForUpdatesOnStartup();
  }, []);

  // Invite landing pages come BEFORE auth checks — the token is the access
  // control. The AcceptInvite page handles its own signed-in/out branches.
  const [inviteToken, setInviteToken] = useState<string | null>(() =>
    inviteTokenFromUrl(),
  );

  useEffect(() => {
    const onPop = () => setInviteToken(inviteTokenFromUrl());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Detect Supabase's recovery flow: the URL hash will contain
  // `type=recovery` after the user clicks the reset email link.
  const [isRecovery, setIsRecovery] = useState(() =>
    window.location.hash.includes('type=recovery'),
  );

  useEffect(() => {
    const onHashChange = () =>
      setIsRecovery(window.location.hash.includes('type=recovery'));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const { session, loading: sessionLoading } = useSession();

  // Once signed in, pull synced prefs (theme, labels, currency) and apply
  // if they differ from the local cache (e.g. user changed them on another
  // device). Labels + locale are reloaded into the in-memory cache so
  // subsequent renders pick up the latest values.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    void (async () => {
      const [theme] = await Promise.all([loadTheme(), loadLabels(), loadLocale()]);
      if (!cancelled) applyTheme(theme);
    })();
    const onPrefsChanged = () => {
      void (async () => {
        const [theme] = await Promise.all([loadTheme(), loadLabels(), loadLocale()]);
        if (!cancelled) applyTheme(theme);
      })();
    };
    window.addEventListener('voltrisai:prefs-changed', onPrefsChanged);
    return () => {
      cancelled = true;
      window.removeEventListener('voltrisai:prefs-changed', onPrefsChanged);
    };
  }, [session]);

  if (inviteToken) {
    return (
      <>
        <AcceptInvite token={inviteToken} />
        <ToastContainer />
        <ConfirmContainer />
      </>
    );
  }

  if (isRecovery) {
    return (
      <>
        <ResetPassword />
        <ToastContainer />
        <ConfirmContainer />
      </>
    );
  }

  if (sessionLoading) {
    return (
      <>
        <Splash />
        <ToastContainer />
        <ConfirmContainer />
      </>
    );
  }

  if (!session) {
    return (
      <>
        <Auth />
        <ToastContainer />
        <ConfirmContainer />
      </>
    );
  }

  return (
    <>
      <SignedInApp userId={session.user.id} />
      <ToastContainer />
      <ConfirmContainer />
    </>
  );
}

// -----------------------------------------------------------------------------
//  SignedInApp — resolves the active agency, then chooses one of:
//    * CreateAgency wizard       (user has no agency yet)
//    * Onboarding first-run flow (owner of an agency that hasn't finished setup)
//    * Routed app shell          (everyone else)
// -----------------------------------------------------------------------------
function SignedInApp({ userId }: { userId: string }) {
  const { agency, loading, error, refresh } = useActiveAgency();

  if (loading) return <Splash />;

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-950 p-6 text-center">
        <div>
          <h1 className="font-serif text-3xl font-semibold text-neutral-100">
            Could not load your agency.
          </h1>
          <p className="mt-4 max-w-md text-sm text-neutral-400">{error.message}</p>
        </div>
      </div>
    );
  }

  if (!agency) {
    return <CreateAgency onCreated={() => window.location.reload()} />;
  }

  // First-run wizard: only show to the agency owner, and only until they
  // finish it. Non-owners (invited staff) skip straight to the routed app.
  const isOwner = agency.owner_user_id === userId;
  if (isOwner && !agency.onboarding_completed_at) {
    return <Onboarding agency={agency} onComplete={refresh} />;
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppLayout agency={agency} />}>
          <Route path={ROUTES.dashboard} element={<Dashboard />} />
          {/* Dynamic per-department pages. The wrapper picks the layout. */}
          <Route path={ROUTES.department + '/:id'} element={<DepartmentPage />} />
          {/* Legacy: old bookmarks land on the dashboard. */}
          <Route path={ROUTES.ofm}       element={<Navigate to={ROUTES.dashboard} replace />} />
          <Route path={ROUTES.reddit}    element={<Navigate to={ROUTES.dashboard} replace />} />
          <Route path={ROUTES.tracking}  element={<Tracking />} />
          <Route path={ROUTES.expenses}  element={<Expenses />} />
          <Route path={ROUTES.employees} element={<Employees />} />
          <Route path={ROUTES.settings}         element={<Settings />} />
          <Route path={ROUTES.settingsExpenses} element={<Settings scope="expenses" />} />
          <Route path={ROUTES.settingsTracking} element={<Settings scope="tracking" />} />
          {/* Anything unrecognized goes back to the dashboard. */}
          <Route path="*" element={<Navigate to={ROUTES.dashboard} replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

// -----------------------------------------------------------------------------
//  Splash — brief wordmark while we resolve session / agency state.
// -----------------------------------------------------------------------------
function Splash() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-950">
      <div className="font-serif text-3xl font-semibold tracking-tight text-neutral-100">
        VoltrisAi
      </div>
    </div>
  );
}
