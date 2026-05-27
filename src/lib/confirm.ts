// =============================================================================
//  confirm.ts
//  Promise-based replacement for the browser's confirm() dialog. Uses the
//  same toast-style event channel pattern.
//
//  Usage:
//    if (await confirm({ title: 'Delete?', message: 'Cannot be undone.', destructive: true })) {
//      // do the destructive thing
//    }
// =============================================================================

export type ConfirmOptions = {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
};

export type ConfirmEvent = ConfirmOptions & {
  id: string;
  resolve: (v: boolean) => void;
};

const CHANNEL = 'voltrisai-confirm';

export function confirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const event: ConfirmEvent = {
      id: crypto.randomUUID(),
      resolve,
      ...options,
    };
    window.dispatchEvent(new CustomEvent(CHANNEL, { detail: event }));
  });
}

export function subscribeToConfirm(handler: (event: ConfirmEvent) => void) {
  const listener = (e: Event) => {
    handler((e as CustomEvent<ConfirmEvent>).detail);
  };
  window.addEventListener(CHANNEL, listener);
  return () => window.removeEventListener(CHANNEL, listener);
}
