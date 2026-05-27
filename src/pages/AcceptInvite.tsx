// =============================================================================
//  AcceptInvite.tsx
//  Landing page for the /invite/:token URL. Two flows:
//
//    1. User is signed in:
//         - If their email matches the invite, they see "Join {agency}?".
//         - Click → accept_agency_invite RPC → switch to that agency.
//
//    2. User is signed out:
//         - We show the invite preview with the email pre-filled and offer
//           sign-in or sign-up. After auth, we auto-call accept.
//
//  We never gate /invite/:token behind auth at the router level — the token
//  itself is the access control (peek_agency_invite is grant-execute to anon).
// =============================================================================

import { useEffect, useMemo, useRef, useState } from 'react';
import { AuthLayout } from '../components/AuthLayout';
import { Button, Field, TextLink } from '../components/FormControls';
import {
  type InvitePeek,
  acceptInvite,
  peekInvite,
} from '../lib/invites';
import { setActiveAgencyId } from '../lib/agency';
import { signIn, signUp, useSession } from '../lib/auth';
import { supabase } from '../lib/supabase';
import { toast } from '../lib/toast';

type Mode = 'sign-in' | 'sign-up';

export function AcceptInvite({ token }: { token: string }) {
  const { session, loading: sessionLoading } = useSession();

  const [peek, setPeek] = useState<InvitePeek | null>(null);
  const [peekErr, setPeekErr] = useState<string | null>(null);
  const [peekLoading, setPeekLoading] = useState(true);

  // Auth form state (used only on the signed-out path).
  const [mode, setMode] = useState<Mode>('sign-up');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Acceptance state (signed-in path or post-auth).
  const [accepting, setAccepting] = useState(false);
  const acceptedRef = useRef(false);

  // Peek the invite once on mount. The token is the access control here
  // — peek_agency_invite is grant-execute to anon.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const p = await peekInvite(token);
        if (cancelled) return;
        if (!p) setPeekErr('This invite link is invalid or has been revoked.');
        else if (p.accepted) setPeekErr('This invite has already been used.');
        else if (new Date(p.expires_at).getTime() <= Date.now())
          setPeekErr('This invite has expired. Ask the admin to send a new one.');
        else setPeek(p);
      } catch (err) {
        if (!cancelled) {
          setPeekErr(err instanceof Error ? err.message : 'Could not load invite.');
        }
      } finally {
        if (!cancelled) setPeekLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // Match status — drives which UI we show when signed in.
  const emailMismatch = useMemo(() => {
    if (!peek || !session) return false;
    return (
      (session.user.email ?? '').toLowerCase() !== peek.email.toLowerCase()
    );
  }, [peek, session]);

  async function joinNow() {
    if (!peek || acceptedRef.current) return;
    acceptedRef.current = true;
    setAccepting(true);
    try {
      const agencyId = await acceptInvite(token);
      setActiveAgencyId(agencyId);
      toast.success(`Joined ${peek.agency_name}.`);
      // Hard reload so App.tsx re-resolves session + agency cleanly.
      window.location.assign('/');
    } catch (err) {
      acceptedRef.current = false;
      setAccepting(false);
      toast.error(err instanceof Error ? err.message : 'Could not accept invite.');
    }
  }

  async function handleAuthSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!peek || submitting) return;
    setSubmitting(true);
    try {
      if (mode === 'sign-up') {
        await signUp(peek.email, password);
      } else {
        await signIn(peek.email, password);
      }
      // We need the new session to be in place before calling accept.
      // signIn populates it synchronously; signUp's session arrives after
      // a tick (or after email confirmation if it's required).
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        toast.info('Check your email to confirm your account, then click the invite link again.');
        return;
      }
      await joinNow();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Authentication failed.');
    } finally {
      setSubmitting(false);
    }
  }

  // ----- render branches -----------------------------------------------------

  if (peekLoading || sessionLoading) {
    return (
      <AuthLayout eyebrow="Invite" title="Loading…">
        <p className="text-sm text-neutral-500">One moment.</p>
      </AuthLayout>
    );
  }

  if (peekErr || !peek) {
    return (
      <AuthLayout eyebrow="Invite" title="Link not usable">
        <p className="text-sm text-neutral-300">
          {peekErr ?? 'Unknown error.'}
        </p>
        <div className="mt-8">
          <TextLink onClick={() => window.location.assign('/')}>
            Back to sign in
          </TextLink>
        </div>
      </AuthLayout>
    );
  }

  // Signed in, wrong email.
  if (session && emailMismatch) {
    return (
      <AuthLayout
        eyebrow="Invite"
        title={`Join ${peek.agency_name}`}
        subtitle={`This invite was sent to ${peek.email}. You're signed in as ${session.user.email}.`}
      >
        <p className="text-sm text-neutral-300">
          Sign out and sign back in with <strong className="text-neutral-100">{peek.email}</strong> to accept.
        </p>
        <div className="mt-8">
          <Button
            onClick={async () => {
              await supabase.auth.signOut();
              window.location.reload();
            }}
          >
            Sign out
          </Button>
        </div>
      </AuthLayout>
    );
  }

  // Signed in, email matches → one-click accept.
  if (session) {
    return (
      <AuthLayout
        eyebrow="Invite"
        title={`Join ${peek.agency_name}`}
        subtitle={inviteSubtitle(peek, 'click below to accept')}
      >
        <Button onClick={joinNow} loading={accepting}>
          Accept &amp; join
        </Button>
        <p className="mt-4 text-xs text-neutral-600">
          Invited as {peek.email}.
        </p>
      </AuthLayout>
    );
  }

  // Signed out → sign in / sign up with the invited email pre-filled.
  return (
    <AuthLayout
      eyebrow="Invite"
      title={`Join ${peek.agency_name}`}
      subtitle={inviteSubtitle(
        peek,
        mode === 'sign-up' ? 'create a password to join' : 'sign in to accept',
      )}
    >
      <form onSubmit={handleAuthSubmit} noValidate>
        <Field
          id="invite-email"
          label="Email"
          type="email"
          value={peek.email}
          onChange={() => undefined}
          readOnly
          autoComplete="email"
        />
        <Field
          id="invite-password"
          label="Password"
          type="password"
          autoComplete={mode === 'sign-up' ? 'new-password' : 'current-password'}
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••••"
          minLength={8}
        />

        <div className="mt-8">
          <Button type="submit" loading={submitting}>
            {mode === 'sign-up' ? 'Create account & join' : 'Sign in & join'}
          </Button>
        </div>
      </form>

      <div className="mt-8 flex flex-col gap-3 border-t border-neutral-900 pt-6 text-sm">
        {mode === 'sign-up' ? (
          <div className="flex items-center justify-between">
            <span className="text-neutral-500">Already have an account?</span>
            <TextLink onClick={() => setMode('sign-in')}>Sign in</TextLink>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <span className="text-neutral-500">No account yet?</span>
            <TextLink onClick={() => setMode('sign-up')}>Create one</TextLink>
          </div>
        )}
      </div>
    </AuthLayout>
  );
}

// Build a friendly subtitle that surfaces the position if there is one.
// Examples:
//   "You've been invited as an admin. Sign in to accept."
//   "You've been invited as a Chatter in OFM. Click below to accept."
function inviteSubtitle(peek: InvitePeek, suffix: string): string {
  const what =
    peek.invite_role === 'admin'
      ? 'an admin'
      : peek.staff_role_name
        ? `a ${peek.staff_role_name}${peek.department_name ? ` in ${peek.department_name}` : ''}`
        : 'a staff member';
  const cap = suffix.charAt(0).toUpperCase() + suffix.slice(1);
  return `You've been invited as ${what}. ${cap}.`;
}
