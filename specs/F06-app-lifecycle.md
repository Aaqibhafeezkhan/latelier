# F06 — App startup & shutdown

> **Status: Implemented.**

## Purpose

Choreograph the bring-up and teardown sequence so every other spec's assumptions hold: the DB is open and migrated before any IPC is registered; the window only appears after services are ready; secrets, mongo clients, and logs flush cleanly on quit.

## Scope

- **In**: `main.ts` top-level boot sequence, service construction order, shutdown hooks, window creation, reload/dev behavior.
- **Out**: Per-service internals (those live in F02–F05). Renderer-side startup (covered per-page).

## Dependencies

- F01–F05.

## 1. Startup sequence

```ts
// electron/main.ts (conceptual)
app.whenReady().then(async () => {
  const userDataDir = app.getPath('userData');
  const log = createLogger(userDataDir);
  log.info('boot', 'starting');

  // 1. DB + migrations (blocks window creation)
  const db = openDatabase(userDataDir);                 // F02

  // 2. Repositories
  const connRepo   = new ConnectionRepo(db);
  const savedRepo  = new SavedQueryRepo(db);
  const recentRepo = new RecentQueryRepo(db);
  const tabsRepo   = new WorkspaceTabRepo(db);
  const prefsRepo  = new PreviewFieldsRepo(db);
  const stateRepo  = new AppStateRepo(db);

  // 3. Secrets
  const vault = new SecretsVault(db);                   // F03

  // 4. Mongo pool
  const pool = new MongoPool(connRepo, vault, log);     // F05

  // 5. Domain services
  const connSvc   = new ConnectionService(connRepo, vault, pool);
  const querySvc  = new QueryService(pool);
  const aggSvc    = new AggregationService(pool);
  const docSvc    = new DocumentService(pool);
  const savedSvc  = new SavedQueryService(savedRepo, connRepo);
  const recentSvc = new RecentQueryService(recentRepo);
  const tabsSvc   = new WorkspaceStateService(tabsRepo, savedSvc);   // reads a saved pipeline's stages on open
  const prefsSvc  = new PreviewFieldsService(prefsRepo);
  const appSvc    = new AppStateService(stateRepo);

  // 6. Register IPC channels
  registerConnChannels(connSvc);                        // F04 helpers
  registerMongoChannels(pool);
  registerMetaChannels(pool);
  registerQueryChannels(querySvc, recentSvc);
  registerAggChannels(aggSvc, recentSvc);
  registerDocChannels(docSvc);
  registerSavedChannels(savedSvc);
  registerRecentChannels(recentSvc);
  registerTabsChannels(tabsSvc);
  registerPrefsChannels(prefsSvc, appSvc);
  registerAppChannels(appSvc);

  // 7. Create window
  await createWindow(appSvc);                           // X01 restores bounds

  log.info('boot', 'ready');
});
```

If any of steps 1–6 throws, the app shows an error dialog via `dialog.showErrorBox` and quits with exit code 1. Step 7 failures are logged but the app keeps running (the `activate` handler will retry).

## 2. Window creation

- Restore bounds and maximize state from `app_state['window.bounds']` (X01).
- Default: 1280×800, centered. Minimum: 900×600.
- `titleBarStyle: 'hiddenInset'` (already set — keeps native macOS traffic lights).
- `backgroundColor` matches current theme (`LIGHT.bg` or `DARK.bg`) so the first paint isn't white-on-dark.
- `show: false` at creation; wait for `ready-to-show` before `show()`.
- DevTools opens automatically when `VITE_DEV_SERVER_URL` is set.

## 3. Single-instance lock

`app.requestSingleInstanceLock()`. If this returns `false`, call `app.quit()` immediately. The primary instance listens for `second-instance` and focuses the existing window. Prevents two copies stepping on the same SQLite file.

## 4. Shutdown sequence

```ts
app.on('before-quit', async (e) => {
  e.preventDefault();
  log.info('shutdown', 'begin');
  await Promise.race([
    (async () => {
      await tabsSvc.persistCurrent();      // renderer hands off a final snapshot via IPC if needed
      await pool.disconnectAll();
      db.close();
    })(),
    new Promise(r => setTimeout(r, 8000)),
  ]);
  log.info('shutdown', 'end');
  app.exit(0);
});
```

- 8-second hard budget. Anything still pending is abandoned.
- `db.close()` is last — once it returns, no more writes are possible.
- On macOS, closing the last window does NOT quit (`window-all-closed` unless `process.platform !== 'darwin'`) — existing behavior. The app and its sessions keep running, so closing the window cuts off no work.

### Quit with running work

Before the sequence above starts, `before-quit` checks for work that quitting would kill:

