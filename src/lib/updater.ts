// =============================================================================
//  updater.ts
//  Wraps the Tauri updater plugin in two small helpers:
//    * checkOnStartup() — runs once when the app boots, silently looks
//      for a new version, and shows a confirm dialog if one is available.
//    * checkManually()  — same flow but triggered by a user-facing button
//      (Settings → "Check for updates"), with feedback for the "you're
//      already up to date" case.
//
//  No-ops in the browser (vite dev / hosted web) where window.__TAURI__
//  doesn't exist, so the same code runs in both environments without
//  guards at every call site.
// =============================================================================

import { confirm } from './confirm';
import { toast } from './toast';

// Tauri injects this global; if it's missing we're running in a normal
// browser (e.g. `npm run dev`) and the updater can be skipped.
function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function loadUpdaterApi() {
  // Dynamic import so the browser build doesn't try to resolve the
  // Tauri-only module at startup.
  const mod = await import('@tauri-apps/plugin-updater');
  return mod;
}

// Single check + install flow. Used by both the startup and the manual
// paths; `silentIfNone` controls whether to toast on the "no update" case.
async function checkAndPromptInstall(silentIfNone: boolean): Promise<void> {
  if (!isTauri()) return;
  let update;
  try {
    const { check } = await loadUpdaterApi();
    update = await check();
  } catch (err) {
    // Network failure, missing endpoint, signature mismatch — all land
    // here. Silent on startup (we don't want to spook the user); audible
    // when they asked.
    if (!silentIfNone) {
      toast.error(
        err instanceof Error
          ? `Could not check for updates: ${err.message}`
          : 'Could not check for updates.',
      );
    }
    return;
  }

  if (!update) {
    if (!silentIfNone) toast.success('You’re on the latest version.');
    return;
  }

  const ok = await confirm({
    title: `Update available: v${update.version}`,
    message:
      (update.body || 'A new version is available.') +
      '\n\nThe app will restart to apply the update.',
    confirmLabel: 'Download & install',
    destructive: false,
  });
  if (!ok) return;

  try {
    toast.info('Downloading update…');
    await update.downloadAndInstall();
    // Once installed, Tauri restarts the app automatically on most
    // platforms; on macOS the relaunch is explicit.
    const { relaunch } = await import('@tauri-apps/plugin-process').catch(() => ({
      relaunch: undefined as undefined | (() => Promise<void>),
    }));
    if (relaunch) await relaunch();
  } catch (err) {
    toast.error(
      err instanceof Error ? `Update failed: ${err.message}` : 'Update failed.',
    );
  }
}

export function checkOnStartup(): void {
  // Don't block app render — fire and forget.
  void checkAndPromptInstall(true);
}

export function checkManually(): Promise<void> {
  return checkAndPromptInstall(false);
}
