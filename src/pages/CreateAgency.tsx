// =============================================================================
//  CreateAgency.tsx
//  Shown when a user is signed in but has no agency yet. This can happen if:
//    1. They signed up while email confirmation was required (so there was
//       no session at sign-up time, and agency creation was deferred)
//    2. They were invited but the invite acceptance flow hasn't yet
//       created their first agency
//  In either case, this single-field wizard creates the agency and lands
//  them in the app.
// =============================================================================

import { useState } from 'react';
import { AuthLayout } from '../components/AuthLayout';
import { Button, Field, TextLink } from '../components/FormControls';
import { createAgencyForCurrentUser } from '../lib/agency';
import { signOut } from '../lib/auth';
import { toast } from '../lib/toast';

type CreateAgencyProps = {
  // Called after the agency is created so the parent can reload state.
  onCreated: () => void;
};

export function CreateAgency({ onCreated }: CreateAgencyProps) {
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error('Agency name is required.');
      return;
    }
    setSubmitting(true);
    try {
      await createAgencyForCurrentUser(trimmed);
      toast.success(`Welcome, ${trimmed}.`);
      onCreated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create agency.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout
      eyebrow="One last step"
      title="Name your agency."
      subtitle="This is your private workspace. You can rename it later."
    >
      <form onSubmit={handleSubmit} noValidate>
        <Field
          id="agency-name"
          label="Agency name"
          type="text"
          autoComplete="organization"
          required
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Plutus"
        />
        <div className="mt-8">
          <Button type="submit" loading={submitting}>
            Create agency
          </Button>
        </div>
      </form>

      <div className="mt-8 flex items-center justify-between border-t border-neutral-900 pt-6 text-sm">
        <span className="text-neutral-500">Signed in as the wrong account?</span>
        <TextLink onClick={() => signOut()}>Sign out</TextLink>
      </div>
    </AuthLayout>
  );
}
