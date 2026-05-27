// =============================================================================
//  DepartmentPage.tsx
//  Resolves the URL parameter (:id) to a Department, then renders the
//  appropriate page format:
//    layout_type = 'models'    -> OFM-style (sales + withdrawals + payments)
//    layout_type = 'marketing' -> Reddit-style (accounts + monthly income)
//
//  Both child pages accept a `departmentId` prop and filter their team
//  members + entries to that scope.
// =============================================================================

import { useEffect, useState } from 'react';
import { useParams, Navigate } from 'react-router-dom';
import { type Department, listDepartments } from '../lib/departments';
import { OFM } from './OFM';
import { Reddit } from './Reddit';
import { StatCardSkeleton, ChartSkeleton, ListSkeleton } from '../components/Skeleton';

export function DepartmentPage() {
  const { id } = useParams<{ id: string }>();
  const [dept, setDept] = useState<Department | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const all = await listDepartments();
        if (cancelled) return;
        setDept(all.find((d) => d.id === id) ?? null);
      } catch {
        if (!cancelled) setDept(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (loading) {
    return (
      <div className="mx-auto max-w-7xl">
        <div className="mb-10 border-b border-neutral-900 pb-8">
          <div className="h-3 w-24 animate-pulse bg-neutral-900" />
          <div className="mt-3 h-10 w-64 animate-pulse bg-neutral-900" />
        </div>
        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <StatCardSkeleton key={i} tier="primary" />
          ))}
        </div>
        <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <ChartSkeleton />
          </div>
          <ListSkeleton rows={4} />
        </div>
      </div>
    );
  }

  // Either the URL is bogus or the department was deleted. Bounce to home.
  if (!dept) return <Navigate to="/" replace />;

  return dept.layout_type === 'models' ? (
    <OFM departmentId={dept.id} departmentName={dept.name} />
  ) : (
    <Reddit departmentId={dept.id} departmentName={dept.name} />
  );
}
