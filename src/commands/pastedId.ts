const HEX24 = /^[0-9a-fA-F]{24}$/;
const WRAPPED = /^ObjectId\(\s*(?:"([0-9a-fA-F]{24})"|'([0-9a-fA-F]{24})')\s*\)$/;

/**
 * The 24 hexadecimal characters a query is made of, bare or wrapped as
 * `ObjectId("…")` / `ObjectId('…')`; null for any other query.
 */
export function parsePastedObjectId(query: string): string | null {
  const q = query.trim();
  if (HEX24.test(q)) return q;
  const wrapped = WRAPPED.exec(q);
  return wrapped ? (wrapped[1] ?? wrapped[2] ?? null) : null;
}
