// =============================================================================
//  SetupGuide.tsx
//  Post-signup onboarding for agency owners/admins. Two cooperating pieces:
//
//    1. Guided tour  — a one-time spotlight walkthrough of the sidebar tabs,
//                      shown on first login. Tracked by a synced pref so it
//                      never repeats (but can be replayed from the widget).
//    2. Setup widget — a persistent, collapsible checklist in the bottom-right
//                      corner. Items auto-complete by detecting real data.
//                      Dismissible once everything is done.
//
//  Only the owner/admins see this; staff who join an established agency don't
//  need a setup flow. Mounted once by AppLayout, inside the router.
// =============================================================================

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { Agency } from '../lib/agency';
import { getMyAgencyRole } from '../lib/agency';
import {
  type SetupTask,
  type TourStep,
  TOUR_STEPS,
  loadSetupTasks,
  getTourSeen,
  markTourSeen,
  getChecklistDismissed,
  dismissChecklist,
} from '../lib/setup';

export function SetupGuide({ agency }: { agency: Agency }) {
  const location = useLocation();

  // Gate on role. Null while we resolve it; only owner/admin proceed.
  const [canSee, setCanSee] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const role = await getMyAgencyRole(agency.id);
        if (!cancelled) setCanSee(role === 'owner' || role === 'admin');
      } catch {
        if (!cancelled) setCanSee(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agency.id]);

  const [tasks, setTasks] = useState<SetupTask[] | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [tourOn, setTourOn] = useState(false);

  const reload = useCallback(() => {
    void loadSetupTasks(agency.id).then(setTasks);
  }, [agency.id]);

  // Initial load: tasks, dismissed flag, and whether to auto-start the tour.
  useEffect(() => {
    if (!canSee) return;
    let cancelled = false;
    void (async () => {
      const [seen, isDismissed] = await Promise.all([
        getTourSeen(),
        getChecklistDismissed(),
      ]);
      if (cancelled) return;
      setDismissed(isDismissed);
      if (!seen) {
        setTourOn(true);
        // Marked seen at START, not at the final step. Finishing was the only
        // thing that recorded it, and the tour has no other exit — so anyone
        // who quit the app mid-tour got the whole introduction again on every
        // login. Seen-on-start makes it one-shot; replay stays available from
        // the setup widget.
        void markTourSeen();
      }
      reload();
    })();
    return () => {
      cancelled = true;
    };
  }, [canSee, reload]);

  // Re-detect completion whenever the route changes — the user has usually
  // just done something (added an employee, logged an expense) and come back.
  useEffect(() => {
    if (canSee) reload();
  }, [location.pathname, canSee, reload]);

  function finishTour() {
    setTourOn(false);
    void markTourSeen();
  }

  function handleDismiss() {
    setDismissed(true);
    setPanelOpen(false);
    void dismissChecklist();
  }

  if (!canSee || dismissed) return null;

  const total = tasks?.length ?? 0;
  const doneCount = tasks?.filter((t) => t.done).length ?? 0;
  const allDone = total > 0 && doneCount === total;

  return (
    <>
      {tourOn && (
        <Tour
          onFinish={() => {
            finishTour();
            setPanelOpen(true);
          }}
        />
      )}

      {/* Floating launcher */}
      <button
        type="button"
        data-tour="setup-widget"
        onClick={() => {
          reload();
          setPanelOpen((v) => !v);
        }}
        className="fixed bottom-5 right-5 z-30 flex items-center gap-2.5 border border-neutral-700 bg-neutral-900 px-4 py-2.5 text-[11px] font-medium uppercase tracking-widest text-neutral-100 shadow-2xl transition-colors hover:border-neutral-500"
      >
        <span
          className={
            'inline-block h-2 w-2 ' + (allDone ? 'bg-emerald-400' : 'bg-amber-400')
          }
        />
        Setup
        <span className="text-neutral-500">
          {doneCount}/{total || 5}
        </span>
      </button>

      {panelOpen && tasks && (
        <ChecklistPanel
          tasks={tasks}
          doneCount={doneCount}
          total={total}
          allDone={allDone}
          onClose={() => setPanelOpen(false)}
          onDismiss={handleDismiss}
          onReplayTour={() => {
            setPanelOpen(false);
            setTourOn(true);
          }}
        />
      )}
    </>
  );
}

