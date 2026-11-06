import { randomUUID } from 'node:crypto';
import { deserialize, serialize } from 'bson';
import type {
  ReferenceAutodetectCandidate,
  ReferenceAutodetectInput,
  ReferenceResolveInput,
  ReferenceResolveResult,
  ReferenceRule,
  ReferenceRuleCreateInput,
  ReferenceRuleUpdateInput,
} from '@shared/types';
import { NotFoundError } from '../errors.ts';
import { classifyMongoOpError } from '../mongo/errors.ts';
import { ejsonEncode, parseEjsonField } from '../mongo/ejson.ts';
import type { MongoPool } from '../mongo/MongoPool.ts';
import { EXACT_BSON } from '../mongo/undo.ts';
import { ownSet } from '../ownProperty.ts';
import type {
  ReferenceRulePatch,
  ReferenceRulesRepo,
} from '../db/repositories/ReferenceRulesRepo.ts';

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * The string a source value and a found document's field are paired by. EJSON
 * collapses ObjectId, Date and the like to something comparable; promoting first
 * makes Int32(5), Long(5) and Double(5) one key, because `$in` matched them as
 * one value and each side still spells it in its own type.
 */
function matchKey(v: unknown): string {
  // ponytail: a Decimal128, a -0, and a Long against a Double past 2^53 do not promote to the same value, so such a match is left out of the list. Compare numerically if a reference ever keys on those.
  return JSON.stringify(ejsonEncode(deserialize(serialize({ v }), { bsonRegExp: true }).v, false));
}

function normalizeProjection(projection: string[] | undefined): string[] {
  if (!projection) return [];
  return Array.from(new Set(projection.map((p) => p.trim()).filter((p) => p.length > 0)));
}

export function projectionToMongo(fields: string[]): Record<string, 1> | undefined {
  if (fields.length === 0) return undefined;
  const out: Record<string, 1> = {};
  for (const f of fields) ownSet(out, f, 1);
  // Always carry `_id` so the drawer can render a stable identifier.
  out._id = 1;
  return out;
}

/** Convert `"contacts"` → `"contact"` using a few forgiving rules. */
function singularize(word: string): string {
  if (word.length <= 2) return word;
  if (/ies$/.test(word)) return word.slice(0, -3) + 'y';
  if (/ses$/.test(word)) return word.slice(0, -2);
  if (/s$/.test(word)) return word.slice(0, -1);
  return word;
}

function pluralize(word: string): string {
  if (/s$/.test(word)) return word;
  if (/y$/.test(word) && !/[aeiou]y$/.test(word)) return word.slice(0, -1) + 'ies';
  return word + 's';
}

/**
 * Find candidate reference fields by naming convention. Matches:
 *   - `<stem>_id`   → collection `<plural(stem)>`
 *   - `<stem>Id`    → collection `<plural(stem)>`
 * Returns one candidate per unique source field. The service later verifies
 * the target collection exists before offering it to the user.
 */
export function detectCandidateFieldsFromDocs(
  sampleDocs: unknown[],
): Array<{ sourceField: string; stem: string }> {
  const seen = new Map<string, string>();
  const walk = (obj: unknown, prefix: string): void => {
    if (obj === null || obj === undefined) return;
    if (Array.isArray(obj)) {
      for (const item of obj.slice(0, 3)) walk(item, prefix);
      return;
    }
    if (typeof obj !== 'object') return;
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (key === '_id') continue;
      const stem = /^(.+)_id$/.exec(key)?.[1] ?? /^(.+)Id$/.exec(key)?.[1];
      if (stem && !seen.has(path)) seen.set(path, stem);
      // Recurse one level, skipping EJSON sentinels like {$oid, $date}.
      if (!prefix && val && typeof val === 'object' && !Array.isArray(val)) {
        const keys = Object.keys(val);
        if (!keys.some((k) => k.startsWith('$'))) walk(val, path);
      }
    }
  };
  for (const doc of sampleDocs.slice(0, 25)) walk(doc, '');
  return [...seen.entries()].map(([sourceField, stem]) => ({ sourceField, stem }));
}

export class ReferenceRulesService {
  private repo: ReferenceRulesRepo;
  private pool: MongoPool;

  constructor(repo: ReferenceRulesRepo, pool: MongoPool) {
    this.repo = repo;
    this.pool = pool;
  }

  list(connectionId: string): ReferenceRule[] {
    return this.repo.listByConnection(connectionId);
  }

  listForCollection(
    connectionId: string,
    sourceDb: string,
    sourceCollection: string,
  ): ReferenceRule[] {
    return this.repo.listForCollection(connectionId, sourceDb, sourceCollection);
  }

  get(id: string): ReferenceRule {
    return this.repo.findByIdOrThrow(id);
  }

