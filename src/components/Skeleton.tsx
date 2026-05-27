// =============================================================================
//  Skeleton.tsx
//  Animated placeholder used while data is loading. Cheaper visual cost
//  than the old "Loading…" text and gives users a sense of structure.
// =============================================================================

type SkeletonProps = {
  className?: string;
};

// Single shimmer block. Pass tailwind sizing classes via className.
export function Skeleton({ className = '' }: SkeletonProps) {
  return (
    <div
      className={`relative overflow-hidden bg-neutral-900 ${className}`}
      aria-hidden
    >
      <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-neutral-800/60 to-transparent" />
    </div>
  );
}

// Pre-built skeletons for the most common page shapes.

export function StatCardSkeleton({ tier = 'primary' as 'primary' | 'secondary' }) {
  // Match the bordered card styling used by the real StatCard so the
  // skeleton doesn't look like a different layout while data loads.
  const pad = tier === 'primary' ? 'p-7 pl-8' : 'p-6 pl-7';
  const valueH = tier === 'primary' ? 'h-9' : 'h-6';
  return (
    <div className={`relative border border-neutral-800 bg-neutral-950 ${pad} before:absolute before:left-0 before:top-0 before:h-full before:w-[3px] before:bg-neutral-800`}>
      <Skeleton className="h-3 w-20" />
      <Skeleton className={`mt-3 ${valueH} w-32`} />
      <Skeleton className="mt-2 h-2.5 w-24" />
    </div>
  );
}

export function ChartSkeleton() {
  return (
    <section className="border border-neutral-800 bg-neutral-950 p-5">
      <div className="mb-3 flex items-baseline justify-between border-b border-neutral-900 pb-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-2.5 w-16" />
      </div>
      <Skeleton className="h-56 w-full" />
    </section>
  );
}

export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <section className="border border-neutral-800 bg-neutral-950 p-5">
      <div className="mb-3 flex items-baseline justify-between border-b border-neutral-900 pb-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-3 w-12" />
      </div>
      <div className="divide-y divide-neutral-900">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-baseline justify-between py-2.5">
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3.5 w-32" />
              <Skeleton className="h-2.5 w-20" />
            </div>
            <Skeleton className="h-3.5 w-16" />
          </div>
        ))}
      </div>
    </section>
  );
}

// Generic "I'm loading some section" skeleton. Use for Settings sub-sections.
export function SectionSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="border border-neutral-800 bg-neutral-950 p-5">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="mt-2 h-2.5 w-20" />
        </div>
      ))}
    </div>
  );
}
