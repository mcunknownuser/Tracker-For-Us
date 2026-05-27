// =============================================================================
//  AuthLayout.tsx
//  Centered editorial-style layout for pre-auth pages (sign in, sign up,
//  reset password). Pure black background, generous spacing, serif wordmark.
// =============================================================================

import type { ReactNode } from 'react';

type AuthLayoutProps = {
  children: ReactNode;
  // Subtitle shown in small caps above the form (e.g. "SIGN IN", "CREATE ACCOUNT")
  eyebrow?: string;
  // Title in serif font ("Welcome", "Set a new password")
  title: string;
  // Optional supporting copy below the title
  subtitle?: string;
};

export function AuthLayout({ children, eyebrow, title, subtitle }: AuthLayoutProps) {
  return (
    <div className="flex min-h-screen flex-col bg-neutral-950 text-neutral-100">
      {/* Brand bar */}
      <header className="px-8 py-8">
        <div className="font-serif text-2xl font-bold tracking-tight">
          VoltrisAi
        </div>
      </header>

      {/* Centered content */}
      <main className="flex flex-1 items-center justify-center px-6 py-10">
        <div className="w-full max-w-[420px]">
          {/* Re-key on the title so swapping between sign-in / sign-up / etc
              fades in the new copy instead of snapping. */}
          <div key={title} className="animate-fade-in-up">
            {eyebrow && (
              <div className="mb-6 text-[11px] font-medium uppercase tracking-editorial text-neutral-500">
                {eyebrow}
              </div>
            )}
            <h1 className="font-serif text-4xl font-semibold leading-tight tracking-tight text-neutral-50">
              {title}
            </h1>
            {subtitle && (
              <p className="mt-3 text-sm leading-relaxed text-neutral-400">
                {subtitle}
              </p>
            )}
          </div>
          <div className="mt-10">{children}</div>
        </div>
      </main>

      {/* Footer */}
      <footer className="px-8 py-6 text-[11px] uppercase tracking-widest text-neutral-600">
        &copy; {new Date().getFullYear()} VoltrisAi
      </footer>
    </div>
  );
}
