import { createClient } from '@supabase/supabase-js';

// Read credentials from .env.local at build time.
// Vite injects these as compile-time constants — they're embedded in the
// bundle, so the anon key is visible to anyone who inspects the JS. That's
// fine — the anon key is meant to be public, and RLS protects the data.
//
// Never put the SERVICE_ROLE key in .env.local. That key bypasses RLS
// and must only live in server-side Edge Functions.

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!url || !key || url.includes('PASTE_') || key.includes('PASTE_')) {
  throw new Error(
    'Missing Supabase credentials. Open .env.local and replace the placeholders ' +
      'with your project URL and anon public key from Supabase dashboard -> Settings -> API.',
  );
}

export const supabase = createClient(url, key, {
  auth: {
    // Keep the user logged in across page reloads.
    persistSession: true,
    // Refresh the access token automatically before it expires.
    autoRefreshToken: true,
    // Read the session from the URL on auth callback (magic links, OAuth).
    detectSessionInUrl: true,
  },
});
