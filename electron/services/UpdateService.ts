import { ValidationError } from '../errors.ts';
import type { Logger } from '../log.ts';
import type { QuitGate } from '../quitGuard.ts';
import type { UpdateState } from '@shared/types';

/** The subset of electron-updater's `autoUpdater` this service touches. */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: 'update-downloaded', listener: (info: { version: string }) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

/**
 * Updates run only in a packaged macOS or Windows build that is not pointed at
 * a throwaway data folder: never under `electron:dev`, never under the e2e
 * harness, and never on Linux (no feed is published for it).
 */
export function shouldCheckForUpdates(env: {
  isPackaged: boolean;
  userDataOverride: string | undefined;
  platform: NodeJS.Platform;
}): boolean {
  const supported = env.platform === 'darwin' || env.platform === 'win32';
  return supported && env.isPackaged && !env.userDataOverride;
}

/**
 * Owns the one piece of update state the renderer sees. Every failure is a log
 * line, never a thrown error and never UI.
 */
export class UpdateService {
  private state: UpdateState = { status: 'idle' };
  private updater: UpdaterLike | null = null;
  // Set while an approved restart is installing; the updater's error event
  // clears it when the install fails and the app does not quit.
  private restartPending = false;

  private readonly loadUpdater: () => Promise<UpdaterLike>;
  private readonly log: Logger;
  private readonly emit: (state: UpdateState) => void;
  private readonly enabled: boolean;
  private readonly quitGate: Pick<QuitGate, 'check' | 'ask' | 'reset'>;

  constructor(
    loadUpdater: () => Promise<UpdaterLike>,
    log: Logger,
    emit: (state: UpdateState) => void,
    enabled: boolean,
    quitGate: Pick<QuitGate, 'check' | 'ask' | 'reset'>,
  ) {
    this.loadUpdater = loadUpdater;
    this.log = log;
    this.emit = emit;
    this.enabled = enabled;
    this.quitGate = quitGate;
  }

  /** Resolves once the check has settled; never rejects. */
  async start(): Promise<void> {
    if (!this.enabled) return;
    try {
      const updater = await this.loadUpdater();
      this.updater = updater;
      updater.autoDownload = true;
      updater.autoInstallOnAppQuit = true;
      updater.on('update-downloaded', (info) => {
        this.state = { status: 'ready', version: info.version };
        this.emit(this.state);
      });
      updater.on('error', (err) => {
        this.log.warn('updater', 'updater error', { err: String(err) });
        // electron-updater reports every failed install here and then does not
        // quit: take back the quit approval and offer Restart again.
        if (this.restartPending) {
          this.restartPending = false;
          this.quitGate.reset();
          this.emit(this.state);
        }
      });
      await updater.checkForUpdates();
    } catch (err) {
      this.log.warn('updater', 'update check failed', { err: String(err) });
    }
  }

  getState(): UpdateState {
    return this.state;
  }

  /**
   * Asks about running work first: electron-updater starts the installer inside
   * `quitAndInstall`, before the app's quit event, so asking at `before-quit`
   * would be too late to cancel. A yes lets the quit that follows through
   * without a second dialog. A no installs nothing and re-sends `ready`, so the
   * renderer offers Restart again, as does an install that fails without
   * quitting. Resolves whether the restart went ahead.
   */
  async restart(): Promise<boolean> {
    if (this.state.status !== 'ready') {
      throw new ValidationError(`No update is ready to install (state: ${this.state.status})`);
    }
    if (this.quitGate.check() === 'hold' && !(await this.quitGate.ask())) {
      this.emit(this.state);
      return false;
    }
    this.restartPending = true;
    // A failed install emits `error` synchronously from inside this call.
    this.updater?.quitAndInstall(true, true);
    return this.restartPending;
  }
}
