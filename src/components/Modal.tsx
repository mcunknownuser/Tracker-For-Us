// =============================================================================
//  Modal.tsx
//  Centered modal with backdrop. Editorial dark styling.
//
//    - Click backdrop or press Escape to dismiss
//    - Locks page scroll while open
//    - Optional title + free-form body + actions
//
//  Rendered through a portal into <body> so that ancestor elements with a
//  CSS `transform` (e.g. our `animate-fade-in-up` route transitions) don't
//  hijack the `fixed` positioning. Without the portal, the modal would
//  attach itself to the transformed ancestor's box and land somewhere
//  other than viewport-center.
// =============================================================================

import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

type ModalProps = {
  open: boolean;
  onClose: () => void;
  title?: string;
  eyebrow?: string;
  children: ReactNode;
  // Optional max width override. Defaults to a comfortable form width.
  maxWidth?: string;
};

export function Modal({
  open,
  onClose,
  title,
  eyebrow,
  children,
  maxWidth = 'max-w-lg',
}: ModalProps) {
  // Lock page scroll while open + close on Escape.
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-40 flex items-center justify-center px-4 py-8"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Content. Caps at viewport height with internal scroll so long forms
          remain usable. */}
      <div
        className={`relative z-10 flex max-h-[calc(100vh-4rem)] w-full flex-col border border-neutral-800 bg-neutral-950 shadow-2xl ${maxWidth}`}
      >
        {(eyebrow || title) && (
          <div className="shrink-0 border-b border-neutral-900 px-7 pb-5 pt-6">
            {eyebrow && (
              <div className="mb-2 text-[10px] font-medium uppercase tracking-editorial text-neutral-500">
                {eyebrow}
              </div>
            )}
            {title && (
              <h2 className="font-serif text-2xl font-semibold tracking-tight text-neutral-50">
                {title}
              </h2>
            )}
          </div>
        )}
        <div className="overflow-y-auto px-7 py-6">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
