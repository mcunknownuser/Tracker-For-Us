// =============================================================================
//  Auth.tsx
//  Single page that toggles between three modes:
//    * sign-in    — existing user enters email + password
//    * sign-up    — new user enters email + password + agency name
//    * forgot     — request a password reset email
//
//  After successful sign-up we immediately call createAgencyForCurrentUser()
//  so the new user has an agency to land in. After successful sign-in we
//  rely on the parent App to redirect (because useSession() will update).
// =============================================================================

import { useState } from 'react';
import { AuthLayout } from '../components/AuthLayout';
import { Modal } from '../components/Modal';
import { Button, Field, TextLink } from '../components/FormControls';
import { signIn, signUp, requestPasswordReset } from '../lib/auth';
import { toast } from '../lib/toast';
import {
  type Theme,
  THEMES,
  applyTheme,
  getLocalTheme,
  saveTheme,
  setLocalTheme,
} from '../lib/theme';

type Mode = 'sign-in' | 'sign-up' | 'forgot';

// localStorage flag so the beta notice only pops up on a user's very
// first visit. Once they click OK we stamp the device and never bug
// them again (per browser/install).
const BETA_NOTICE_KEY = 'voltrisai.beta-notice-acknowledged';

export function Auth() {
  const [mode, setMode] = useState<Mode>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Theme is previewed live as the user picks. Defaults to whatever is
  // already cached locally (so a returning visitor stays in their theme).
  const [theme, setTheme] = useState<Theme>(() => getLocalTheme());
  // Beta-phase notice. Shown only on first visit per device.
  const [betaNoticeOpen, setBetaNoticeOpen] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(BETA_NOTICE_KEY) !== '1';
  });
  function dismissBetaNotice() {
    try {
      window.localStorage.setItem(BETA_NOTICE_KEY, '1');
    } catch { /* private mode etc. */ }
    setBetaNoticeOpen(false);
  }

  function pickTheme(next: Theme) {
    setTheme(next);
    applyTheme(next);
    // Persist locally right away so even if the user bails before submitting,
    // their next visit lands in the theme they preferred.
    setLocalTheme(next);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      if (mode === 'sign-in') {
        await signIn(email.trim(), password);
        // The session listener in App.tsx will take over from here.
      } else if (mode === 'sign-up') {
        await signUp(email.trim(), password);
        // Save the picked theme to synced prefs (if we have a session). If
        // email confirmation is required, the session won't be active yet
        // and saveTheme will silently no-op until the user signs in.
        try {
          await saveTheme(theme);
        } catch (themeErr) {
          console.warn('Theme save deferred:', themeErr);
        }
        // App.tsx will route us to either:
        //   * the CreateAgency screen (session active, no agency yet)
        //   * the auth page with a confirm-email toast (no session yet)
        toast.success('Account created.');
      } else {
        await requestPasswordReset(email.trim());
        toast.success('Reset link sent. Check your email.');
        setMode('sign-in');
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Something went wrong.';
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  // Mode-specific copy.
  const meta =
    mode === 'sign-in'
      ? {
          eyebrow: 'Sign in',
          title: 'Welcome back.',
          subtitle: 'Enter your credentials to access your agency.',
          cta: 'Sign in',
        }
      : mode === 'sign-up'
        ? {
            eyebrow: 'Create account',
            title: 'Create your account.',
            subtitle:
              "Just an email and password to start. You'll name your agency on the next screen.",
            cta: 'Create account',
          }
        : {
            eyebrow: 'Forgot password',
            title: 'Reset your password.',
            subtitle: 'We’ll send a secure link to your email.',
            cta: 'Send reset link',
          };

  return (
    <>
    <Modal
      open={betaNoticeOpen}
      onClose={() => { /* OK is the only exit — we ignore backdrop/esc */ }}
      eyebrow="Beta phase"
      title="Welcome to the beta."
      maxWidth="max-w-md"
    >
      <p className="text-sm leading-relaxed text-neutral-300">
        VoltrisAi is in active beta. Things are stable enough for daily use,
        but you may notice the occasional rough edge while we polish.
      </p>
      <p className="mt-3 text-sm leading-relaxed text-neutral-400">
        Your data is real and persists — back up anything critical
        elsewhere as a safety net, and let us know if anything breaks.
      </p>
      <div className="mt-7">
        <Button type="button" onClick={dismissBetaNotice}>
          OK, got it
        </Button>
      </div>
    </Modal>

    <AuthLayout
      eyebrow={meta.eyebrow}
      title={meta.title}
      subtitle={meta.subtitle}
    >
      {/* Re-key on mode so the form fades in cleanly when switching
          between sign-in / sign-up / forgot. */}
      <form key={mode} onSubmit={handleSubmit} noValidate className="animate-fade-in-up">
        <Field
          id="email"
          label="Email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@youragency.com"
        />

        {mode !== 'forgot' && (
          <Field
            id="password"
            label="Password"
            type="password"
            autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••••"
            minLength={8}
          />
        )}


        {mode === 'sign-up' && (
          <div className="mb-5">
            <div className="mb-2 block text-[10px] font-medium uppercase tracking-widest text-neutral-500">
              Appearance
            </div>
            <p className="mb-3 text-xs text-neutral-500">
              Tap to preview. You can change this any time in Settings.
            </p>
            <div className="flex flex-wrap gap-2">
              {THEMES.map((t) => {
                const selected = theme === t.value;
                return (
                  <button
                    key={t.value}
                    type="button"
                    onClick={() => pickTheme(t.value)}
                    title={t.hint}
                    className={
                      'flex items-center gap-2 border px-3 py-1.5 text-[11px] uppercase tracking-widest transition-colors ' +
                      (selected
                        ? 'border-neutral-50 bg-neutral-50 text-neutral-950'
                        : 'border-neutral-800 bg-transparent text-neutral-300 hover:border-neutral-500 hover:text-neutral-100')
                    }
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="mt-8">
          <Button type="submit" loading={submitting}>
            {meta.cta}
          </Button>
        </div>
      </form>

      {/* Mode switchers */}
      <div className="mt-8 flex flex-col gap-3 border-t border-neutral-900 pt-6">
        {mode === 'sign-in' && (
          <>
            <div className="flex items-center justify-between text-sm">
              <span className="text-neutral-500">No account yet?</span>
              <TextLink onClick={() => setMode('sign-up')}>Create one</TextLink>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-neutral-500">Forgot your password?</span>
              <TextLink onClick={() => setMode('forgot')}>Reset it</TextLink>
            </div>
          </>
        )}
        {mode === 'sign-up' && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-neutral-500">Already have an account?</span>
            <TextLink onClick={() => setMode('sign-in')}>Sign in</TextLink>
          </div>
        )}
        {mode === 'forgot' && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-neutral-500">Back to</span>
            <TextLink onClick={() => setMode('sign-in')}>Sign in</TextLink>
          </div>
        )}
      </div>
    </AuthLayout>
    </>
  );
}
