---
name: verify
description: Drive the built Electron app against a real mongodb-memory-server to observe a change at its surface. Use when verifying renderer or main-process behaviour by running the app rather than by running tests.
---

# Verifying by running the app

`npm run test:e2e` is the gate. This is the other thing — driving the app by hand
to watch a specific change behave. Same launch mechanism, no Playwright runner.

## Build first, always

```bash
npm run build     # tsc -b && vite build → dist/ + dist-electron/
```

`npx playwright test` does **not** rebuild. A correct fix has measured as broken
here because the bundle was stale. Rebuild after every source edit.

## Launch

The driver script must run **from the repo root** (`node ./__drive.mjs`), not from
the scratchpad — module resolution needs the repo's `node_modules`. Copy it in,
run it, delete it. Never leave it in a commit.

```js
import { _electron as electron } from 'playwright';
import { MongoMemoryServer } from 'mongodb-memory-server';

const mem = await MongoMemoryServer.create();
const u = new URL(mem.getUri().replace('mongodb://', 'http://'));  // → u.hostname, u.port

const app = await electron.launch({
  args: [path.resolve('dist-electron/main.js')],
  env: { ...process.env, ATELIER_USER_DATA_DIR: fs.mkdtempSync(...), NODE_ENV: 'test' },
});
const win = await app.firstWindow();
```

Always give a fresh `ATELIER_USER_DATA_DIR` — otherwise state leaks between runs.

## Catching crashes

The app has an ErrorBoundary, so a render crash shows a "Reload | Report" screen
rather than a dead window. Poll for it after every interaction, or a crash reads
as a passing step:

```js
const crashed = () => win.getByRole('button', { name: 'Reload' }).isVisible().catch(() => false);
```

Also hook `win.on('console')` for `error` and `win.on('pageerror')` — a clean run
ends with 0 of both.

## Creating a connection through the real form

Four things bite, in order:

1. **Connection type defaults to SRV**, which hides the port field entirely.
   Select `Standard (mongodb://)` first — it is the first `combobox` on General.
2. **Auth defaults to `Default (negotiate)`** and Save then fails validation on
   username + password. `mongodb-memory-server` has no auth: open the Auth tab
   and select `None` (first `combobox` on that tab).
3. Hostname/port inputs have no labels — target them by placeholder
   (`cluster.mongodb.net`, `27017`). Name is `My MongoDB Server`.
4. Opening a connection opens **no tab** (spec §4.6). Click the db, then the
   collection, to get a workspace.

```js
await win.getByRole('banner').getByRole('button', { name: /^Connection:/ }).click();
await win.getByRole('button', { name: 'Add connection' }).click();
// … fill … then:
await win.getByRole('button', { name: /^Save/i }).click();
// connect:
await win.locator('[role="option"][aria-label="Verify"]').click();
```

## Selector gotchas that have cost real time

- Navigator filter placeholder is `Filter…` with a **Unicode ellipsis** (U+2026),
  not three periods. Use `input[aria-label="Filter collections"]`.
- The sub-tab strip renders **uppercase via CSS** (`DOCUMENTS`, `AGGREGATION`,
  `STRUCTURE`) with an aria-hidden icon before each label. Match with
  `getByRole('tab').filter({ hasText: /aggregation/i })`, never `^Aggregation`.
- The navigator filter matches **collection** names, not database names. A db
  whose collections don't match is hidden entirely — that is by design.
- `tests/e2e/pages/` has page objects with the maintained selectors. Read them
  before inventing your own.

## Flows worth driving

- **Accordion (spec §4.2)** — at most one connection root expanded. Read
  `aria-expanded` on every root before and after; assert the siblings closed, not
  just that the target opened. A newly connected root auto-expands **only if
  nothing is expanded** (`prev ?? id`), so connecting a second one leaves the
  first open — that is correct.
- **Prototype-key names** — seed databases named `constructor` / `toString`.
  These are legal in MongoDB and once crashed the whole navigator.
- **Post-write refresh** — a pinned Edit/Insert drawer must refresh the tab it
  was pinned to, not the focused one (ADR-001).

## Evidence

Screenshot every step into a scratchpad dir and read the PNGs back. A step that
"passed" because a selector silently matched nothing is the common false green —
the screenshot is what catches it.
