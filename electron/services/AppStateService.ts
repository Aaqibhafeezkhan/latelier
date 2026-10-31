import type { AppStateRepo } from '../db/repositories/AppStateRepo.ts';

export type AppStateListener<T = unknown> = (value: T | null) => void;

/**
 * Read/write app_state with an in-process cache and per-key change listeners.
 * Mirrors AppStateRepo's get/set/delete signatures so it can substitute for
 * the repo where needed (e.g., MaintenanceService).
 */
export class AppStateService {
  private repo: AppStateRepo;
  private cache = new Map<string, unknown>();
  private loaded = new Set<string>();
  private listeners = new Map<string, Set<AppStateListener>>();

  constructor(repo: AppStateRepo) {
    this.repo = repo;
  }

  get<T>(key: string): T | null {
    if (this.loaded.has(key)) {
      return (this.cache.get(key) as T | undefined) ?? null;
    }
    const value = this.repo.get<T>(key);
    this.cache.set(key, value);
    this.loaded.add(key);
    return value;
  }

  set<T>(key: string, value: T): void {
    this.repo.set(key, value);
    this.cache.set(key, value);
    this.loaded.add(key);
    this.emit(key, value);
  }

  delete(key: string): void {
    this.repo.delete(key);
    this.cache.delete(key);
    this.loaded.delete(key);
    this.emit(key, null);
  }

  /** Forgets every cached value, after the table was emptied underneath (the dev reset). */
  reset(): void {
    this.cache.clear();
    this.loaded.clear();
  }

  /** Subscribe to in-process changes for `key`. Returns an unsubscribe fn. */
  subscribe<T>(key: string, cb: AppStateListener<T>): () => void {
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(cb as AppStateListener);
    return () => {
      set?.delete(cb as AppStateListener);
    };
  }

  private emit<T>(key: string, value: T | null): void {
    const set = this.listeners.get(key);
    if (!set) return;
    for (const cb of set) cb(value);
  }
}
