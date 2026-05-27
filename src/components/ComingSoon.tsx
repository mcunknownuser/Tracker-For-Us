// =============================================================================
//  ComingSoon.tsx
//  Placeholder used by pages not yet built. Renders the standard PageHeader
//  plus a quiet "in development" panel so navigation between unbuilt pages
//  still feels intentional rather than broken.
// =============================================================================

import { PageHeader } from './PageHeader';

type ComingSoonProps = {
  eyebrow: string;
  title: string;
  description: string;
};

export function ComingSoon({ eyebrow, title, description }: ComingSoonProps) {
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader eyebrow={eyebrow} title={title} subtitle={description} />
      <div className="flex h-80 items-center justify-center border border-dashed border-neutral-800">
        <span className="text-xs uppercase tracking-editorial text-neutral-600">
          In development
        </span>
      </div>
    </div>
  );
}
