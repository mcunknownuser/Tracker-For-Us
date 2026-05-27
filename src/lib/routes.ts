// =============================================================================
//  routes.ts
//  Single source of truth for all route paths. Import these instead of
//  hardcoding strings, so renaming a route is a one-line change.
// =============================================================================

// Universal routes. The agency's own department tabs sit between the
// dashboard and the universal ones; they're built dynamically in Sidebar.
export const ROUTES = {
  dashboard:         '/',
  department:        '/department',   // base — actual route is /department/:id
  tracking:          '/tracking',
  expenses:          '/expenses',
  employees:         '/employees',
  settings:          '/settings',
  // Scoped settings — same Settings page, narrowed to a focused set
  // of sections. Reached from gear buttons on the relevant pages.
  settingsExpenses:  '/settings/expenses',
  settingsTracking:  '/settings/tracking',
  // Legacy paths kept so old links don't 404. Both redirect to the dashboard.
  ofm:               '/ofm',
  reddit:            '/reddit',
} as const;

export type RoutePath = (typeof ROUTES)[keyof typeof ROUTES];

// Universal nav items shown AFTER the dynamic department tabs.
// Order: Dashboard (top, special) | <departments here> | Tracking | Expenses | Employees
// Settings is rendered separately at the bottom of the sidebar (Sidebar.tsx).
export const UNIVERSAL_NAV: { label: string; path: RoutePath }[] = [
  { label: 'Tracking',  path: ROUTES.tracking  },
  { label: 'Expenses',  path: ROUTES.expenses  },
  { label: 'Employees', path: ROUTES.employees },
];

// Helper for building a department's URL.
export function departmentPath(id: string): string {
  return `${ROUTES.department}/${id}`;
}
