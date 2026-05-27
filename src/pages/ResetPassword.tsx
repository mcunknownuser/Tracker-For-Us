// =============================================================================
//  ResetPassword.tsx
//  Landing page after clicking the password-reset link in email.
//  Supabase puts the user into a "recovery" session automatically; we just
//  need to take a new password and call updatePassword().
// =============================================================================

import { useState } from 'react';
import { AuthLayout } from '../components/AuthLayout';
import { Button, Field } from '../components/FormControls';
import { updatePassword } from '../lib/auth';
import { toast } from '../lib/toast';

export function ResetPassword() {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    if (password !== confirm) {
      toast.error('Passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      await updatePassword(password);
      toast.success('Password updated.');
      setDone(true);
      // The session is now a normal one; App.tsx will show the dashboard.
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update password.');
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <AuthLayout
        eyebrow="All set"
        title="Password updated."
        subtitle="You are now signed in. Redirecting to your dashboard..."
      >
        <div />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      eyebrow="Reset password"
      title="Set a new password."
      subtitle="Choose something strong. Minimum 8 characters."
    >
      <form onSubmit={handleSubmit} noValidate>
        <Field
          id="new-password"
          label="New password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••••"
        />
        <Field
          id="confirm-password"
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="••••••••••"
        />
        <div className="mt-8">
          <Button type="submit" loading={submitting}>
            Update password
          </Button>
        </div>
      </form>
    </AuthLayout>
  );
}