// -----------------------------------------------------------------------------
//  ChecklistPanel — the popover that opens above the launcher.
// -----------------------------------------------------------------------------

function ChecklistPanel({
  tasks,
  doneCount,
  total,
  allDone,
  onClose,
  onDismiss,
  onReplayTour,
}: {
  tasks: SetupTask[];
  doneCount: number;
  total: number;
  allDone: boolean;
  onClose: () => void;
  onDismiss: () => void;
  onReplayTour: () => void;
}) {
  const navigate = useNavigate();
  const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;

  return (
    <div className="fixed bottom-20 right-5 z-40 flex max-h-[75vh] w-[min(92vw,380px)] flex-col border border-neutral-800 bg-neutral-950 shadow-2xl">
      <div className="flex items-start justify-between border-b border-neutral-900 px-5 py-4">
        <div>
          <div className="text-[10px] uppercase tracking-editorial text-neutral-500">
            Getting started
          </div>
          <div className="mt-1 font-serif text-xl font-semibold tracking-tight text-neutral-50">
            {allDone ? "You're all set." : `${doneCount} of ${total} done`}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close setup"
          className="text-neutral-500 transition-colors hover:text-neutral-100"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Progress bar */}
      <div className="px-5 pt-4">
        <div className="h-1 w-full bg-neutral-900">
          <div
            className="h-1 bg-neutral-100 transition-all duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {tasks.map((t) => (
          <div
            key={t.id}
            className="flex items-start gap-3 border border-transparent px-2 py-3"
          >
            <CheckBox done={t.done} />
            <div className="min-w-0 flex-1">
              <div
                className={
                  'text-sm font-medium ' +
                  (t.done ? 'text-neutral-500 line-through' : 'text-neutral-100')
                }
              >
                {t.title}
              </div>
              {!t.done && (
                <>
                  <div className="mt-0.5 text-xs leading-relaxed text-neutral-500">
                    {t.blurb}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      navigate(t.route);
                      onClose();
                    }}
                    className="mt-2 border border-neutral-700 px-3 py-1.5 text-[10px] uppercase tracking-widest text-neutral-200 transition-colors hover:border-neutral-500 hover:text-neutral-50"
                  >
                    {t.cta} &rarr;
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between border-t border-neutral-900 px-5 py-3">
        <button
          type="button"
          onClick={onReplayTour}
          className="text-[10px] uppercase tracking-widest text-neutral-500 transition-colors hover:text-neutral-200"
        >
          Replay walkthrough
        </button>
        {allDone && (
          <button
            type="button"
            onClick={onDismiss}
            className="border border-neutral-50 bg-neutral-50 px-4 py-1.5 text-[10px] font-medium uppercase tracking-widest text-neutral-950 transition-colors hover:bg-neutral-200"
          >
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}

function CheckBox({ done }: { done: boolean }) {
  return (
    <span
      className={
        'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border ' +
        (done
          ? 'border-neutral-100 bg-neutral-100 text-neutral-950'
          : 'border-neutral-700')
      }
    >
      {done && (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
    </span>
  );
}

// -----------------------------------------------------------------------------
//  Tour — spotlight walkthrough. Dims the screen, cuts a hole around the
//  current target, and floats a card beside it. On narrow viewports (sidebar
//  hidden) every step renders centered with no spotlight.
// -----------------------------------------------------------------------------

function Tour({ onFinish }: { onFinish: () => void }) {
  const [i, setI] = useState(0);
  const step: TourStep = TOUR_STEPS[i]!;
  const isLast = i === TOUR_STEPS.length - 1;

  const rect = useTargetRect(step.target, i);

  return (
    <div className="fixed inset-0 z-[60]">
      {/* Dim + cutout. With a target we use a giant box-shadow to darken
          everything except the highlighted element; without one, a flat scrim. */}
      {rect ? (
        <div
          className="pointer-events-none absolute transition-all duration-300"
          style={{
            top: rect.top - 6,
            left: rect.left - 6,
            width: rect.width + 12,
            height: rect.height + 12,
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.74)',
            border: '1px solid rgba(245,245,245,0.6)',
          }}
        />
      ) : (
        <div className="absolute inset-0 bg-black/75" />
      )}

      <TourCard
        step={step}
        rect={rect}
        index={i}
        count={TOUR_STEPS.length}
        isLast={isLast}
        onBack={() => setI((n) => Math.max(0, n - 1))}
        onNext={() => (isLast ? onFinish() : setI((n) => n + 1))}
        onSkip={onFinish}
      />
    </div>
  );
}

function TourCard({
  step,
  rect,
  index,
  count,
  isLast,
  onBack,
  onNext,
  onSkip,
}: {
  step: TourStep;
  rect: DOMRect | null;
  index: number;
  count: number;
  isLast: boolean;
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
}) {
  // Position beside the target when we have one, otherwise dead center.
  const CARD_W = 340;
  let style: React.CSSProperties;
  if (rect) {
    const left = Math.min(rect.right + 16, window.innerWidth - CARD_W - 16);
    const top = Math.max(16, Math.min(rect.top, window.innerHeight - 240));
    style = { top, left, width: CARD_W };
  } else {
    style = {
      top: '50%',
      left: '50%',
      width: `min(92vw, ${CARD_W}px)`,
      transform: 'translate(-50%, -50%)',
    };
  }

  return (
    <div
      className="absolute border border-neutral-700 bg-neutral-950 p-6 shadow-2xl"
      style={style}
    >
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-editorial text-neutral-500">
          {step.eyebrow}
        </div>
        <div className="text-[10px] uppercase tracking-widest text-neutral-600">
          {index + 1} / {count}
        </div>
      </div>

      <h2 className="mt-3 font-serif text-2xl font-semibold leading-tight tracking-tight text-neutral-50">
        {step.title}
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-neutral-400">{step.body}</p>

      <div className="mt-6 flex items-center justify-between">
        {!isLast ? (
          <button
            type="button"
            onClick={onSkip}
            className="text-[10px] uppercase tracking-widest text-neutral-600 transition-colors hover:text-neutral-300"
          >
            Skip tour
          </button>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          {index > 0 && (
            <button
              type="button"
              onClick={onBack}
              className="border border-neutral-800 px-4 py-2 text-[10px] uppercase tracking-widest text-neutral-300 transition-colors hover:border-neutral-500"
            >
              Back
            </button>
          )}
          <button
            type="button"
            onClick={onNext}
            className="border border-neutral-50 bg-neutral-50 px-5 py-2 text-[10px] font-medium uppercase tracking-widest text-neutral-950 transition-colors hover:bg-neutral-200"
          >
            {isLast ? 'Finish' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Measures the element matching `selector` and keeps the rect current across
// resizes. Returns null when there's no selector, no match, or the element is
// off-screen / collapsed (e.g. the sidebar drawer on mobile) — callers then
// fall back to a centered card.
function useTargetRect(selector: string | null, stepIndex: number): DOMRect | null {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const raf = useRef<number | null>(null);

  useLayoutEffect(() => {
    function measure() {
      if (!selector || !window.matchMedia('(min-width: 768px)').matches) {
        setRect(null);
        return;
      }
      const el = document.querySelector(selector);
      if (!el) {
        setRect(null);
        return;
      }
      const r = el.getBoundingClientRect();
      setRect(r.width > 0 && r.left >= 0 ? r : null);
    }
    measure();
    const onResize = () => {
      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = requestAnimationFrame(measure);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [selector, stepIndex]);

  return rect;
}
