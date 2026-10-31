import { api } from '../../../api/atelier';
import { lastRunSource } from './lastRunSource';
import { summarizeSchema } from '../../../pages/Workspace/schemaSummary';
import type { SchemaSampleEntry } from '@shared/types';
import type { FieldSource, FieldSuggestion } from '../types';

const DEFAULT_TTL_MS = 5 * 60 * 1000;
let ttlMs = DEFAULT_TTL_MS;

/**
 * Override the per-entry cache lifetime. Returns the previous value so
 * tests can stash and restore. Pass no arg to reset to the default.
 */
export function setSampleSchemaCacheTtl(nextMs?: number): number {
  const prev = ttlMs;
  ttlMs = nextMs ?? DEFAULT_TTL_MS;
  return prev;
}

interface CacheEntry {
  fetchedAt: number;
  suggestions: FieldSuggestion[];
  /** W17 — the same fetched sample, digested a second way. */
  structureEntries: SchemaSampleEntry[];
  /** The sampled docs themselves, for `sampleValuesSource`. */
  sampleDocs: unknown[];
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<CacheEntry>>();
// Bumped by every invalidation. A fetch that started under an older
// generation still answers its own caller but never writes the cache, so a
// sample read just before a write can't land after the invalidation and keep
// the pre-write fields for a whole TTL. Global, not per key: it errs toward
// skipping a cache write, never toward keeping a stale one.
let generation = 0;

function keyFor(connectionId: string, dbName: string, collection: string): string {
  return `${connectionId}:${dbName}:${collection}`;
}

/**
 * Pull a blended sample (recent + random) from main once per
 * collection+TTL, then digest it two ways — lastRunSource's path-extraction
 * into FieldSuggestion[], and summarizeSchema's per-field type histogram.
 * Failing fetches cache an empty result for the TTL window so we don't
 * hammer main on an unreachable collection.
 *
 * Both digestions ride one in-flight promise on purpose (W17 §1). Giving
 * each consumer its own would compile, pass every cache test, and silently
 * double the sample call.
 */
async function loadEntry(
  connectionId: string,
  dbName: string,
  collection: string,
): Promise<CacheEntry> {
  const key = keyFor(connectionId, dbName, collection);
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
      const res = await api.meta.sampleSchema({ connectionId, dbName, collection });
      // Reuse lastRunSource's walker by faking a context with the sample
      // as recentDocs. Tag the suggestions as coming from 'sampleSchema'.
      const digested = lastRunSource({
        connectionId,
        dbName,
        collection,
        recentDocs: res.docs,
      }) as FieldSuggestion[];
      entry = {
        fetchedAt: Date.now(),
        suggestions: digested.map((s) => ({ ...s, source: 'sampleSchema' })),
        structureEntries: summarizeSchema(res.docs),
        sampleDocs: res.docs,
      };
    } catch {
      entry = { fetchedAt: Date.now(), suggestions: [], structureEntries: [], sampleDocs: [] };
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

export const sampleSchemaSource: FieldSource = async (ctx) =>
  (await loadEntry(ctx.connectionId, ctx.dbName, ctx.collection)).suggestions;

/**
 * W17 — the sampled per-field type histogram behind the Update drawer's
 * type warning. Shares this module's cache key, TTL and in-flight fetch with
 * `sampleSchemaSource`; costs no extra round trip inside the TTL window.
 */
export async function getStructureEntries(
  connectionId: string,
  dbName: string,
  collection: string,
): Promise<SchemaSampleEntry[]> {
  return (await loadEntry(connectionId, dbName, collection)).structureEntries;
}

/**
 * The sampled docs behind `sampleSchemaSource`, for value suggestions. Shares
 * the same cache entry and in-flight fetch, so it costs no extra round trip.
 */
export async function getSampleDocs(
  connectionId: string,
  dbName: string,
  collection: string,
): Promise<unknown[]> {
  return (await loadEntry(connectionId, dbName, collection)).sampleDocs;
}

/**
 * Drop cached samples after something changed the data they were drawn from.
 * The renderer's write paths and the connection dialogs call it; X02 §9 lists
 * each one and the few left to the TTL. Also forgets in-flight fetches and
 * keeps them from re-caching their result.
 */
export function invalidateSampleSchemaCache(
  connectionId?: string,
  dbName?: string,
  collection?: string,
): void {
  generation++;
  // One collection is an exact key (a prefix would also hit `orders_archive`
  // when asked for `orders`); a bare connection id is a prefix.
  const matches = (k: string): boolean => {
    if (!connectionId) return true;
    if (dbName && collection) return k === keyFor(connectionId, dbName, collection);
    return k.startsWith(`${connectionId}:`);
  };
  for (const map of [cache, inflight]) {
    for (const k of [...map.keys()]) {
      if (matches(k)) map.delete(k);
    }
  }
}
