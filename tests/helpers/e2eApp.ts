import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication } from 'playwright';
import { MongoMemoryServer } from 'mongodb-memory-server';

const here = path.dirname(fileURLToPath(import.meta.url));
const MAIN_JS = path.resolve(here, '../..', 'dist-electron/main.js');

/**
 * Shared E2E helpers for the Playwright + Electron suite. Earlier files
 * inlined this same boilerplate; consolidating reduces duplication and makes
 * cleanup harder to forget when new tests are added.
 *
 * `MongoMemoryServer` instances are tracked at module scope so callers can
 * invoke `await stopAllMemoryServers()` from `test.afterAll()` and have all
 * leaked instances reaped even if a test threw mid-setup.
 */

const MEMORY_SERVERS: MongoMemoryServer[] = [];

/**
 * Playwright's own reading of `CI`: unset, empty, `0` and `false` all mean
 * "not CI", so a developer exporting `CI=0` is not treated as a runner.
 */
function isCi(): boolean {
  const ci = process.env.CI?.toLowerCase();
  return ci !== undefined && ci !== '' && ci !== '0' && ci !== 'false';
}

/**
 * A vault spec that finds no usable keychain skips on a developer machine,
 * where Linux without a keyring is an ordinary setup. On CI a skip is a hole:
 * the runner is built to provide a session keyring, so "unavailable" means
 * that setup broke and the credential-storage coverage silently vanished.
 * Call this just before `test.skip` so CI turns the skip into a failure.
 */
export function failOnCiWhenKeychainMissing(backend: string | null): void {
  if (isCi()) {
    throw new Error(
      `SECRETS_UNAVAILABLE on CI (storage backend: ${backend}): the runner needs a session keyring (see the "Run E2E" step in .github/workflows/ci.yml)`,
    );
  }
}

/**
 * The credential store Chromium picked, or `null` off Linux, where the concept
 * does not exist (`getSelectedStorageBackend` is Linux-only). `basic_text` and
 * `unknown` mean no real keyring was reachable.
 */
export function selectedStorageBackend(app: ElectronApplication): Promise<string | null> {
  return app.evaluate(({ safeStorage }) =>
    process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : null,
  );
}

/**
 * Launch options that start the app without Playwright's Electron loader.
 *
 * That loader, injected whenever no `executablePath` is given, appends
 * `--password-store=basic` to the app's command line, which overrides any flag
 * in `args` and the desktop-environment detection alike. Under it Linux
 * Chromium always reports `basic_text`, whatever keyring is running, so the
 * secrets-vault specs could never exercise real encryption. Given the Electron
 * binary directly, Chromium picks its store itself. Only those specs opt in:
 * the loader also installs the throttling and ready-gating the rest of the
 * suite is tuned against.
 *
 * A test run must touch nothing outside its throwaway directory
 * (`electron/main.ts` redirects `userData` for that), and a real session
 * keyring is outside it: it can stop to ask for an unlock, which stalls the
 * spec until it times out, and the app's name matches the installed app's, so
 * it could share that app's safeStorage key. So the real keyring is used only
 * where it is the point and the machine is disposable: on CI, or on Linux when
 * `ATELIER_E2E_REAL_KEYRING=1` opts in. Any other Linux run gets
 * `--password-store=basic`, which now takes effect and sends the specs back to
 * their local skip. macOS always gets the mock keychain the loader would have
 * set, so a run never touches the login Keychain.
 */
export function nativeCredentialStoreLaunch(): { executablePath: string; args: string[] } {
  const electronBinary = createRequire(import.meta.url)('electron') as string;
  const storeArgs: string[] = [];
  if (process.platform === 'darwin') storeArgs.push('--use-mock-keychain');
  if (process.platform === 'linux' && !isCi() && process.env.ATELIER_E2E_REAL_KEYRING !== '1') {
    storeArgs.push('--password-store=basic');
  }
  return { executablePath: electronBinary, args: [MAIN_JS, ...storeArgs] };
}

export function freshUserData(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mongolab-e2e-'));
}