- **Counted:** script runs in flight (`ScriptService.runningCount()`), shell sessions with a command still running (`ShellService.busyCount()`, W11 section 3), imports in flight (`ImportService.runningCount()`) and aggregation runs in flight (`AggregationService.runningCount()`). An idle shell is not counted.
- **Not counted:** plain finds. They run in main with no handle the check can read, so quitting still cuts them off without asking.
- **Where it is asked:** off macOS, closing the last window quits the app, so the window's `close` event is held and the question is asked there, before the window goes; a Cancel then leaves the window as it was. On macOS closing the window stops nothing, so it is not asked. Any other quit (`Cmd/Ctrl+Q`, `app.quit()`) is held in `before-quit` the same way. A Quit answer lets the close and the app quit that follows it through without a second question, and a quit or close requested while the question is open is not asked again. The decisions live in `createQuitGate` (`electron/quitGuard.ts`).
- **Prompt:** when something is counted, the quit is held and a native warning dialog names what stops, for example `This will stop 1 running script and 2 running shell commands.` (three or more kinds read as a comma list), with `Cancel` (default) and `Quit`. Cancel leaves the app running. Quit quits again, past the check, into the sequence above. A second quit request while the dialog is open is the same question.
- **Bypass:** a system shutdown, restart or log-off is not asked about, since the work goes with it either way: Electron's `powerMonitor` `shutdown` event (macOS and Linux) and the window's `session-end` event (Windows) set a flag that skips the check.

## 5. Restore on activate

- `app.on('activate', ...)` (macOS dock icon click): if no window, recreate using the same service instances. Do NOT re-open the DB or reconstruct services.

## 6. Reload / devtools

- In dev (`VITE_DEV_SERVER_URL` set), HMR reloads the renderer but keeps the main process — services remain alive.
- A "hard reload" (⌘⇧R) reloads the window without restarting main. Tab state is persisted on every change (W01), so the renderer can restore.
- A `devReset` developer shortcut (⌘⇧⌥R) is registered that: closes the DB, deletes the open database file with its `-wal` and `-shm`, reopens, re-runs migrations, then reloads the window. Disabled in packaged builds.

## 7. Crash handling

- Main-process uncaught exceptions: logged, `dialog.showErrorBox`, then `app.exit(1)`. The user relaunches manually.
- Renderer crashes (`render-process-gone`): log, reload the window once. If it crashes again within 10 seconds, quit.

## 8. Logs

- Rotating file at `userData/logs/latelier.<date>.log`. Daily rotation, 7-day retention.
- On POSIX the `logs/` dir is `0700` and log files are `0600`; existing files are tightened at startup, and a dir or file that cannot be is reported as a `warn` line. No-op on Windows.
- Log levels: `debug` (dev only), `info`, `warn`, `error`.
- `log.info(tag, msg, data?)` — `tag` is a short namespace (`'boot'`, `'mongo'`, `'db'`, `'ipc'`).
- Renderer never writes to this log directly; it calls `app:log` IPC which the main side filters and forwards.

## 9. Acceptance criteria

- With a clean userData dir, first launch: DB created, migrations run, window appears with no error dialogs.
- Second instance quits silently and focuses the primary.
- On quit with a live MongoClient, the app exits within 8 seconds.
- Quitting with a script or shell command running asks first, and Cancel keeps the app open; quitting with nothing running does not ask.
- A DB file that fails to open (corrupt) produces an error dialog naming the file path and tells the user how to reset.
- `app:log` IPC entries appear in the log file with the correct process tag.

## 10. Test cases

### Integration
- **boot-order.spec.ts** (with stubbed Electron `app`/`BrowserWindow`): assert registration order is DB → services → IPC → window.
- **single-instance.spec.ts**: second `app.requestSingleInstanceLock` returns false → the test harness observes a quit call and a `second-instance` event emission on the first.
- **shutdown-budget.spec.ts**: stub `pool.disconnectAll` to hang; total shutdown time is ≤ 8s.
- **quit-guard.spec.ts** (unit): the sentence for each mix of running scripts and shell commands, none when idle, and the gate: asked once per close, a request while the question is open, the shutdown bypass, and Cancel followed by a later quit asking again.

### E2E
- **first-run.e2e.ts**: delete the userData dir; launch; assert the connections page renders empty state and the DB file exists on disk.
- **crash-reload.e2e.ts**: force a renderer crash via `window.location = 'about:crash'`; assert the window reloads once.
- **f06-quit-confirm.e2e.ts**: with the dialog stubbed in main, quitting idle exits without asking; with a script or a shell command running it asks, names it, stays open on Cancel and exits on Quit; off macOS, closing the window with work running asks once, keeps the window on Cancel and exits on Quit.
