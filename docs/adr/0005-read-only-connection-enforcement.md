# Read-only connection enforcement: three enforcement points, not one

## Status

accepted

## Context

MongoDB writes reach the app through three architecturally distinct paths: clean single-purpose IPC channels (`doc:*`, `collection:*`, `database:drop`, `index:*`, `user:*`, `agg:runAndSave`), a channel whose write-ness depends on pipeline content (`agg:run` — only a write if it contains `$out`/`$merge`), and two panes that hand sandboxed code a live MongoDB driver handle (the script editor and the shell REPL, both via `makeDbProxy()` in `electron/mongo/dbProxy.ts`). No single guard location can cover all three.

Within the first of those paths there is a second question, distinct from *where* the guard lives: what shape it takes. A guard can be a call each write-service method remembers to make, or a handle each write-service method has to ask for. The first was tried. It works, and it is forgettable — nothing connects "I obtained a `Db`" to "I am allowed to write through it", so every new write method has to be told the rule by a comment:

```ts
/** Throws ReadOnlyConnectionError if the connection is read-only. Call at
 *  the top of every write-service method, before any Mongo call. … */
```

A rule a comment has to state is a rule that can be omitted, and the compensating unit test says as much in its own header: *"nothing forces a new write channel to get one."* Two shipped defects were that omission — `923c90a`, where the shell pane checked at `start()` but not at `write()`, and `53c4469` / #451, where `db.collection('x').find()` took a path around the script pane's proxy that `db.x.find()` did not.

## Decision

- **Named write channels + `agg:run`**: `MongoPool` does not hand out neutral handles. Reads ask for one directly (`readDb`, `readClient`). Writes ask for a **grant** — `pool.write(connectionId)` — which refuses a read-only connection *synchronously* and hands back the only route to a writable handle; nothing connects until the caller asks the grant for one (`grant.db()`, `grant.client()`). The refusal itself is `assertWritable(connectionId)`, backed by a connection lookup already available via `MongoPool`; it is called *by* the grant rather than by each service.

  The two-step shape is load-bearing, not ceremony. Refusal and connection happen at different points in a write method and have to stay there:

  ```
  pool.write(id)        // top: refuse before anything else
  validate(input)       // middle: local checks, no network
  await grant.db(name)  // bottom: connect
  ```

  A single awaited `writeDb(...)` cannot occupy all three positions, and each choice breaks something observable. Put it at the top and local validation starts failing as connection errors against an unreachable server, burying the input error under an incidental one. Put it at the bottom and a malformed payload on a read-only connection reports `VALIDATION` where it previously reported `READ_ONLY` — the less useful answer, since the connection cannot be written at all. Both were observed, in different files, when this was one call.

  Not a router-level tag on `router.register()` — that seam can't express `agg:run`'s per-pipeline conditionality, and CLAUDE.md's router/service layering ("routers thin; just zod-validate + call service") argues for the check living where the write semantics are already known. The handle sits exactly there: `AggregationService` still inspects its own pipeline for `$out`/`$merge` and *then* asks for the handle that matches the answer. Where a shared helper serves both read and write callers, it takes the caller's determination as a parameter rather than re-deriving it — re-deriving would be the router-tag mistake in miniature.

- **Script pane**: `dbProxy.ts`'s `get` trap uses an allowlist of read methods, not a denylist of write methods. The pane takes a *read* client: a handle cannot express what scripted code will do, so enforcement belongs at the proxy. **Amended (ADR 0014), twice:** this paragraph used to say the script sandbox has no `require`/process access, so the guard was a real boundary. That was wrong: `node:vm` is not a sandbox. The proxy first moved into a script-runner child process that owned its own client and credentials, which made it only a UI safety guard. It now runs in **main**: the child holds no client or credentials, its `db` is a facade that sends every call to main as an RPC, and main executes it through `makeDbProxy` over the pool's client, after a per-object method allowlist, with the flag read live from the stored connection on each call. So for the script pane read-only is enforced in main on every route, including a frame posted by hand from a script that has escaped its `vm` context; a flip is honoured by the next call, and additionally stops the connection's running scripts. What this does not do: an escaped script is still a process of the OS user, and against a deployment that needs no authentication it can connect directly and write. MongoDB roles remain the authoritative control.
- **Shell pane**: its REPL context exposes `require`/`process` (verified directly) — any proxy-level guard is bypassable (`require('child_process')`) and would be a false guarantee. `mshell:start`/`mshell:write` are refused outright when the connection is read-only, instead. **Amended (ADR 0014):** the REPL no longer runs in main. It runs in a runner child that holds no client or credentials, and its `db` goes through the same host in main as a script's, which also reads the flag live. The wholesale refusal is unchanged and still the right rule, because the child still has `require`/`process` as the OS user, so a guard on `db` alone would not hold; the move changes what an escape can reach (no credentials, nothing of main's), not whether the session is safe to offer read-only. A session open when the connection turns read-only is ended. This refusal is session-wide rather than handle-shaped, and `write()` is synchronous, so it calls `assertWritable` directly — the same primitive the write handles use, never a second copy of the rule. That is why `assertWritable` stays public despite services having no business calling it.

