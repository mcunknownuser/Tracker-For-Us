// =============================================================================
//  toast.ts
//  Minimal toast notifications. No external dependency.
//
//  Usage:
//    import { toast } from './lib/toast';
//    toast.success('Agency created');
//    toast.error('Invalid email or password');
//    toast.action({ message: 'Marked as former.', actionLabel: 'Undo', onAction: () => ... });
//
//  The <ToastContainer /> component listens for events and renders.
// =============================================================================

type ToastKind = 'success' | 'error' | 'info';

export type ToastEvent = {
  id: string;
  kind: ToastKind;
  message: string;
  // Optional action button (e.g. "Undo"). When clicked, the toast invokes
  // onAction and dismisses itself. The container handles wiring; consumers
  // just supply the label + callback.
  actionLabel?: string;
  onAction?: () => void;
  // Override the default 4-second display window. Useful for undo toasts
  // where the user needs more time to react.
  durationMs?: number;
};

const CHANNEL = 'voltrisai-toast';

function emit(event: ToastEvent) {
  window.dispatchEvent(new CustomEvent(CHANNEL, { detail: event }));
}

export const toast = {
  success: (msg: string) =>
    emit({ id: crypto.randomUUID(), kind: 'success', message: msg }),
  error: (msg: string) =>
    emit({ id: crypto.randomUUID(), kind: 'error', message: msg }),
  info: (msg: string) =>
    emit({ id: crypto.randomUUID(), kind: 'info', message: msg }),
  // Toast with an action button (most commonly "Undo"). Defaults to 8s
  // since the user needs more time to read + click than for a plain status.
  action: (opts: {
    message: string;
    actionLabel: string;
    onAction: () => void;
    kind?: ToastKind;
    durationMs?: number;
  }) =>
    emit({
      id: crypto.randomUUID(),
      kind: opts.kind ?? 'info',
      message: opts.message,
      actionLabel: opts.actionLabel,
      onAction: opts.onAction,
      durationMs: opts.durationMs ?? 8000,
    }),
};

// Subscriber side: used by the ToastContainer component.
export function subscribeToToasts(handler: (event: ToastEvent) => void) {
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<ToastEvent>).detail;
    handler(detail);
  };
  window.addEventListener(CHANNEL, listener);
  return () => window.removeEventListener(CHANNEL, listener);
}
