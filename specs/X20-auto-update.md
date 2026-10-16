# X20 — Auto-update

> **Status: Implemented.**

## Purpose

A desktop app that never updates strands its users on old versions and old bugs. The app is now released signed and notarized on macOS; with a signed build the OS lets an update replace the running app. This spec adds a background update check from GitHub Releases, a download that does not interrupt work, and a quiet prompt that offers to restart into the new version.

Principles: never interrupt, never block, never nag with a modal, never fail loudly. An update problem is a log line, not an error dialog.

## Scope

### In

- Update check on launch, macOS and Windows, packaged builds only.
- Background download once an update is found.
- A non-blocking "Version X is ready — Restart to update" prompt with a Restart button.
- Install on the next quit when the prompt is dismissed.
- Publishing the feed and asset names the updater reads (`latest-mac.yml`, `latest.yml`, the macOS zip).

### Out — deliberately

- **Linux.** The AppImage target is unchanged; no `electron-updater` AppImage wiring, no feed for it.
- **Windows signing.** Windows builds stay unsigned; updates install without a publisher check.
- **Periodic re-checks, a manual "Check for updates" command, release-notes display, update channels, rollback.** One check per launch. Each can be added when asked for.
- **Update UI beyond one notification.** No settings page, no progress bar, no "downloading" state shown to the user.
- **Updating from an unsigned build to a signed one.** macOS refuses (section 7). Users of the last ad-hoc release install the signed release by hand once.

## Dependencies

- Signed and notarized macOS releases (release workflow) — macOS update only works from the first signed release onward.
- Stable, GitHub-safe release asset names (section 5).
- X09 (appId `io.github.anonhym.latelier`) — the macOS bundle identity must not change between an update's old and new versions.

## 1. Library and version

`electron-updater`, exact pinned version `6.8.9`, in runtime `dependencies` (electron-builder ships production dependencies into the asar; nothing is added to `asarUnpack`). Compatible with the installed electron-builder 26.15.3: its only builder-family dependency is `builder-util-runtime 9.7.0`, the same version already installed.

Main's Vite build externalizes a fixed list (`vite.config.ts`, `rolldownOptions.external`); `electron-updater` is added to it, because it is CommonJS and loads platform updaters lazily.

## 2. When it runs

`shouldCheckForUpdates({ isPackaged, userDataOverride, platform })` is a pure function: true only on `darwin` or `win32`, when `app.isPackaged` is true and the `ATELIER_USER_DATA_DIR` override is unset. Everywhere else (`electron:dev`, the Playwright e2e harness, a packaged app run against a throwaway data folder, and Linux, for which no feed is published) the updater is never loaded.

The check runs once, after the main window has been created, off the critical path. It is not repeated while the app runs.

## 3. Main process

### 3.1 UpdateService

`electron/services/UpdateService.ts` owns the state and the policy, and depends on an injected loader that resolves to an `UpdaterLike` (the narrow subset of `autoUpdater` it uses) so it is unit-testable without a network, Electron or `electron-updater`.

- `start()` (async, never rejects): when disabled (section 2) does nothing and never loads the updater. Otherwise loads it, sets `autoDownload = true`, `autoInstallOnAppQuit = true`, subscribes to `update-downloaded` and `error`, calls `checkForUpdates()` and logs any rejection, including a failed load.
- State: `{ status: 'idle' } | { status: 'ready', version }`. `update-downloaded` moves it to `ready` and emits it to the renderer. Nothing else changes visible state; checking, downloading and "no update available" are invisible.
- `restart()`: when `ready`, calls `quitAndInstall(true, true)` (silent, relaunch). When not `ready`, throws a `ValidationError` naming the actual state; it never installs speculatively. With scripts, shell commands, imports or aggregations running, it asks the quit question (F06) first, because `quitAndInstall` starts the installer before the app's `before-quit` fires and sets a flag that ignores every later install: asking at `before-quit` would be too late to cancel. Quit installs, and the quit that follows is let through without asking again. Cancel installs nothing, keeps the state `ready` and re-sends it, so the prompt offers Restart again. An install that fails after Quit (electron-updater emits `error` from inside `quitAndInstall` and does not quit) takes the approval back, so a later quit over running work asks again, and re-sends `ready` the same way; `restart()` then answers `restarting: false`.
- Errors: both a rejected `checkForUpdates()` and the updater's `error` event are written with `electron/log.ts` (`warn`, tag `updater`) and nothing else. Never a modal, never a notification, never thrown into the IPC envelope.
- The updater's own logger is an adapter onto `electron/log.ts`, so its output is redacted like every other log line.

### 3.2 Binding

