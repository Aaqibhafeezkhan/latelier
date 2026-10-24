# X01 — Theme & window state persistence

> **Status: Implemented.** Theme changes arrive on `prefs:theme-event`, not on the `prefs:watch` channel named here.

## Purpose

Move theme preference and window geometry from renderer-only `localStorage` (current state) to main-process-owned persistence in the `app_state` table, so both are authoritative across renderers, survive hard reloads, and follow the "all state in main" rule.

## Scope

- **In**: `AppStateService`, `prefs:*` channels for theme + window bounds, window-bound capture/restore in main, renderer `ThemeContext` rewire.
- **Out**: Per-collection preview fields (W10), per-tab UI state (W01).

## Dependencies

- F02 (`app_state`), F06 (applies window bounds at startup).

## 1. Keys

`app_state` stores a tiny KV: `{ key, value_json, updated_at }`. Well-known keys used in iteration 1:

| Key                   | Shape                                                     |
| --------------------- | --------------------------------------------------------- |
| `theme.mode`          | `'light' \| 'dark' \| 'system'`                          |
| `window.bounds`       | `{ x, y, width, height }`                                 |
| `window.maximized`    | `boolean`                                                 |
| `ui.showSystemDbs`    | `boolean`                                                 |
| `agg.instrumentation` | `'facet' \| 'separate' \| 'off'` (A04)                   |

## 2. Service

```ts
// electron/services/AppStateService.ts
export class AppStateService {
  get<T>(key: string): T | null;
  set<T>(key: string, value: T): void;
  delete(key: string): void;
}
```

Reads/writes synchronously via `AppStateRepo`. Cached in-process map to avoid hot re-reads.

## 3. IPC

| Channel          | Input                     | Output        |
| ---------------- | ------------------------- | ------------- |
| `prefs:get`      | `{ key }`                 | `unknown \| null` |
| `prefs:set`      | `{ key, value }`          | `unknown`     |
| `prefs:watch`    | `{ key }`                 | subscription (event stream) |

`prefs:watch` lets the renderer react to changes the main side may make (e.g., OS theme change with mode `'system'`).

Specific, typed helpers are exposed on `window.atelier.prefs`:
- `prefs.getTheme(): Promise<'light'|'dark'|'system'>`
- `prefs.setTheme(mode)`
- `prefs.onThemeChanged(cb)`
- (etc., for each key above)

## 4. Theme

### Modes
- `light`: force light.
- `dark`: force dark.
- `system`: follow `nativeTheme.shouldUseDarkColors` (Electron). Re-emits on OS change via `nativeTheme.on('updated', ...)`.

### Renderer
- `ThemeContext` replaces the current `localStorage`-backed hook:
  ```ts
  useEffect(() => {
    api.prefs.getTheme().then(setMode);
    const off = api.prefs.onThemeChanged(setMode);
    return off;
  }, []);
  ```
- `toggle()` calls `api.prefs.setTheme(next)`. Main persists + broadcasts; the renderer updates on the broadcast.
- Default on first run: `'system'`.

### Settings

The Settings modal exposes the stored mode as a Light / Dark / System segmented control. It reads and writes through `useThemeMode()` (`api.prefs.getTheme`, `onThemeChanged`, `setTheme`), so the header toggle and any other `useTheme()` caller follow it through the main-process broadcast. A rejected save reverts the control and shows a toast.

Settings also holds three renderer preferences, each an allow-listed `prefs` key (`electron/ipc/prefKeys.ts`):

| Key                            | Shape                           | Effect                                                           |
| ------------------------------ | ------------------------------- | ---------------------------------------------------------------- |
| `ui.workspace.defaultPageSize` | one of 10, 25, 50, 100, 250, 500 | seeds a new collection tab's page size                           |
| `ui.workspace.defaultView`     | `'Table' \| 'Tree' \| 'JSON'`   | seeds a new collection tab's result view                         |
| `ui.editor.fontSize`           | integer 10–20                   | read at boot and set live as `--atelier-editor-font-size` (px)   |

### Migration
On first start after upgrade, if `localStorage['ml-theme']` exists, migrate it to `app_state['theme.mode']` and clear the localStorage key. (One-time in renderer code.)

## 5. Window state

### Capture
- In main, after the window is created and visible, hook `resize`, `move`, and `maximize`/`unmaximize` events.
- Debounced 400ms write to `app_state['window.bounds']` = current `getBounds()` (only when not maximized). On maximize/unmaximize, write `app_state['window.maximized']`.
- Multi-screen safety: on restore, if the stored bounds do not overlap any current `screen.getAllDisplays()`, fall back to defaults (1280×800 centered).

### Restore
- In main at boot (F06), read both keys. Apply to `new BrowserWindow({ ...bounds, show: false })`. If maximized, call `win.maximize()` after `ready-to-show`.

## 6. Acceptance criteria

- Theme toggles persist across relaunches and across hard reloads of the renderer.
- Switching to `system` tracks OS theme in real time.
- Moving the window and quitting restores the same position next launch.
- Maximizing and quitting reopens maximized.
- A bounds value that would place the window offscreen is discarded in favor of defaults.
- No calls to `localStorage` remain in the renderer for theme.
- Settings offers Light, Dark and System; choosing System persists across a relaunch.
- A collection tab opened after changing the default page size or result view starts with those values; a stored value outside the allowed set is ignored.

## 7. Test cases

### Integration
- **kv-crud.spec.ts**: set/get/delete a key; surfaces updated_at bump.
- **theme-default.spec.ts**: no prior value → `getTheme` returns `'system'`.
- **system-theme-flip.spec.ts**: stub `nativeTheme` toggle → `onThemeChanged` callback fires with new value.
- **migration.spec.ts**: seed `localStorage` shim with `ml-theme=dark` → on init, `app_state['theme.mode'] === 'dark'` and localStorage cleared.
- **bounds-offscreen.spec.ts**: stored bounds outside all displays → restored to defaults.

### E2E
- **theme-persist.e2e.ts**: toggle to dark → quit → relaunch → dark still applied. Pick System in Settings → quit → relaunch → still System.
- **window-bounds.e2e.ts**: move + resize → quit → relaunch → same bounds.
