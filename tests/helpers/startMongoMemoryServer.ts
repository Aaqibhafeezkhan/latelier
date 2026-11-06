import { MongoMemoryServer } from 'mongodb-memory-server';

type Opts = Parameters<typeof MongoMemoryServer.create>[0];

const MAX_RETRIES = 2;

/**
 * `MongoMemoryServer.create` picks a random free port, then mongod binds it
 * a moment later; with several processes booting a mongod at once another can
 * win that port and the start fails with `Port "<n>" already in use`. A retry
 * lands on a fresh port. Any other failure is real and rethrows at once.
 * Lives apart from `mongo.ts` so the Playwright side can import it without
 * pulling in vitest.
 */
export async function startMongoMemoryServer(
  opts?: Opts,
  create: (opts?: Opts) => Promise<MongoMemoryServer> = (o) => MongoMemoryServer.create(o),
): Promise<MongoMemoryServer> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await create(opts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt >= MAX_RETRIES || !/already in use/i.test(msg)) throw err;
      process.stderr.write(
        `[mongo-memory-server] ${msg}; retrying (${attempt + 1}/${MAX_RETRIES})\n`,
      );
    }
  }
}
