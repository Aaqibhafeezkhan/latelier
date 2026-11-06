import { describe, it, expect, vi } from 'vitest';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { startMongoMemoryServer } from '../helpers/startMongoMemoryServer';

const fake = { tag: 'server' } as unknown as MongoMemoryServer;
const inUse = () => new Error('Port "27017" already in use');

describe('startMongoMemoryServer', () => {
  it('passes the options through and returns the server', async () => {
    const create = vi.fn().mockResolvedValue(fake);
    const opts = { instance: { args: ['--x'] } };
    await expect(startMongoMemoryServer(opts, create)).resolves.toBe(fake);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(opts);
  });

  it('retries a port-in-use failure and succeeds', async () => {
    const create = vi.fn().mockRejectedValueOnce(inUse()).mockResolvedValue(fake);
    await expect(startMongoMemoryServer(undefined, create)).resolves.toBe(fake);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('gives up after two retries (three attempts) and rethrows', async () => {
    const create = vi.fn().mockRejectedValue(inUse());
    await expect(startMongoMemoryServer(undefined, create)).rejects.toThrow(/already in use/);
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('rethrows any other error immediately', async () => {
    const create = vi.fn().mockRejectedValue(new Error('binary download failed'));
    await expect(startMongoMemoryServer(undefined, create)).rejects.toThrow('binary download');
    expect(create).toHaveBeenCalledTimes(1);
  });
});
