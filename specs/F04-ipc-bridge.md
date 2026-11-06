# F04 — IPC bridge & error envelope

> **Status: Implemented.**

## Purpose

Define the single typed channel through which the renderer talks to the main process. Every main-side capability used by the UI goes through this bridge; there are no hidden paths. This spec is the source of truth for the wire format — every other spec's "IPC contract" section refines a subset of it.

## Scope

- **In**: `preload.ts` contract, `contextBridge` exposure, channel namespace, envelope shape, validator pattern, error codes.
- **Out**: the specific channels themselves (defined in each domain spec).

## Dependencies

- F01, F03.

## 1. Envelope

Every IPC call resolves to:

```ts
// shared/ipc.ts
export type Envelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: IpcError };

export interface IpcError {
  code: IpcErrorCode;        // stable, programmatic
  message: string;           // human-readable, safe to display
  details?: unknown;         // optional structured detail (field path, etc.)
}

export type IpcErrorCode =
  | 'VALIDATION'             // payload failed validation
  | 'NOT_FOUND'
  | 'CONFLICT'               // uniqueness or state conflict
  | 'UNAUTHORIZED'           // e.g., bad Mongo creds
  | 'TIMEOUT'
  | 'NETWORK'
  | 'MONGO_ERROR'
  | 'DB_ERROR'
  | 'SECRETS_UNAVAILABLE'
  | 'SECRET_DECRYPT_FAILED'
  | 'READ_ONLY'             // write attempted on a read-only connection
  | 'UNTRUSTED_SENDER'      // rejected before dispatch — see §8.1
  | 'INTERNAL';
```

Renderer never receives a rejected promise from the bridge — transport errors are caught and converted to `{ ok: false, error: { code: 'INTERNAL', message } }`. Domain-level failures use the appropriate code.

`UNTRUSTED_SENDER` is the one code produced **before** any handler runs, and it is deliberately not an `AppErrorCode`: nothing throws it. It is distinct from `UNAUTHORIZED` because the renderer already reads `UNAUTHORIZED` as "your MongoDB user lacks permission", and sending someone to check their database grants over a message that never came from the app would be actively misleading.

## 2. Channel namespace

| Prefix   | Owner spec | Summary                                   |
| -------- | ---------- | ----------------------------------------- |
| `conn:`  | C02        | Connection CRUD                           |
| `mongo:` | F05, C06   | Connect, disconnect, ping, server info    |
| `meta:`  | C07, W02   | List databases, collections, indexes      |
| `query:` | W03        | `find`, `count`, `explain`                |
| `agg:`   | A04        | Run aggregation + per-stage preview       |
| `doc:`   | W08        | Insert, replace, update, delete documents |
| `saved:` | W09        | Saved queries CRUD                        |
| `recent:`| W10        | Recent queries                            |
| `tabs:`  | W01        | Workspace tab state restore/save          |
| `prefs:` | W10, X01   | Preview fields, theme, window state       |
| `app:`   | F06        | App-level events                          |

Channel names are `prefix:verb`, verbs in lower-case.

## 3. Preload

```ts
// electron/preload.ts
import { contextBridge, ipcRenderer } from 'electron';
import type { IpcApi } from '@shared/ipc';

const invoke = <T>(channel: string, payload?: unknown): Promise<T> =>
  ipcRenderer.invoke(channel, payload);

const api: IpcApi = {
  conn: {
    list:    () => invoke('conn:list'),
    get:     (id) => invoke('conn:get', { id }),
    create:  (input) => invoke('conn:create', input),  // SECRET_INPUT
    update:  (id, input) => invoke('conn:update', { id, input }),  // SECRET_INPUT
    delete:  (id) => invoke('conn:delete', { id }),
    test:    (input) => invoke('conn:test', input),  // SECRET_INPUT
    touchUsed: (id) => invoke('conn:touchUsed', { id }),
  },
  mongo: { /* … */ },
  meta:  { /* … */ },
  query: { /* … */ },
  agg:   { /* … */ },
  doc:   { /* … */ },
  saved: { /* … */ },
  recent:{ /* … */ },
  tabs:  { /* … */ },
  prefs: { /* … */ },
  app:   { /* … */ },
};

contextBridge.exposeInMainWorld('atelier', api);
```