`electron/updater/loadUpdater.ts` loads `electron-updater` with a dynamic import and returns `autoUpdater`. `electron-updater` is CommonJS and exposes `autoUpdater` through a lazy getter that Node's named-export detection cannot see, so under the ESM main the named export is `undefined` and the instance lives on `default.autoUpdater`. This was checked by importing the package under the real Electron binary: `Object.keys(mod)` has no `autoUpdater`, `mod.autoUpdater` is `undefined`, `mod.default.autoUpdater` is an object with `checkForUpdates`. The loader reads exactly that and throws a descriptive error when it is absent. A dynamic import also means the package is never loaded in dev or under e2e.

### 3.3 Before-quit

`electron/main.ts` runs a graceful shutdown in `before-quit` (it calls `preventDefault()`, shuts down, then `app.exit(0)`). Both install paths survive that:

- **Windows.** `electron-updater` installs on quit from `app.once('quit')` (`ElectronAppAdapter.onQuit`), running the installer silently without relaunch. A probe under the real Electron binary showed that `quit` still fires, with exit code 0, when a `before-quit` handler calls `preventDefault()` and then `app.exit(0)`. An explicit Restart calls `quitAndInstall(true, true)`, which spawns the installer and then calls `app.quit()`; the `quit` hook sees `quitAndInstallCalled` and does nothing, so the installer runs once.
- **macOS.** `MacUpdater` does not use the `quit` event. With `autoInstallOnAppQuit` set it hands the downloaded zip to Squirrel.Mac as soon as the download finishes, and Squirrel applies it when the app process exits. Whether it still applies after `app.exit(0)` needs a signed build to confirm (section 8).

## 4. IPC (5-file contract)

No payload carries a secret: no `SECRET_INPUT` tag, no allowlist entry.

| Channel | Kind | Payload in | Payload out |
|---|---|---|---|
| `updates:getState` | invoke | `{}` | `UpdateState` |
| `updates:restart` | invoke | `{}` | `{ restarting: boolean }` (`false` when the quit question was cancelled) |
| `updates:state-event` | main → renderer push | — | `UpdateState` |

`getState` exists because the push can fire before the renderer has subscribed (the update may finish downloading while the window loads); the renderer asks once on mount, then listens.

Files: `shared/types.ts` (`UpdateState`), `shared/ipc.ts` (`IpcApi.updates`, `IPC_CHANNELS`), `electron/preload.ts`, `electron/ipc/handlers/updates.ts` (`registerUpdatesChannels(router, svc)`, zod `NoInput`), `electron/main.ts` (construct and register). The push channel is added to the registration spec's push-event set.

## 5. Build and release

### 5.1 electron-builder.yml

- `mac.target: [dmg, zip]`. Squirrel.Mac installs from the zip; the dmg stays the human download.
- `publish: { provider: github, owner: anonhym, repo: latelier }`. With `--publish never` electron-builder still writes `app-update.yml` into the app's resources and the `latest*.yml` feed; the explicit block removes the dependency on repository auto-detection.
- Explicit asset names, so the file the workflow uploads is the file the feed names. GitHub rewrites an apostrophe in an uploaded name, and electron-builder's feed uses a different "safe" name when the product name is not GitHub-safe (observed in the 0.16.0 release: files `L.Atelier-…`, feed `latelier-…`). With a user-forced, GitHub-safe pattern the feed uses the real file name:
  - `mac.artifactName: L-Atelier-${version}-${arch}.${ext}`
  - `nsis.artifactName: L-Atelier-${version}-setup.${ext}`
- The arch must appear in the macOS file names: the macOS updater picks the arm64 or x64 zip by looking for `arm64` in the file URL.

### 5.2 release workflow

`release.yml` keeps `--publish never` and its upload step. One `latest-mac.yml` lists both arch zips (electron-builder merges them), so the macOS job builds `--x64 --arm64` as it does today. The macOS glob adds `release/*.zip.blockmap` so differential downloads work; without it the updater falls back to a full download.

## 6. Renderer

`src/features/updates/UpdateReadyPrompt.tsx` renders nothing itself. On mount it reads `api.updates.getState()` and subscribes with `api.updates.onState`. On `ready` it shows one Mantine notification through the existing `notify` wrapper: id `update-ready` (so a repeat replaces instead of stacking), `autoClose: false`, message "Version X is ready", action **Restart to update**. The action calls `api.updates.restart()`.

Dismissing the notification (its close button) does nothing else: the update installs on the next quit (`autoInstallOnAppQuit`; section 3.3). It is mounted once in `src/App.tsx`, inside the providers, where the app's other launch-time layers sit.

A failed `restart()` is the only user-visible error: a `notify.error` stating the update could not be applied now and will be applied on quit. It is not a modal.

