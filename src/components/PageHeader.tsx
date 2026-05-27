// =============================================================================
//  PageHeader.tsx
//  Common header used at the top of every signed-in page.
//  Small uppercase eyebrow + serif title + optional action slot on the right.
// =============================================================================

import type { ReactNode } from 'react';

type PageHeaderProps = {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
};

export function PageHeader({ eyebrow, title, subtitle, actions }: PageHeaderProps) {
  return (
    <header className="mb-10 flex flex-col gap-6 border-b border-neutral-900 pb-8 md:flex-row md:items-end md:justify-between">
      <div>
        {eyebrow && (
          <div className="mb-3 text-[11px] font-medium uppercase tracking-editorial text-neutral-500">
            {eyebrow}
          </div>
        )}
        <h1 className="font-serif text-4xl font-semibold tracking-tight text-neutral-50 md:text-5xl">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-3 max-w-xl text-sm text-neutral-400">{subtitle}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 gap-3">{actions}</div>}
    </header>
  );
}
