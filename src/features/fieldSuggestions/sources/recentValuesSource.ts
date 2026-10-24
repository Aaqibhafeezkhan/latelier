import { api } from '../../../api/atelier';
import { isSecretFieldPath } from '../../../utils/secretFieldPath';
import type { ValueSource, ValueSuggestion } from '../types';

const DEFAULT_TTL_MS = 5 * 60 * 1000;
let ttlMs = DEFAULT_TTL_MS;

/** Override the per-entry cache lifetime. Returns the previous value so tests can stash and restore. */
export function setRecentValuesCacheTtl(nextMs?: number): number {
  const prev = ttlMs;
  ttlMs = nextMs ?? DEFAULT_TTL_MS;
  return prev;
}

interface CacheEntry {
  fetchedAt: number;
  suggestions: ValueSuggestion[];
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<CacheEntry>>();
// Bumped by every invalidation. A fetch that started under an older
// generation still answers its own caller but never writes the cache, so a
// response racing a "Clear value history" or a post-run recording can't put
// stale values back for a whole TTL.
let generation = 0;

function keyFor(connectionId: string, dbName: string, collection: string, field: string): string {
  return `${connectionId}:${dbName}:${collection}:${field}`;
}

/**
 * Values recorded for this `(conn, db, coll, field)` in earlier runs
 * (Source 2, X02 "Value suggestions"). Fails open to `[]` — a lookup
 * failure here must never block the value popover, only leave it emptier.
 * Same shape as `sampleSchemaSource`: one in-flight promise per key so two
 * popover opens inside the TTL window don't double the round trip.
 */
async function loadEntry(
  connectionId: string,
  dbName: string,
  collection: string,
  field: string,
): Promise<CacheEntry> {
  const key = keyFor(connectionId, dbName, collection, field);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.fetchedAt < ttlMs) return hit;

  const pending = inflight.get(key);
  if (pending) return pending;

  const startedIn = generation;
  // Held in an object so the fetch's own `finally` can compare against it.
  const self: { promise?: Promise<CacheEntry> } = {};
  self.promise = (async () => {
    let entry: CacheEntry;
    try {
      const res = await api.recent.valuesForField({ connectionId, dbName, collection, field });
      entry = {
        fetchedAt: Date.now(),
        suggestions: res.values.map((v): ValueSuggestion => ({
          kind: 'value',
          value: v.value,
          display: v.value,
          // Every ValType is also a DisplayType name.
          type: v.valType,
          source: 'recent',
          frequency: v.frequency,
        })),
      };
    } catch {
      entry = { fetchedAt: Date.now(), suggestions: [] };
    } finally {
      // An invalidation may already have dropped this entry and a newer fetch
      // taken its key; only remove our own.
      if (inflight.get(key) === self.promise) inflight.delete(key);
    }
    if (startedIn === generation) cache.set(key, entry);
    return entry;
  })();

  inflight.set(key, self.promise);
  return self.promise;
}

export const recentValuesSource: ValueSource = async (ctx) => {
  // Main never records a secret-named field; this keeps the read side to
  // the same rule, whatever the store holds.
  if (isSecretFieldPath(ctx.target.field)) return [];
  return (await loadEntry(ctx.connectionId, ctx.dbName, ctx.collection, ctx.target.field)).suggestions;
};

/** Exposed for tests and for the invalidation after a successful find records new values. */
export function invalidateRecentValuesCache(
  connectionId?: string,
  dbName?: string,
  collection?: string,
): void {
  generation++;
  const prefix = !connectionId
    ? ''
    : dbName && collection
      ? `${connectionId}:${dbName}:${collection}:`
      : `${connectionId}:`;
  for (const map of [cache, inflight]) {
    for (const k of [...map.keys()]) {
      if (k.startsWith(prefix)) map.delete(k);
    }
  }
}
