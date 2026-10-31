/**
 * Edits the renderer holds back before saving (the tab state's debounce) can
 * be pushed out on demand. Main asks for that before it quits, and the page
 * answers through `flushAll` (see `FlushOnQuit`).
 */
type Flusher = () => Promise<void>;

const flushers = new Set<Flusher>();

/** Adds a flusher until the returned function removes it. */
export function registerFlusher(fn: Flusher): () => void {
  flushers.add(fn);
  return () => {
    flushers.delete(fn);
  };
}

/** Runs every registered flusher at once and resolves when all of them have. */
export async function flushAll(): Promise<void> {
  await Promise.all([...flushers].map((fn) => fn()));
}
