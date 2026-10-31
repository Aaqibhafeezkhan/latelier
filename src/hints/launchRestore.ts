import { api } from '../api/atelier';
import { logFailure } from '../utils/rendererLog';

// Main restores the previous session's tabs (or clears them) before the first
// window loads, so the first tab list this renderer sees is the restore. Tabs
// opened later in the session never count: the list is read once and kept.
let launchTabCount: Promise<number> | null = null;
let consumed = false;

export function readLaunchTabCount(): Promise<number> {
  launchTabCount ??= api.tabs.list().then(
    (list) => list.length,
    // Fail-open to "nothing restored": a missing hint beats a wrong one.
    (err) => {
      logFailure('listing the restored tabs', err);
      return 0;
    },
  );
  return launchTabCount;
}

/** True once the restore hint has shown, so a remounted Workspace does not repeat it. */
export function isLaunchRestoreConsumed(): boolean {
  return consumed;
}

export function consumeLaunchRestore(): void {
  consumed = true;
}

/** Test seam: forget the launch snapshot, as a fresh renderer would. */
export function resetLaunchRestore(): void {
  launchTabCount = null;
  consumed = false;
}
