// =============================================================================
//  setup.ts
//  Post-signup "getting started" state. Two parts:
//    * A persistent checklist whose items auto-complete by detecting real
//      data (a department exists, an employee exists, etc.).
//    * Two per-user flags (synced via user_preferences): whether the guided
//      tour has been seen, and whether the checklist has been dismissed.
//  Consumed by components/SetupGuide.tsx.
// =============================================================================

import { ROUTES } from './routes';
import { listDepartments } from './departments';
import { listTeamMembers } from './teamMembers';
import { listUploads } from './tracking';
import { listExpenses } from './expenses';
import { listInvites } from './invites';
import { getPref, setPref } from './preferences';

export type SetupTaskId =
  | 'department'
  | 'employee'
  | 'tracking'
  | 'expense'
  | 'invite';

export type SetupTask = {
  id: SetupTaskId;
  title: string;
  blurb: string;
  cta: string;
  route: string;
  done: boolean;
};

// Versioned so we can re-introduce the flow later by bumping the suffix.
const TOUR_SEEN_KEY = 'setup_tour_seen_v1';
const DISMISSED_KEY = 'setup_checklist_dismissed_v1';

export async function getTourSeen(): Promise<boolean> {
  return getPref(TOUR_SEEN_KEY, false);
}
export async function markTourSeen(): Promise<void> {
  await setPref(TOUR_SEEN_KEY, true);
}
export async function getChecklistDismissed(): Promise<boolean> {
  return getPref(DISMISSED_KEY, false);
}
export async function dismissChecklist(): Promise<void> {
  await setPref(DISMISSED_KEY, true);
}

// Runs the five detection queries in parallel and returns the task list with
// `done` filled in. Each query is guarded so one failing read (e.g. a table
// the user can't see) degrades to "not done" rather than throwing the lot.
export async function loadSetupTasks(agencyId: string): Promise<SetupTask[]> {
  const [depts, members, uploads, expenses, invites] = await Promise.all([
    listDepartments().catch(() => []),
    listTeamMembers().catch(() => []),
    listUploads().catch(() => []),
    listExpenses().catch(() => []),
    listInvites(agencyId).catch(() => []),
  ]);

  return [
    {
      id: 'department',
      title: 'Create a department',
      blurb: 'Departments become your sidebar tabs — one per team, Models or Marketing.',
      cta: 'Manage in Settings',
      route: ROUTES.settings,
      done: depts.length > 0,
    },
    {
      id: 'employee',
      title: 'Add your first employee',
      blurb: 'Add a teammate, their position, and how they get paid.',
      cta: 'Go to Employees',
      route: ROUTES.employees,
      done: members.length > 0,
    },
    {
      id: 'tracking',
      title: 'Import tracking data',
      blurb: 'Upload a CSV from your tracking tool to see daily growth per link.',
      cta: 'Go to Tracking',
      route: ROUTES.tracking,
      done: uploads.length > 0,
    },
    {
      id: 'expense',
      title: 'Log an expense',
      blurb: 'Record a recurring or one-off cost so your margins stay accurate.',
      cta: 'Go to Expenses',
      route: ROUTES.expenses,
      done: expenses.length > 0,
    },
    {
      id: 'invite',
      title: 'Invite a teammate',
      blurb: 'Generate a join link so your team can log in.',
      cta: 'Invite in Settings',
      route: ROUTES.settings,
      done: invites.length > 0,
    },
  ];
}

// Tour steps. `target` is a CSS selector for the sidebar element to spotlight;
// null renders the card centered (welcome / closing steps, and the mobile
// fallback when the sidebar rail is hidden).
export type TourStep = {
  target: string | null;
  eyebrow: string;
  title: string;
  body: string;
};

export const TOUR_STEPS: TourStep[] = [
  {
    target: null,
    eyebrow: 'Welcome',
    title: "Let's take a quick look around.",
    body: 'A short walk through each tab in your sidebar — what it does and where to start. Under a minute, and you can skip anytime.',
  },
  {
    target: '[data-tour="dashboard"]',
    eyebrow: 'Tab 1',
    title: 'Dashboard',
    body: 'Your whole agency at a glance — total income, employee costs, net profit, and what you still owe your team this month.',
  },
  {
    target: '[data-tour="departments"]',
    eyebrow: 'Your tabs',
    title: 'Departments',
    body: 'Every team you create becomes its own tab here. Open one to run your day-to-day — sales and withdrawals for Models, accounts and income for Marketing.',
  },
  {
    target: '[data-tour="tracking"]',
    eyebrow: 'Tools',
    title: 'Tracking',
    body: 'Import a CSV of your tracking links from whichever tool your agency uses to watch daily growth per link over time.',
  },
  {
    target: '[data-tour="expenses"]',
    eyebrow: 'Tools',
    title: 'Expenses',
    body: 'Log recurring or one-off costs by category and method.',
  },
  {
    target: '[data-tour="employees"]',
    eyebrow: 'Tools',
    title: 'Employees',
    body: 'Your team, their roles, and exactly how each one gets paid.',
  },
  {
    target: '[data-tour="settings"]',
    eyebrow: 'Account',
    title: 'Settings',
    body: 'Invite teammates, set your currency, rename labels, and change the theme.',
  },
  {
    target: '[data-tour="setup-widget"]',
    eyebrow: 'You’re set',
    title: 'Finish setting up here.',
    body: 'This checklist tracks itself as you add real data. Open it anytime from this button.',
  },
];