## Consequences

A read-only connection's shell pane is unusable entirely, even for read queries — traded for an enforcement claim that's actually true rather than one that looks complete and isn't (matches the reasoning elsewhere for why enforcement can't be UI-only: the shell pane is not a sandbox, even now that it runs in a child).

The script-pane allowlist rewrite touches the same `get` trap responsible for a pre-existing bug where `db.collection('x').find()` (as opposed to `db.x.find()`) bypasses this file's cancellation-signal threading — same root cause, same fix site. Filed as a separate issue, blocking this feature.

**What the handle shape buys is a failure mode, not a guarantee.** This is worth stating plainly because it is easy to overclaim. A write-service method can still call `readDb` and write through the returned `Db`; the driver will not stop it. The change is that a missing guard used to be *invisible* — nothing in the diff, the types or the tests said anything was absent — whereas a method named `insertOne` asking for a read handle is visible on the line where it happens. The guard moved from a line you must remember to add, to a handle you must ask for. That is a smaller claim than "unbypassable", and it is the true one.

**Four call sites back both a read and a write**, and each needed an answer rather than a default: `CollectionAdminService.create` does a `listCollections()` pre-check before `createCollection()` and takes a *write* grant, with the refusal still preceding the pre-check; `AggregationService`'s shared collection helper takes the caller's grant — or `null` for a read — as a parameter; `ScriptService.run` and `ShellService.start` take *read* clients, because enforcement for those two lives at points 2 and 3.

**Cancellation must be registered before anything connects.** `agg:run` takes its grant early but must not connect until after `registerCancel`, or an `agg:cancel` arriving mid-connect finds no entry, discards the cancellation, and lets the pipeline — `$out` included — run to completion once the connection resolves.

**The refusal is checked at grant time, not at every operation.** A connection flipped to read-only after a grant is taken is not re-checked by that grant. The same window existed when the check was a call at the top of the method, so this is not new — but it is the same shape as the script pane's stale `readOnly` (#710), and worth knowing before someone reports it as a fresh defect.

**A green typecheck does not prove a change to this surface landed.** Several test fake pools are cast `as unknown as MongoPool`, which launders the type — renaming a pool method compiles clean and fails only at test runtime. Recorded here because the same trap will catch the next person who changes it. For the same reason, the read-only integration tests assert the error *class* and not its message; a message regression passes them silently.

**A control client sits beside the grant, not behind it.** `MonitorService.killOp` (and `AggregationService.killWrite` before it) takes `pool.write(id)` only for its synchronous refusal and then runs the kill over `pool.openControlClient(id)`, not over the grant's handle, because on the pooled client a kill queues behind the very op it targets when that op holds the pool's last connection. `MonitorService.currentOp` uses a control client for the same reason, as a read with no grant. The refusal still comes first, so a read-only connection never reaches the control client on the kill path; what this gives up is the "the grant is the only route to a writable handle" shape, for these two calls.

**The channel-classification test is kept.** `tests/unit/read-only-channel-classification.spec.ts` answers "was this channel classified at all", which the handle does not. Retiring it would be a separate decision on separate evidence.

## Considered and rejected

- **A single router-level `{ write: true }` tag**, extracting `connectionId` from validated input at `router.register()`. Rejected: can't express `agg:run`'s conditionality without a second mechanism anyway, so it doesn't actually simplify anything over a service-layer guard.
- **Per-method interception inside `makeDbProxy` for the shell pane too**, mirroring the script pane's fix. Rejected after confirming the shell's REPL context has direct `require`/`process` access — a method-level guard there can be walked around, so it would ship a guarantee the pane can't keep.
- **A guard each write-service method calls by hand**, rather than one carried by the handle. This was the original mechanism here. Rejected on evidence: it is omittable, its own compensating test says so, and it shipped the defect twice.
- **Making the handle genuinely unbypassable**, by returning every read handle wrapped in a deny-by-default proxy the way `makeDbProxy` already works for the script pane. Rejected on cost: it puts a proxy in every read path in the application — every `find`, every `listCollections`, every schema sample — to close a gap that review already catches once the handle name is wrong, and `dbProxy.ts` has its own history of paths around it (#451). The cost is certain and the benefit is not.