export async function launchApp(
  userDataDir: string,
  opts: { nativeCredentialStore?: boolean } = {},
): Promise<ElectronApplication> {
  const app = await electron.launch({
    ...(opts.nativeCredentialStore ? nativeCredentialStoreLaunch() : { args: [MAIN_JS] }),
    env: {
      ...process.env,
      ATELIER_USER_DATA_DIR: userDataDir,
      NODE_ENV: 'test',
    },
  });
  // A test instance never shows its window (`electron/main.ts`). macOS still
  // renders a hidden window, but Linux under xvfb (CI) backgrounds it.
  // Measured on CI (PR #122): 0 of 49 `setTimeout(0)` callbacks ran in 3s,
  // one scroll event fired for a full scroll, and a CSS transition never
  // advanced. Turning background throttling off brought the timers back but
  // not the frames, so on Linux the window is also shown, inactive: under
  // xvfb nothing pops up, and inactive means no `focus` event (which
  // `src/state/connections.ts` refetches on). macOS keeps it hidden.
  await app.firstWindow();
  await app.evaluate(({ BrowserWindow }, showOnLinux) => {
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.setBackgroundThrottling(false);
      if (showOnLinux) w.showInactive();
    }
  }, process.platform === 'linux');
  return app;
}

/**
 * Teardown close. `app.close()` quits through `before-quit`, where the quit
 * guard asks a native question over unsaved work (a dirty connection form,
 * say) — on a window a test instance never shows, so it would wait forever.
 * Teardown answers "Quit" to it; a test that is about the question stubs the
 * dialog itself. Stubbed only here, never at launch, so a dialog raised
 * during the body still surfaces. An app the test already quit is left alone:
 * `proc` is captured at launch, because `app.process()` throws once Playwright
 * has seen the app close.
 */
async function closeApp(app: ElectronApplication, proc: ChildProcess): Promise<void> {
  if (proc.exitCode === null && proc.signalCode === null) {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox;
    });
  }
  await app.close();
}

/**
 * Run a body with a launched Electron app + isolated userData dir.
 * Guarantees `app.close()` and `rmSync(userDataDir)` even if `launchApp`
 * throws or the body's first await rejects.
 */
export async function withApp<T>(
  fn: (app: ElectronApplication, userDataDir: string) => Promise<T>,
  opts: { nativeCredentialStore?: boolean } = {},
): Promise<T> {
  const userDataDir = freshUserData();
  let app: ElectronApplication | null = null;
  let proc: ChildProcess | null = null;
  try {
    app = await launchApp(userDataDir, opts);
    proc = app.process();
    return await fn(app, userDataDir);
  } finally {
    if (app && proc) await closeApp(app, proc);
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

/**
 * Variant of `withApp` that reuses an external `userDataDir` — used by
 * relaunch tests (theme persistence, secrets vault) that must keep the
 * SQLite file across two launches.
 */
export async function withAppOnUserData<T>(
  userDataDir: string,
  fn: (app: ElectronApplication) => Promise<T>,
): Promise<T> {
  let app: ElectronApplication | null = null;
  let proc: ChildProcess | null = null;
  try {
    app = await launchApp(userDataDir);
    proc = app.process();
    return await fn(app);
  } finally {
    if (app && proc) await closeApp(app, proc);
  }
}

export interface MemoryHostPort {
  server: MongoMemoryServer;
  host: string;
  port: number;
}

/**
 * Spin up a `MongoMemoryServer` and parse its host/port. The server is
 * tracked in module scope; call `stopAllMemoryServers()` from afterAll to
 * reap on suite teardown.
 *
 * Retries up to 3 times on `Port "<n>" already in use`. Even when the
 * previous server was awaited-stopped, the kernel can hold the port in
 * TIME_WAIT briefly — and `mongodb-memory-server` picks ports randomly,
 * so a retry almost always lands on a fresh one.
 */
export async function startMemoryServer(
  opts?: ConstructorParameters<typeof MongoMemoryServer>[0],
): Promise<MemoryHostPort> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const server = await MongoMemoryServer.create(opts);
      MEMORY_SERVERS.push(server);
      const m = server.getUri().match(/mongodb:\/\/([^:/]+):(\d+)/);
      if (!m) {
        await server.stop().catch(() => {});
        throw new Error('cannot parse memory mongo uri');
      }
      return { server, host: m[1]!, port: Number(m[2]!) };
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!/already in use/i.test(msg)) throw err;
      // Brief backoff so the port has a chance to clear.
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw lastErr;
}

export async function stopAllMemoryServers(): Promise<void> {
  await Promise.all(MEMORY_SERVERS.splice(0).map((m) => m.stop().catch(() => {})));
}

export const baseConnInput = (host: string, port: number) => ({
  name: 'E2E Target',
  color: '#1A6835',
  connectionType: 'standard' as const,
  host,
  port,
  authMech: 'none' as const,
  tls: { enabled: false, verify: true },
  advanced: {
    connectTimeoutMs: 3000,
    socketTimeoutMs: 3000,
    serverSelectionTimeoutMs: 3000,
    readPreference: 'primary' as const,
    maxPoolSize: 5,
    directConnection: true,
  },
});
