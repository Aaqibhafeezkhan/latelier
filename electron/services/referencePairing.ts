import { deserialize, serialize } from 'bson';
import { ejsonEncode } from '../mongo/ejson.ts';

/**
 * The string a source value and a found document's field are paired by. EJSON
 * collapses ObjectId, Date and the like to something comparable; promoting first
 * makes Int32(5), Long(5) and Double(5) one key, because `$in` matched them as
 * one value and each side still spells it in its own type.
 */
export function matchKey(v: unknown): string {
  return JSON.stringify(ejsonEncode(deserialize(serialize({ v }), { bsonRegExp: true }).v, false));
}

/**
 * Every value `path` reaches in `doc`, fanning out through arrays the way a
 * query on that path does, so `n.k` over `n: [{k: 1}, {k: 2}]` reaches both.
 * A leaf array also stands for each of its elements, as `$in` matches either.
 */
// ponytail: numeric path segments (`n.0.k`) are read as field names, not positions. Add when a reference keys on one.
export function valuesAtPath(doc: unknown, path: string): unknown[] {
  let level: unknown[] = [doc];
  for (const seg of path.split('.')) {
    const next: unknown[] = [];
    const read = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(read);
      else if (typeof v === 'object' && v !== null) {
        next.push(Object.hasOwn(v, seg) ? (v as Record<string, unknown>)[seg] : undefined);
      }
    };
    level.forEach(read);
    level = next;
  }
  return level.flatMap((v) => (Array.isArray(v) ? [v, ...v] : [v]));
}

/**
 * Put `docs` in the order of the source values that selected them. A document
 * pairs with the first source value whose key it carries (`keysOf[i]` are the
 * values document i is found by); a document that pairs with none, because the
 * server compares numbers across types where an EJSON key does not, follows in
 * the order the server returned it. Nothing the server matched is dropped.
 */
export function pairInSourceOrder(source: unknown[], docs: unknown[], keysOf: unknown[][]): unknown[] {
  const byKey = new Map<string, number[]>();
  keysOf.forEach((keys, i) => {
    for (const key of new Set(keys.map(matchKey))) {
      const bucket = byKey.get(key);
      if (bucket) bucket.push(i);
      else byKey.set(key, [i]);
    }
  });
  const taken = new Set<number>();
  const out: unknown[] = [];
  const take = (i: number): void => {
    if (taken.has(i)) return;
    taken.add(i);
    out.push(docs[i]);
  };
  for (const v of source) (byKey.get(matchKey(v)) ?? []).forEach(take);
  docs.forEach((_, i) => take(i));
  return out;
}
