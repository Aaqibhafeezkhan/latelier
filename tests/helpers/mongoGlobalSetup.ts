import { MongoMemoryServer } from 'mongodb-memory-server';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}

// One mongod for the whole integration run, instead of one per test file:
// every boot costs time and is another chance at the free-port race when
// several processes start a mongod at once.
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const server = await MongoMemoryServer.create();
  project.provide('mongoUri', server.getUri());
  process.stderr.write(`[integration] shared mongod at ${server.getUri()}\n`);
  return async () => {
    await server.stop();
  };
}
