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
app.on('before-quit', (e) => {
  e.preventDefault();
  log.info('shutdown', 'begin');
  const work = runTeardown(
    [
      ['flush renderer', flushRenderer],
      ['persist bounds', persistBoundsNow],
      ['dispose documents', () => docSvc.dispose()],
      ['dispose shells', () => mshellSvc.disposeAll()],
      ['cancel scripts', () => scriptSvc.cancelAll()],
      ['disconnect pool', () => pool.disconnectAll()],
      ['close db', () => closeDatabase(db)],
    ],
    (step, err) => log.warn('shutdown', `error during ${step}`, { err: String(err) }),
  );
  void Promise.race([work, new Promise(r => setTimeout(r, 8000))]).then(() => {
    log.info('shutdown', 'end');
    app.exit(0);
  });
});
```

- 8-second hard budget. Anything still pending is abandoned.
- Every `before-quit` is held (`createBeforeQuitHandler`, `electron/quitGuard.ts`), including one that arrives while the sequence runs, such as a second Cmd+Q during the flush: Electron's own quit would end the app mid-teardown. The sequence ends the app with `app.exit`, which emits no `before-quit`.
- `flush renderer` comes first, while the database is still open: `app.exit` destroys the window without its unload events, so the tab edits the renderer still holds back (§6) are asked for here. Main pushes `app:flush-request-event` and waits for the renderer's `app:flushDone` (`awaitRendererFlush`, `electron/quitGuard.ts`) for at most 1.5 seconds, inside the 8-second budget. With no window, nothing is asked; an answer that does not come in time is logged at `warn` and the quit goes on.
- Each step runs in its own try/catch (`runTeardown`, `electron/quitGuard.ts`): a step that throws or rejects is logged by name and the later steps still run, so a failed step never leaves the pool connected or the database open.
- `db.close()` is last — once it returns, no more writes are possible.
- On macOS, closing the last window does NOT quit (`window-all-closed` unless `process.platform !== 'darwin'`) — existing behavior. The app and its sessions keep running, so closing the window cuts off no work.

### Quit with running or unsaved work

Before the sequence above starts, `before-quit` checks for work that quitting would kill or throw away:

- **Counted:** script runs in flight (`ScriptService.runningCount()`), shell sessions with a command still running (`ShellService.busyCount()`, W11 section 3), imports in flight (`ImportService.runningCount()`) and aggregation runs in flight (`AggregationService.runningCount()`). An idle shell is not counted.
- **Unsaved work, reported by the renderer:** the renderer has no say in quitting (`beforeunload` is cancelled silently by Electron), so it reports instead, through `app:setUnsavedWork` (`{ source: 'connectionForm' | 'pipelines', count }`), and each report replaces that source's last one. Main keeps the counts in a module-level store and resets it (`resetUnsavedWork`) on a full page load (a main-frame `did-start-navigation` that is not same-document; the app's own hash-route changes are), on `render-process-gone` and on the window's `closed`: the form's report goes with the page, so a reloaded or crashed renderer cannot make every later quit ask, and dirty pipelines are recounted from the saved tabs (`WorkspaceStateService.dirtyPipelineCount`, the Workspace's own rule, a truthy `aggregation.dirty`; a tab whose saved state does not parse counts 0 and is logged at `warn`), since they outlive the page. The Workspace's own report replaces that count once it mounts again. Once shutdown has begun nothing is recounted, as the database may be closed.
  - **Connection form:** the full-page form (`NewConnection`) and the modal (`ConnectionFormModal`) report 1 while the form is dirty, and 0 on unmount and after a successful save.
  - **Pipelines:** the workspace reports how many collection tabs hold a pipeline with `aggregation.dirty`. Nothing is reported until the tabs have loaded, or when they failed to load, so an empty list never overwrites the last real count. They count only when `ui.workspace.restoreTabs` is explicitly `false`: with "Reopen tabs on launch" on (or unset), the tabs and their pipelines come back at the next launch, so nothing is lost.
- **Not counted:** plain finds. They run in main with no handle the check can read, so quitting still cuts them off without asking.
- **Where it is asked:** off macOS, closing the last window quits the app, so the window's `close` event is held and the question is asked there, before the window goes; a Cancel then leaves the window as it was. On macOS closing the window stops nothing, so it is not asked. Any other quit (`Cmd/Ctrl+Q`, `app.quit()`) is held in `before-quit` the same way. A Quit answer lets the close and the app quit that follows it through without a second question, and a quit or close requested while the question is open is not asked again. The decisions live in `createQuitGate` (`electron/quitGuard.ts`).
- **Prompt:** when something is counted, the quit is held and a native warning dialog names what stops, for example `This will stop 1 running script and 2 running shell commands.` (three or more kinds read as a comma list), with `Cancel` (default) and `Quit`. Unsaved work adds a second sentence, for example `This will stop 1 running script. Unsaved changes in the connection form and 2 pipelines will be lost.`; with nothing running, the dialog carries only that second sentence. The dialog's detail line follows the same split (`describeQuitDetail`): cancelled work, unsaved changes that cannot be recovered, or both. Cancel leaves the app running. Quit quits again, past the check, into the sequence above. A second quit request while the dialog is open is the same question.
- **Bypass:** a system shutdown, restart or log-off is not asked about, since the work goes with it either way: Electron's `powerMonitor` `shutdown` event (macOS and Linux) and the window's `session-end` event (Windows) set a flag that skips the check.

## 5. Restore on activate

- `app.on('activate', ...)` (macOS dock icon click): if no window, recreate using the same service instances. Do NOT re-open the DB or reconstruct services.

## 6. Reload / devtools

- In dev (`VITE_DEV_SERVER_URL` set), HMR reloads the renderer but keeps the main process — services remain alive.
- A "hard reload" (⌘⇧R) reloads the window without restarting main. Tab state is persisted on every change (W01), so the renderer can restore.
- Tab-state edits wait 250ms before `tabs.update` saves them. Edits still waiting are sent at once when the Workspace unmounts, on the page's `pagehide` (a reload, or the window closing while main lives on) and before quitting, when main asks (§4); the renderer's answer is `FlushOnQuit` in `RootLayout`, which flushes everything registered in `src/state/pendingFlush.ts` and answers even when nothing is.
- A `devReset` developer shortcut (⌘⇧⌥R) is registered that: closes the DB, deletes the open database file with its `-wal` and `-shm`, reopens, re-runs migrations, then reloads the window. Disabled in packaged builds.

## 7. Crash handling

- Main-process uncaught exceptions: logged, `dialog.showErrorBox`, then `app.exit(1)`. The user relaunches manually.
- Renderer crashes (`render-process-gone`): log, reload the window once. If it crashes again within 10 seconds, quit.

## 8. Logs

- Rotating file at `userData/logs/latelier.<date>.log`. Daily rotation, 7-day retention.
- Each file is capped at 10 MiB. A day that outgrows it continues in `latelier.<date>.1.log`, then `.2`, and so on; a line bigger than the cap still goes whole into an empty part. The logger counts bytes in memory and reads a size from disk only when it opens a day, where it resumes that day's highest part. Parts age out like any other log file. The diagnostic bundle keeps the newest files by date, then part number counted as a number, then the pre-rename `mongolab.` file before the `latelier.` one of the same day.
- On POSIX the `logs/` dir is `0700` and log files are `0600`; existing files are tightened at startup, and a dir or file that cannot be is reported as a `warn` line. No-op on Windows.
- Log levels: `debug` (dev only), `info`, `warn`, `error`.
- `log.info(tag, msg, data?)` — `tag` is a short namespace (`'boot'`, `'mongo'`, `'db'`, `'ipc'`).
- Renderer never writes to this log directly; it calls `app:log`, which main validates, rate-limits and writes under the `renderer` tag, with `{ source, stack }` as data. The usual scrubbing applies.
  - Payload: `level` is `warn` or `error`; `message` is at most 2000 characters; `source` is `window.error`, `unhandledrejection`, `errorBoundary` or `component`; the optional `stack` is at most 8000 characters. Anything else is refused as `VALIDATION`. The renderer cuts the message and stack to those lengths itself, so a long error is shortened, never refused whole.
  - Rate limit: 50 lines per 60 s window. The first line dropped in a window writes one `warn`, "renderer log rate limit reached; dropping until <ISO time>", and the rest are dropped silently. A dropped line still answers ok. A full page load (a reload, or the page after a crash) starts a fresh window.
  - The channel is registered quiet: the router writes no `ipc.req` or `ipc.ok` line for it, so a loop adds nothing per call around the gate, and the `ipc.err` line of a refused call carries no request summary.
  - Senders: the window's `error` and `unhandledrejection` listeners, installed before the first render; the error boundary, which sends the error's message, and its stack joined with the component stack; and component catches that have no UI to report to, such as the Mongo shell's stop during cleanup.
  - When `app:log` itself fails, the renderer says so once with `console.warn` and never through `app:log`, so a broken bridge cannot loop.

## 9. Acceptance criteria

- With a clean userData dir, first launch: DB created, migrations run, window appears with no error dialogs.
- Second instance quits silently and focuses the primary.
- On quit with a live MongoClient, the app exits within 8 seconds.
- Quitting with a script or shell command running asks first, and Cancel keeps the app open; quitting with nothing running does not ask.
- Quitting with a dirty connection form asks first and names the form; dirty pipelines are named only when "Reopen tabs on launch" is off. A reload or a renderer crash forgets the form's report and recounts dirty pipelines from the saved tabs.
- A tab edit made just before quitting or closing the window is there after a relaunch.
- A DB file that fails to open (corrupt) produces an error dialog naming the file path and tells the user how to reset.
- `app:log` IPC entries appear in the log file with the correct process tag.
- A renderer that logs in a loop writes at most 50 lines and one rate-limit notice per minute.
- No log file grows past 10 MiB, except for a single line that is larger than the cap.

## 10. Test cases

### Integration
- **boot-order.spec.ts** (with stubbed Electron `app`/`BrowserWindow`): assert registration order is DB → services → IPC → window.
- **single-instance.spec.ts**: second `app.requestSingleInstanceLock` returns false → the test harness observes a quit call and a `second-instance` event emission on the first.
- **app-unsaved-work.spec.ts**: `app:setUnsavedWork` sets its source in the store; zod rejects an unknown source and a count that is negative, fractional or over 1000. `app:flushDone` reaches the ack sink, and zod rejects a payload that is not an object.
- **app-log-channel.spec.ts**: `app:log` writes the line at its level under the `renderer` tag with source and stack, scrubbed; accepts a message and stack exactly at their caps; refuses an unknown level or source, a message over 2000, a stack over 8000, a missing message and a non-object; writes 50 lines, one notice and then nothing, answering ok; a flood of 200 calls leaves exactly 50 lines and the notice in the file, none from the router; takes lines again after a reset; `resetGateOnFreshPage` resets the gate on a main-frame, cross-document navigation only.
- **diagnostic-service.spec.ts**: the bundle keeps the newest parts of a day, with `.10` after `.2`.
- **log.spec.ts** (unit): a line that lands exactly on the cap stays and the next rolls to `.1`; bytes are counted, not characters; an oversized line goes into an empty part; startup resumes the day's highest part and counts its bytes; a new day starts at part 0; a failed append is not counted. `compareLogFiles` and `createRateGate` (cap, first refusal, window boundary, a clock that moves back, reset) are covered here and by property tests.
- **router-dispatch.spec.ts**: a quiet channel writes no `ipc.req` or `ipc.ok` line and its `ipc.err` line no payload, while a normal channel keeps all three.
- **workspace-state-dirty-count.spec.ts**: `dirtyPipelineCount` counts collection tabs with a truthy `aggregation.dirty`, ignores clean, plain and script tabs, and counts an unparseable row as 0 with one warning.
- **shutdown-budget.spec.ts**: stub `pool.disconnectAll` to hang; total shutdown time is ≤ 8s.
- **quit-guard.spec.ts** (unit): the sentence for each mix of running scripts and shell commands, the unsaved-work sentence alone and after the running-work one, none when idle, a hold on unsaved work alone, and the gate: asked once per close, a request while the question is open, the shutdown bypass, and Cancel followed by a later quit asking again. `resetUnsavedWork` drops the form and takes the recount; `awaitRendererFlush` answers `no-window`, `flushed` and `timeout`, and an ack after the timeout changes nothing. `createBeforeQuitHandler` holds every quit, starts the teardown once, holds a second quit during it, and asks over held work.

### Component
- **workspace-tabs-flush.spec.tsx**: an edit followed by unmount, `pagehide` or `flushAll` inside the debounce is sent; `flushAll` resolves after the save settles, also when it fails.
- **renderer-log.spec.ts**: `logToMain` cuts the message and stack, coerces an Error's non-string message and stack, warns once when main refuses or the bridge is missing, and never throws or rejects; the global listeners forward an uncaught error and an unhandled rejection.
- **error-boundary.spec.tsx**: the caught error goes to `app:log` with its stack and the component stack, cut to 8000 characters.
- **mongo-shell-pane.spec.tsx**: a refused Stop prints why in the pane and logs it; a stop that fails during cleanup is logged.
- **flush-on-quit.spec.tsx**: `FlushOnQuit` answers a flush request after every flusher has finished, answers with none registered, logs a refused answer to the console instead of leaving it unhandled, and unsubscribes on unmount.

### E2E
- **first-run.e2e.ts**: delete the userData dir; launch; assert the connections page renders empty state and the DB file exists on disk.
- **crash-reload.e2e.ts**: force a renderer crash via `window.location = 'about:crash'`; assert the window reloads once.
- **f06-quit-confirm.e2e.ts**: with the dialog stubbed in main, quitting idle exits without asking; with a script or a shell command running it asks, names it, stays open on Cancel and exits on Quit; off macOS, closing the window with work running asks once, keeps the window on Cancel and exits on Quit; with text typed into a new connection form, quitting asks and names the form.
- **quit-flushes-tab-state.e2e.ts**: a filter typed and quit at once, or typed and the window closed at once, is back after a relaunch on the same userData; after a reload onto the new-connection page with a dirty pipeline and "Reopen tabs on launch" off, quitting names the pipeline.