- `nodeIntegration: false`, `contextIsolation: true` in `BrowserWindow.webPreferences` (already set). These stay.
- **No `ipcRenderer.on`** exposure. Event streams (see §6) use a narrow wrapper.
- `SECRET_INPUT` comment marks channels that accept plaintext secrets so a CI grep can audit them.

## 4. Renderer wrapper

```ts
// src/api/atelier.ts
function unwrap<T>(env: Envelope<T>): T {
  if (!env.ok) throw env.error;  // throws the IpcError object directly
  return env.data;
}

export const api = new Proxy(window.atelier, { … });  // each call awaits and unwraps
```

Usage:
```tsx
try {
  const conns = await api.conn.list();
  // …
} catch (e) {
  const err = e as IpcError;
  if (err.code === 'DB_ERROR') showBanner('Could not load connections');
}
```

Components are expected to handle `IpcError` objects, not generic `Error` instances.

## 5. IPC router (main)

```ts
// electron/ipc/router.ts
import { ipcMain } from 'electron';

type Handler<I, O> = (payload: I) => Promise<O> | O;

export function register<I, O>(
  channel: string,
  validate: (payload: unknown) => I,
  handler: Handler<I, O>,
) {
  ipcMain.handle(channel, async (_evt, raw) => {
    try {
      const input = validate(raw);
      const data = await handler(input);
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: toIpcError(err) };
    }
  });
}
```

- `validate` is a Zod schema's `.parse()` or a hand-written checker; failure throws `ValidationError` which `toIpcError` maps to `code: 'VALIDATION'`.
- `toIpcError` is the single place that converts thrown errors to the envelope form. `MongoError` → `code: 'MONGO_ERROR'`, `NotFoundError` → `code: 'NOT_FOUND'`, etc.
- Uncaught errors fall through to `INTERNAL` with the message preserved; the stack is logged via `log.error` but **not** returned to the renderer.

## 6. Event streams

Some features (future: long-running aggregation progress) need push from main to renderer. Iteration 1 only needs one: **app:theme-changed** when the OS theme flips (if auto-theme). Pattern:

```ts
// preload.ts
app: {
  onThemeChanged: (cb: (v: 'light'|'dark') => void) => {
    const listener = (_e: unknown, v: 'light'|'dark') => cb(v);
    ipcRenderer.on('app:theme-changed', listener);
    return () => ipcRenderer.removeListener('app:theme-changed', listener);
  },
},
```

Only `on*`/returned-unsubscribe handlers are exposed — raw `ipcRenderer` never leaks.

## 7. Validation

- **Zod** is used for every input schema. Schemas live next to the router registration.
- **Shared types** (`shared/types.ts`) are the source of truth; each Zod schema is paired with a `z.infer<...>` that should equal the shared type (enforced by a type-level test).

```ts
const CreateConnectionInput = z.object({
  name: z.string().min(1).max(64),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  // …
  password: z.string().optional(),   // SECRET
});
type Parsed = z.infer<typeof CreateConnectionInput>;
assertEqual<Parsed, CreateConnectionInput>();  // compile-time
```

## 8.1 Sender validation

Every `invoke` is checked before dispatch and answered with `UNTRUSTED_SENDER` if it fails. Two conditions, both required:

1. **Frame identity** — `event.senderFrame` is the window's current main frame. This rejects a subframe or any other `WebContents`.
2. **App location** — that frame's URL is the app's own document. Identity alone is not enough: if a top-level navigation ever replaced the document, the foreign page's frame *is* the window's current main frame, and an identity check would call it trusted.

The location rule is asymmetric by design (`electron/security/appLocation.ts`):

