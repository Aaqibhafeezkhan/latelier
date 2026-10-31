import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CollectionDetails } from '@shared/ipc';

const { collectionDetails } = vi.hoisted(() => ({
  collectionDetails: vi.fn<(input: unknown) => Promise<CollectionDetails>>(),
}));

vi.mock('../../src/api/atelier', () => ({ api: { meta: { collectionDetails } } }));

import {
  invalidateSchemaEnumCache,
  schemaEnumSource,
  setSchemaEnumCacheTtl,
} from '../../src/features/fieldSuggestions/sources/schemaEnumSource';

function details(validator?: unknown): CollectionDetails {
  return {
    name: 'orders',
    type: 'collection',
    capped: false,
    options: validator === undefined ? {} : { validator: JSON.stringify(validator) },
  };
}

function ask(field: string, collection = 'orders') {
  return schemaEnumSource({
    connectionId: 'c1',
    dbName: 'db',
    collection,
    target: { field },
  });
}

async function displays(field: string, collection?: string): Promise<string[]> {
  return (await ask(field, collection)).map((s) => s.display);
}

beforeEach(() => {
  invalidateSchemaEnumCache();
  setSchemaEnumCacheTtl();
  collectionDetails.mockReset();
});

describe('schemaEnumSource', () => {
  it('suggests a top-level enum, ranked ahead of observed values', async () => {
    collectionDetails.mockResolvedValue(
      details({ $jsonSchema: { properties: { status: { enum: ['open', 'closed'] } } } }),
    );
    expect(await ask('status')).toEqual([
      { kind: 'value', value: 'open', display: 'open', type: 'string', source: 'schemaEnum', frequency: 50 },
      { kind: 'value', value: 'closed', display: 'closed', type: 'string', source: 'schemaEnum', frequency: 50 },
    ]);
    expect(collectionDetails).toHaveBeenCalledWith({ connectionId: 'c1', dbName: 'db', collection: 'orders' });
  });

  it('resolves a dotted path through nested properties', async () => {
    collectionDetails.mockResolvedValue(
      details({
        $jsonSchema: {
          properties: { ship: { properties: { mode: { enum: ['air', 'sea'] } } } },
        },
      }),
    );
    expect(await displays('ship.mode')).toEqual(['air', 'sea']);
    expect(await displays('ship')).toEqual([]);
    expect(await displays('ship.speed')).toEqual([]);
  });

  it('falls back to items.enum for an array field', async () => {
    collectionDetails.mockResolvedValue(
      details({ $jsonSchema: { properties: { tags: { bsonType: 'array', items: { enum: ['a', 'b'] } } } } }),
    );
    expect(await displays('tags')).toEqual(['a', 'b']);
  });

  it('prefers the field own enum over items.enum', async () => {
    collectionDetails.mockResolvedValue(
      details({ $jsonSchema: { properties: { f: { enum: ['own'], items: { enum: ['item'] } } } } }),
    );
    expect(await displays('f')).toEqual(['own']);
  });

  it('keeps canonical EJSON numbers as numbers and skips objects and arrays', async () => {
    collectionDetails.mockResolvedValue(
      details({
        $jsonSchema: {
          properties: { n: { enum: [{ $numberInt: '5' }, null, { a: 1 }, ['x'], true] } },
        },
      }),
    );
    const out = await ask('n');
    expect(out.map((s) => [s.display, s.type])).toEqual([
      ['5', 'number'],
      ['null', 'null'],
      ['true', 'boolean'],
    ]);
  });

  it('suggests nothing without a validator, and reports nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    collectionDetails.mockResolvedValue(details());
    expect(await ask('status')).toEqual([]);
    expect(collectionDetails).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('suggests nothing for a query-operator validator without $jsonSchema', async () => {
    collectionDetails.mockResolvedValue(details({ status: { $in: ['a', 'b'] } }));
    expect(await ask('status')).toEqual([]);
    expect(collectionDetails).toHaveBeenCalledTimes(1);
  });

  it('suggests nothing when the enum or the path is malformed', async () => {
    collectionDetails.mockResolvedValue(
      details({
        $jsonSchema: {
          properties: { a: { enum: 'x' }, b: { items: { enum: 'x' } }, c: 'x', d: { properties: 'x' } },
        },
      }),
    );
    expect(await displays('a')).toEqual([]);
    expect(await displays('b')).toEqual([]);
    expect(await displays('c')).toEqual([]);
    expect(await displays('d.e')).toEqual([]);
    expect(await displays('c.e')).toEqual([]);
    expect(await displays('a.b')).toEqual([]);
  });

  it('suggests nothing for a null schema node', async () => {
    collectionDetails.mockResolvedValue(details({ $jsonSchema: { properties: { n: null } } }));
    expect(await displays('n')).toEqual([]);
    expect(await displays('n.m')).toEqual([]);
  });

  it('suggests nothing when the validator is JSON null', async () => {
    collectionDetails.mockResolvedValue(details(null));
    expect(await displays('n')).toEqual([]);
  });

  it('reads an own property literally named __proto__', async () => {
    collectionDetails.mockResolvedValue({
      ...details(),
      options: { validator: '{"$jsonSchema":{"properties":{"__proto__":{"enum":["p"]}}}}' },
    });
    expect(await displays('__proto__')).toEqual(['p']);
  });

  it('suggests nothing when $jsonSchema is not an object or the validator is not a document', async () => {
    collectionDetails.mockResolvedValueOnce(details({ $jsonSchema: 'x' }));
    expect(await ask('status', 'a')).toEqual([]);
    collectionDetails.mockResolvedValueOnce(details(['x']));
    expect(await ask('status', 'b')).toEqual([]);
    expect(collectionDetails).toHaveBeenCalledTimes(2);
  });

  it('never walks into the prototype chain', async () => {
    collectionDetails.mockResolvedValue(details({ $jsonSchema: { properties: {} } }));
    expect(await displays('constructor')).toEqual([]);
    expect(await displays('__proto__')).toEqual([]);
    expect(await displays('toString')).toEqual([]);
  });

  describe('failures', () => {
    let now = 1_000_000;
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      now = 1_000_000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => vi.restoreAllMocks());

    it('fails open to [] when the details call rejects, and reports the error', async () => {
      const err = new Error('NOT_FOUND');
      collectionDetails.mockRejectedValue(err);
      expect(await ask('status')).toEqual([]);
      expect(await ask('status')).toEqual([]);
      expect(collectionDetails).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/validator failed/), err);
    });

    it('retries a failed read after 15 seconds, not after the full TTL', async () => {
      collectionDetails.mockRejectedValueOnce(new Error('timeout'));
      collectionDetails.mockResolvedValue(
        details({ $jsonSchema: { properties: { status: { enum: ['back'] } } } }),
      );
      expect(await displays('status')).toEqual([]);
      now += 14_999;
      expect(await displays('status')).toEqual([]);
      expect(collectionDetails).toHaveBeenCalledTimes(1);
      now += 1;
      expect(await displays('status')).toEqual(['back']);
      expect(collectionDetails).toHaveBeenCalledTimes(2);
    });

    it('caches a validator that is not JSON for the full TTL, and reports it', async () => {
      collectionDetails.mockResolvedValue({ ...details(), options: { validator: '{not json' } });
      expect(await displays('status')).toEqual([]);
      now += 4 * 60 * 1000;
      expect(await displays('status')).toEqual([]);
      expect(collectionDetails).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/not JSON/), expect.any(SyntaxError));
    });

    it('treats a reply without options as a failed read', async () => {
      collectionDetails.mockResolvedValue(undefined as unknown as CollectionDetails);
      expect(await displays('status')).toEqual([]);
      now += 15_000;
      await displays('status');
      expect(collectionDetails).toHaveBeenCalledTimes(2);
    });
  });

  it.each(['token', 'Password', 'creds.secret'])(
    'never suggests enum values of the secret-named field %s',
    async (field) => {
      collectionDetails.mockResolvedValue(
        details({
          $jsonSchema: {
            properties: {
              token: { enum: ['t1'] },
              Password: { enum: ['p1'] },
              creds: { properties: { secret: { enum: ['s1'] } } },
            },
          },
        }),
      );
      expect(await displays(field)).toEqual([]);
    },
  );

  it('suggests nothing for a blank field, without a call', async () => {
    expect(await ask('  ')).toEqual([]);
    expect(collectionDetails).not.toHaveBeenCalled();
  });

  it('makes one call per collection inside the TTL, shared across fields', async () => {
    collectionDetails.mockResolvedValue(
      details({ $jsonSchema: { properties: { a: { enum: ['x'] }, b: { enum: ['y'] } } } }),
    );
    const [a, b] = await Promise.all([displays('a'), displays('b')]);
    expect([a, b]).toEqual([['x'], ['y']]);
    expect(await displays('a')).toEqual(['x']);
    expect(collectionDetails).toHaveBeenCalledTimes(1);
  });

  it('fetches again once the TTL has passed', async () => {
    collectionDetails.mockResolvedValue(details());
    setSchemaEnumCacheTtl(0);
    await ask('a');
    await ask('a');
    expect(collectionDetails).toHaveBeenCalledTimes(2);
  });

  it('returns the previous TTL from the setter', () => {
    expect(setSchemaEnumCacheTtl(10)).toBe(5 * 60 * 1000);
    expect(setSchemaEnumCacheTtl()).toBe(10);
  });

  describe('invalidateSchemaEnumCache', () => {
    beforeEach(() => collectionDetails.mockResolvedValue(details()));

    it('drops one exact collection and leaves a similarly named one cached', async () => {
      await ask('f', 'orders');
      await ask('f', 'orders_archive');
      invalidateSchemaEnumCache('c1', 'db', 'orders');
      await ask('f', 'orders');
      await ask('f', 'orders_archive');
      expect(collectionDetails).toHaveBeenCalledTimes(3);
    });

    it('drops every collection of a connection, and only that connection', async () => {
      await ask('f', 'a');
      await ask('f', 'b');
      await schemaEnumSource({ connectionId: 'c2', dbName: 'db', collection: 'a', target: { field: 'f' } });
      invalidateSchemaEnumCache('c1');
      await ask('f', 'a');
      await ask('f', 'b');
      await schemaEnumSource({ connectionId: 'c2', dbName: 'db', collection: 'a', target: { field: 'f' } });
      expect(collectionDetails).toHaveBeenCalledTimes(5);
    });

    it('drops every collection of the connection when the collection is not named', async () => {
      await ask('f', 'a');
      invalidateSchemaEnumCache('c1', 'db');
      await ask('f', 'a');
      expect(collectionDetails).toHaveBeenCalledTimes(2);
    });

    it('drops everything with no arguments', async () => {
      await ask('f', 'a');
      invalidateSchemaEnumCache();
      await ask('f', 'a');
      expect(collectionDetails).toHaveBeenCalledTimes(2);
    });

    it('keeps a fetch that started before the invalidation out of the cache', async () => {
      let resolveStale!: (d: CollectionDetails) => void;
      let resolveFresh!: (d: CollectionDetails) => void;
      collectionDetails
        .mockImplementationOnce(() => new Promise((r) => (resolveStale = r)))
        .mockImplementationOnce(() => new Promise((r) => (resolveFresh = r)));
      const stale = ask('status');
      invalidateSchemaEnumCache('c1', 'db', 'orders');
      const fresh = displays('status');
      resolveStale(details({ $jsonSchema: { properties: { status: { enum: ['old'] } } } }));
      expect((await stale).map((s) => s.display)).toEqual(['old']);
      // The stale fetch settling must not drop the newer one still in flight.
      const joined = displays('status');
      resolveFresh(details({ $jsonSchema: { properties: { status: { enum: ['new'] } } } }));
      expect(await fresh).toEqual(['new']);
      expect(await joined).toEqual(['new']);
      expect(await displays('status')).toEqual(['new']);
      expect(collectionDetails).toHaveBeenCalledTimes(2);
    });
  });
});
