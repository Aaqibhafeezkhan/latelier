import { inject } from 'vitest';
import type { Connection } from '@shared/types';
import type { ConnectionReader } from '../../electron/mongo/MongoPool';

/**
 * URI of the one mongod the integration project's globalSetup
 * (`mongoGlobalSetup.ts`) starts for the whole run. Test files share it in
 * parallel, so each file works in database names no other file uses. A test
 * that kills its server, needs a replica set, sets a server-global fail point
 * or reads server-global counters starts its own MongoMemoryServer instead.
 */
export function getSharedMongoUri(): string {
  return inject('mongoUri');
}

/**
 * Parse a mongodb-memory-server URI into host/port for our Connection shape.
 */
export function uriToHostPort(uri: string): { host: string; port: number } {
  const m = uri.match(/^mongodb:\/\/([^:/]+):(\d+)/);
  if (!m) throw new Error(`cannot parse uri ${uri}`);
  return { host: m[1]!, port: Number(m[2]!) };
}

export function makeConnection(
  id: string,
  hp: { host: string; port: number },
  overrides: Partial<Connection> = {},
): Connection {
  return {
    id,
    name: `conn-${id}`,
    color: '#1A6835',
    connectionType: 'standard',
    host: hp.host,
    port: hp.port,
    authMech: 'none',
    tls: { enabled: false, verify: true },
    advanced: {
      connectTimeoutMs: 5000,
      socketTimeoutMs: 5000,
      serverSelectionTimeoutMs: 5000,
      readPreference: 'primary',
      maxPoolSize: 5,
      directConnection: true,
    },
    hasPasswordStored: false,
    hasSshPasswordStored: false,
    hasSshPassphraseStored: false,
    readOnly: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

export function makeReader(conns: Connection[]): ConnectionReader {
  return {
    findById: (id: string) => conns.find((c) => c.id === id) ?? null,
  };
}

export interface CountingReader extends ConnectionReader {
  calls: number;
  reset(): void;
}

export function makeCountingReader(conns: Connection[]): CountingReader {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    reset() {
      state.calls = 0;
    },
    findById(id: string) {
      state.calls++;
      return conns.find((c) => c.id === id) ?? null;
    },
  };
}