Accessibility: the action is a native button inside the notification; no click handler on a non-interactive element.

## 7. Platform facts

- **macOS.** An update is installed only if its code signature matches the running app's. Auto-update therefore works from the first signed release onward. Installs of the last ad-hoc-signed release (0.16.0) cannot update into the signed one; they download and install it by hand once.
- **Windows.** No signing, so no publisher verification. Updates install; SmartScreen warnings are unchanged. The NSIS installer is the assisted type (`oneClick: false`); `quitAndInstall(true, true)` runs it silently and relaunches.
- **Release visibility.** The updater reads the latest published, non-draft, non-prerelease GitHub release. The macOS and Windows jobs upload at different times, so one platform's feed can be briefly missing right after a release; that client logs a warning and checks again next launch.

## 8. Open questions (settle by running a signed build)

- Does Squirrel.Mac still apply the staged update on macOS when the process leaves through `app.exit(0)` after the `before-quit` shutdown? (Windows is settled by the probe in section 3.3.) If not, dismissing the prompt only defers to the next explicit Restart, and the prompt text must say so.
- Does `build/installer.nsh` (the running-app check override) interfere with the silent updater run on Windows?
- Do the published `latest-mac.yml` and `latest.yml` urls resolve on the real release (`curl -I`)? A local unsigned build already shows every url and path in `latest-mac.yml` naming a file that exists, with `arm64` in the name; only the Windows file name could not be built off a Windows host.

## Acceptance criteria

- `electron-updater` 6.8.9 is an exact-pinned runtime dependency, listed in the main build's externals, and present in a packaged app's asar.
- The update check runs once per launch, only when packaged and `ATELIER_USER_DATA_DIR` is unset; never in dev or under e2e.
- A found update downloads in the background with no UI.
- When downloaded, one non-modal notification offers "Restart to update"; clicking it quits, installs and relaunches.
- Dismissing it leaves the update to install on next quit (verified on a signed build).
- Every updater failure is logged with the app logger and shown to no one.
- A packaged release's `latest-mac.yml` and `latest.yml` name files that exist as release assets under exactly those names, for both macOS arches.
- The macOS release contains a zip per arch and its blockmap; the Windows release is unchanged except for its file name.
- Linux packaging and behaviour are unchanged.
- No new IPC channel carries a secret; the registration spec and `npm run audit:ipc` pass.

## Test cases

Unit (`tests/unit/update-service.spec.ts`, fake `UpdaterLike`, no network):
- `shouldCheckForUpdates`: darwin or win32, packaged and no override → true; linux → false; not packaged → false; override set → false.
- `start()` disabled: the updater is never touched.
- `start()` enabled: `autoDownload` and `autoInstallOnAppQuit` are true; `checkForUpdates` called once.
- `update-downloaded` → state `ready` with the version; the emitter is called with it.
- `restart()` when ready calls `quitAndInstall(true, true)` exactly once; when idle throws and does not call it.
- `restart()` over running work asks once before installing; Cancel installs nothing and re-sends `ready`; Quit installs once and the quit that follows asks nothing.
- A rejected `checkForUpdates` and an `error` event are logged at warn and neither throws nor changes state.

Integration (`tests/integration/updates-handlers.spec.ts`, router shim):
- `updates:getState` returns the service state in an ok envelope.
- `updates:restart` returns ok when ready and an error envelope with a stable code when idle.
- An undefined payload returns a well-formed validation envelope, never a throw.
- `ipc-channel-registration.spec.ts` covers both new request channels and treats the state event as a push channel.

Component (`tests/component/update-ready-prompt.spec.tsx`, mocked `window.atelier`, with `<Notifications />` rendered):
- idle state: no notification.
- ready on mount: a notification naming the version with a Restart button.
- a pushed `ready` event shows it; a second push replaces rather than stacks.
- clicking Restart calls `updates.restart` once; a rejection shows an error notification, not a dialog.
- unmounting calls the unsubscribe returned by `onState`.
- no `role="dialog"` is present.

E2E: none added. The existing suite stays update-free because Playwright launches the unpackaged Electron and sets `ATELIER_USER_DATA_DIR`.

Manual (needs two consecutive signed releases; cannot be automated): install the first; publish the second; confirm the prompt, Restart, relaunch on the new version; repeat dismissing the prompt and quitting; open each feed URL and `curl -I` every file it names.

## Definition of done

Each ticket owes all eight gates in `CLAUDE.md` § Definition of done: code and build config, not docs-only. The mutation gate applies: `electron/services/UpdateService.ts` is added to `stryker.config.json`'s `mutate` array and its score hardened to the 90% break threshold.
