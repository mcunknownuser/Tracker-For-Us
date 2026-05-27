// =============================================================================
//  FormControls.tsx
//  Tiny set of form primitives styled for the editorial dark theme.
//  Sharp corners, thin borders, no rounded "AI bubble" aesthetic.
// =============================================================================

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { forwardRef } from 'react';

// -----------------------------------------------------------------------------
//  Label — small caps, wide tracking, muted gray.
// -----------------------------------------------------------------------------
export function Label({
  htmlFor,
  children,
}: {
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className="mb-2 block text-[11px] font-medium uppercase tracking-widest text-neutral-500"
    >
      {children}
    </label>
  );
}

// -----------------------------------------------------------------------------
//  Input — thin border, transparent bg, neutral focus ring.
//  Uses forwardRef so the parent can imperatively focus it.
// -----------------------------------------------------------------------------
type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className = '', ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      // Strong, visible focus + hover so the user always knows which
      // field they're typing in. Replaces the previous near-invisible
      // border-only state. `outline-none` is intentionally kept (we
      // draw our own ring) and `focus-visible:` ensures keyboard users
      // see the ring without mouse users getting it on every click.
      className={
        'block w-full border bg-neutral-950 px-3.5 py-3 text-sm text-neutral-100 caret-neutral-100 ' +
        'placeholder:text-neutral-600 ' +
        'border-neutral-800 hover:border-neutral-700 ' +
        'focus:outline-none focus:border-neutral-300 focus:ring-1 focus:ring-neutral-300 ' +
        'transition-colors ' +
        className
      }
      {...rest}
    />
  );
});

// -----------------------------------------------------------------------------
//  Field — Label + Input wrapper to keep spacing consistent.
// -----------------------------------------------------------------------------
type FieldProps = {
  id: string;
  label: string;
  hint?: string;
} & InputHTMLAttributes<HTMLInputElement>;

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { id, label, hint, ...rest },
  ref,
) {
  return (
    <div className="mb-5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} ref={ref} {...rest} />
      {hint && <p className="mt-1.5 text-xs text-neutral-500">{hint}</p>}
    </div>
  );
});

// -----------------------------------------------------------------------------
//  Button — primary action, white-on-black inverted aesthetic.
// -----------------------------------------------------------------------------
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost';
  loading?: boolean;
};

export function Button({
  variant = 'primary',
  loading,
  disabled,
  className = '',
  children,
  ...rest
}: ButtonProps) {
  // Visible feedback at every interaction stage so the user knows their
  // click registered:
  //   * hover  — background shifts
  //   * active — pressed effect (slight darken + scale)
  //   * focus  — visible ring for keyboard users
  const base =
    'inline-flex w-full items-center justify-center px-5 py-3 text-sm font-medium uppercase tracking-widest transition-all ' +
    'select-none focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950 ' +
    'active:scale-[0.98] ' +
    'disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100';

  const variantClasses =
    variant === 'primary'
      ? 'bg-neutral-50 text-neutral-950 hover:bg-neutral-200 active:bg-neutral-300'
      : 'border border-neutral-800 bg-transparent text-neutral-200 hover:border-neutral-500 hover:bg-neutral-900 active:bg-neutral-800';

  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={`${base} ${variantClasses} ${className}`}
    >
      {loading ? 'Working…' : children}
    </button>
  );
}

// -----------------------------------------------------------------------------
//  TextLink — small inline link, gray underline on hover.
// -----------------------------------------------------------------------------
export function TextLink({
  onClick,
  children,
  type = 'button',
}: {
  onClick: () => void;
  children: ReactNode;
  type?: 'button' | 'submit';
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      // Underline is always present so the link reads as clickable at
      // rest, and a stronger color + focus ring on interaction confirm
      // the click registered.
      className={
        'text-sm font-medium text-neutral-300 underline underline-offset-4 decoration-neutral-700 transition-colors ' +
        'hover:text-neutral-50 hover:decoration-neutral-300 ' +
        'active:text-neutral-100 ' +
        'focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-400 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950 ' +
        'rounded-sm px-0.5'
      }
    >
      {children}
    </button>
  );
}
