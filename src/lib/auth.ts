// =============================================================================
//  auth.ts
//  Wrappers around Supabase Auth + a React hook that exposes the current
//  session reactively.
// =============================================================================

import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';

// -----------------------------------------------------------------------------
//  Sign up — creates a new auth user. The "agency" record itself is created
//  in agency.ts after this returns; we keep auth and tenancy decoupled so this
//  function only does ONE thing.
// -----------------------------------------------------------------------------
export async function signUp(email: string, password: string) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
  });
  if (error) throw error;
  return data;
}

// -----------------------------------------------------------------------------
//  Sign in with email + password.
// -----------------------------------------------------------------------------
export async function signIn(email: string, password: string) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (error) throw error;
  return data;
}

// -----------------------------------------------------------------------------
//  Sign out — clears the session locally and revokes the refresh token on
//  the server.
// -----------------------------------------------------------------------------
export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

// -----------------------------------------------------------------------------
//  Send the password-reset email. Supabase handles the actual email + token.
// -----------------------------------------------------------------------------
export async function requestPasswordReset(email: string) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    // After the user clicks the email link, they land here. The route
    // reads the recovery token from the URL and lets them set a new password.
    redirectTo: `${window.location.origin}/reset-password`,
  });
  if (error) throw error;
}

// -----------------------------------------------------------------------------
//  Update password (called after the user clicks the reset-password link
//  and is in a recovery session).
// -----------------------------------------------------------------------------
export async function updatePassword(newPassword: string) {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw error;
}

// -----------------------------------------------------------------------------
//  React hook: useSession
//
//  Subscribes to Supabase auth state changes and re-renders when the session
//  changes (login, logout, token refresh). Components can call it like:
//
//      const { session, loading } = useSession();
//      if (loading) return <Spinner />;
//      if (!session) return <Login />;
//      return <App />;
// -----------------------------------------------------------------------------
export function useSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // 1. Fetch the current session on mount (may already be cached locally
    //    by Supabase from a previous visit).
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });

    // 2. Subscribe to future auth state changes (sign in, sign out, token refresh).
    const { data: subscription } = supabase.auth.onAuthStateChange(
      (_event, newSession) => {
        setSession(newSession);
      },
    );

    return () => {
      subscription.subscription.unsubscribe();
    };
  }, []);

  return { session, loading };
}