  create(input: ReferenceRuleCreateInput): ReferenceRule {
    const projection = normalizeProjection(input.projection);
    const now = nowIso();
    return this.repo.insert({
      id: randomUUID(),
      connection_id: input.connectionId,
      source_db: input.sourceDb,
      source_collection: input.sourceCollection,
      source_field: input.sourceField,
      target_db: input.targetDb,
      target_collection: input.targetCollection,
      target_field: input.targetField ?? '_id',
      projection_json: JSON.stringify(projection),
      display_template: input.displayTemplate ?? null,
      enabled: input.enabled === false ? 0 : 1,
      created_at: now,
      updated_at: now,
    });
  }

  update(id: string, patch: ReferenceRuleUpdateInput): ReferenceRule {
    const sqlPatch: ReferenceRulePatch = { updated_at: nowIso() };
    if (patch.targetDb !== undefined) sqlPatch.target_db = patch.targetDb;
    if (patch.targetCollection !== undefined) sqlPatch.target_collection = patch.targetCollection;
    if (patch.targetField !== undefined) sqlPatch.target_field = patch.targetField;
    if (patch.projection !== undefined) {
      sqlPatch.projection_json = JSON.stringify(normalizeProjection(patch.projection));
    }
    if (patch.displayTemplate !== undefined) {
      sqlPatch.display_template = patch.displayTemplate === '' ? null : patch.displayTemplate;
    }
    if (patch.enabled !== undefined) sqlPatch.enabled = patch.enabled ? 1 : 0;
    return this.repo.update(id, sqlPatch);
  }

  delete(id: string): void {
    const changes = this.repo.deleteById(id);
    if (changes === 0) throw new NotFoundError(`reference rule ${id} not found`);
  }

  async resolve(input: ReferenceResolveInput): Promise<ReferenceResolveResult> {
    const rule = this.repo.findByIdOrThrow(input.ruleId);
    const value = parseEjsonField<unknown>(input.valueEjson, 'valueEjson');
    const db = await this.pool.readDb(rule.connectionId, rule.targetDb);
    const coll = db.collection(rule.targetCollection);
    const projection = projectionToMongo(rule.projection);
    const t0 = Date.now();
    try {
      // Array source value → match any element via $in, then reorder results
      // to match the source array so the renderer can show "first ref".
      if (Array.isArray(value)) {
        if (value.length === 0) {
          return { ruleId: rule.id, found: false, documents: [], durationMs: Date.now() - t0 };
        }
        const docs = await coll
          .find(
            { [rule.targetField]: { $in: value } } as Record<string, unknown>,
            { ...EXACT_BSON, projection },
          )
          .toArray();
        const ordered: unknown[] = [];
        const docByKey = new Map<string, unknown>();
        for (const d of docs) {
          docByKey.set(matchKey((d as Record<string, unknown>)[rule.targetField]), d);
        }
        for (const v of value) {
          const hit = docByKey.get(matchKey(v));
          if (hit !== undefined) ordered.push(hit);
        }
        return {
          ruleId: rule.id,
          found: ordered.length > 0,
          documents: ordered.map((d) => ejsonEncode(d, false)),
          durationMs: Date.now() - t0,
        };
      }
      const doc = await coll.findOne(
        { [rule.targetField]: value } as Record<string, unknown>,
        { ...EXACT_BSON, projection },
      );
      return {
        ruleId: rule.id,
        found: doc !== null,
        documents: doc ? [ejsonEncode(doc, false)] : [],
        durationMs: Date.now() - t0,
      };
    } catch (err) {
      throw classifyMongoOpError(err);
    }
  }

  async autodetect(input: ReferenceAutodetectInput): Promise<ReferenceAutodetectCandidate[]> {
    const existingByField = new Map(
      this.repo
        .listForCollection(input.connectionId, input.dbName, input.collection)
        .map((r) => [r.sourceField, r]),
    );

    let db;
    try {
      db = await this.pool.readDb(input.connectionId, input.dbName);
    } catch {
      return [];
    }

    const needSample = !input.sampleDocs || input.sampleDocs.length === 0;
    let docsPromise: Promise<unknown[]> = Promise.resolve(input.sampleDocs ?? []);
    if (needSample) {
      docsPromise = db.collection(input.collection).find({}).limit(25).toArray()
        .catch(() => [] as unknown[]);
    }
    const collsPromise = db.listCollections({}, { nameOnly: true }).toArray()
      .catch(() => [] as Array<{ name: string }>);

    const [docs, cols] = await Promise.all([docsPromise, collsPromise]);
    if (cols.length === 0) return [];
    const collectionNames = new Set(cols.map((c) => c.name));

    const candidates = detectCandidateFieldsFromDocs(docs);
    const out: ReferenceAutodetectCandidate[] = [];
    for (const { sourceField, stem } of candidates) {
      const guesses = uniqueNonEmpty([
        pluralize(stem),
        stem,
        pluralize(singularize(stem)),
      ]);
      const match = guesses.find((g) => collectionNames.has(g));
      if (!match) continue;
      out.push({
        sourceField,
        targetDb: input.dbName,
        targetCollection: match,
        targetField: '_id',
        alreadyConfigured: existingByField.has(sourceField),
      });
    }
    return out;
  }
}

function uniqueNonEmpty(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (item && !seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