| Loaded from | Rule | Why |
| --- | --- | --- |
| `file:` (packaged) | exact document, fragment and query stripped | Every file URL reports its origin as the string `"null"`, so an origin comparison accepts any local file |
| `http(s)` (dev server) | same origin, any path | The dev server is trusted and Vite moves between paths; pinning the path breaks Fast Refresh without making anything safer |

Neither may be implemented as a string-prefix test. `http://localhost:5173@evil.example/` starts with the dev server URL and its parsed origin is `http://evil.example`, because everything before the `@` is userinfo.

The check is a **required** argument to `createRouter`. A default would be a check that can be dropped from production wiring while every test stays green.

The same predicate backs the `will-navigate` guard, so the navigation rule and the sender rule cannot drift.

## 8. Security audit checklist

- `contextIsolation: true`, `nodeIntegration: false`, **`sandbox: true`** set on the window. The preload reaches only for `contextBridge` and `ipcRenderer`, both of which a sandboxed preload still gets; a preload that needs `fs` or `path` would have to give this up, and the OS-level sandbox is worth more than the convenience.
- Every channel passes sender validation (§8.1); `createRouter` cannot be constructed without it.
- `preload.ts` exposes ONLY the `atelier` object; nothing else reaches `window`.
- `webSecurity` stays at its default `true`.
- No channel declared in this spec returns plaintext secrets.
- CI grep: `grep -r "SECRET_INPUT" electron/` matches only channels in the permitted list (`conn:create`, `conn:update`, `conn:test`).

## 9. Acceptance criteria

- Renderer code compiles with only imports from `@shared/ipc` and `@shared/types`.
- Calling a non-existent channel returns `{ ok: false, error: { code: 'INTERNAL' } }` (via `ipcMain.handle` default).
- Calling a channel with malformed payload returns `code: 'VALIDATION'` and a message naming the failed field.
- An `invoke` from a frame that is not the window's main frame returns `code: 'UNTRUSTED_SENDER'`, and the handler never runs.
- An `invoke` from the window's main frame **after it holds a foreign document** returns `code: 'UNTRUSTED_SENDER'`.
- A denied request is not written to the log at `debug` — an untrusted payload is not ours to record.
- Every registered channel has a schema.
- The `debug` request line (`ipc.req`) records the payload's shape (top-level key names and value types; a nested object only as its key count, since its keys can be data such as document ids), never a value.
- `router.register` and preload's `call` are typed against `ChannelSig` in `shared/ipc.ts`, which is total over the invoke channels and read off `IpcApi` except for the bindings preload adapts (written out beside it): a handler whose result differs from the channel's `ChannelSig` entry, or a schema that refuses a payload preload sends, fails `tsc -b`.

## 10. Test cases

### Unit
- **envelope.spec.ts**: `toIpcError(new ValidationError(...))` → `code: 'VALIDATION'`. `toIpcError(new Error('x'))` → `code: 'INTERNAL'` with no stack leaked.
- **zod-parity.spec.ts**: each Zod schema's inferred type equals the shared type (uses `expectTypeOf`).
- **router-channel-signature.spec.ts**: compiled by `tsc -b`; `@ts-expect-error` registrations with a wrong result, a schema that refuses the wire payload, a schema requiring a field preload never sends, a push-event channel and an unknown channel must each fail to compile.
- **log.spec.ts / log.property.spec.ts** (`describeShape`): no leaf value, and no generated string, ever reaches the output; depth, element and key caps; cycles.

### Integration
- **router-dispatch.spec.ts**: Spin up a mock `ipcMain` (`electron`'s test harness or a custom shim), register a dummy channel, call via `ipcRenderer.invoke` in a child Electron process, verify envelope semantics for success, validation failure, domain failure.

### E2E
- **no-leakage.spec.ts**: Playwright launches the app and evaluates `Object.keys(window)` → must not contain `ipcRenderer`, `require`, or `process`.
