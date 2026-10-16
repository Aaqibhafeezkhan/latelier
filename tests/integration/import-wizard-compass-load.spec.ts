import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionRepo } from '../../electron/db/repositories/ConnectionRepo';
import { BadPassphraseError, ValidationError, type AppError } from '../../electron/errors';
import { ConnectionService, connectionReader } from '../../electron/mongo/ConnectionService';
import { MongoPool } from '../../electron/mongo/MongoPool';
import { SecretsVault } from '../../electron/secrets/SecretsVault';
import { ImportWizardService } from '../../electron/services/ImportWizardService';
import { decryptCompassSecrets } from '../../electron/services/import/compassCrypto';
import { createTempDb, type TempDb } from '../helpers/db';
import { createSafeStorageMock } from '../helpers/safeStorageMock';

// Replaces only the 100,000-round key derivation's caller, so a test can count
// and pace derivations without paying for them.
vi.mock('../../electron/services/import/compassCrypto', () => ({ decryptCompassSecrets: vi.fn() }));

const ROWS = 5;
const decrypt = vi.mocked(decryptCompassSecrets);
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('ImportWizardService — sealed Compass rows load the thread pool gently', () => {
  let dir: string;
  let db: TempDb;
  let wizard: ImportWizardService;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-import-load-'));
    db = createTempDb();
    const vault = new SecretsVault(db.db, createSafeStorageMock(), { getAllowPlaintext: () => false });
    const repo = new ConnectionRepo(db.db);
    const conns = new ConnectionService({ repo, vault, pool: new MongoPool({ repo: connectionReader(repo, vault), vault }) });
    const file = path.join(dir, 'export.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        type: 'Compass Connections',
        version: { $numberInt: '1' },
        connections: Array.from({ length: ROWS }, (_, n) => ({
          favorite: { name: `Row ${n}` },
          connectionOptions: { connectionString: `mongodb://u@h${n}.example/` },
          savedConnectionType: 'favorite',
          connectionSecrets: `blob-${n}`,
        })),
      }),
    );
    wizard = new ImportWizardService({
      conns,
      vault,
      dialogs: { openPath: async () => file },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    decrypt.mockReset();
  });

  afterEach(() => {
    db.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const commit = async (passphrase: string) => {
    const opened = await wizard.importOpen();
    if ('cancelled' in opened || opened.source === 'unknown') throw new Error('expected a Compass export');
    const attempt = () =>
      wizard.importCommit({
        token: opened.token,
        indices: Array.from({ length: ROWS }, (_, n) => n),
        passphrase,
        readOnly: false,
        credentials: [],
        directConnection: [],
      });
    return attempt;
  };

  it('a wrong passphrase derives one key, not one per row, and the retry can start clean', async () => {
    decrypt.mockRejectedValueOnce(new BadPassphraseError('Wrong passphrase for this Compass export.'));
    const attempt = await commit('wrong');
    const err = await attempt().catch((e: AppError) => e);
    expect(err).toBeInstanceOf(BadPassphraseError);
    expect((err as AppError).message).toBe('Wrong passphrase for this Compass export.');
    await tick(20);
    expect(decrypt).toHaveBeenCalledTimes(1);

    decrypt.mockResolvedValue({ secrets: {}, dropped: [] });
    expect((await attempt()).created).toHaveLength(ROWS);
  });

  it('opens the rest two at a time and resolves only once every job has settled', async () => {
    let inFlight = 0;
    let peak = 0;
    let finished = 0;
    decrypt.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick(10);
      inFlight -= 1;
      finished += 1;
      return { secrets: {}, dropped: [] };
    });
    const attempt = await commit('right');
    const result = await attempt();
    expect(result.created).toHaveLength(ROWS);
    expect(decrypt).toHaveBeenCalledTimes(ROWS);
    expect(peak).toBe(2);
    expect(finished).toBe(ROWS);
    expect(inFlight).toBe(0);
  });

  it('a damaged later row throws only after the jobs already launched have settled, and launches no more', async () => {
    let inFlight = 0;
    decrypt.mockImplementation(async (blob) => {
      inFlight += 1;
      try {
        if (blob === 'blob-0') return { secrets: {}, dropped: [] };
        if (blob === 'blob-1') {
          await tick(5);
          throw new ValidationError("This Compass export's secrets are damaged.");
        }
        await tick(40);
        return { secrets: {}, dropped: [] };
      } finally {
        inFlight -= 1;
      }
    });
    const attempt = await commit('right');
    const err = await attempt().catch((e: AppError) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as AppError).message).toBe("This Compass export's secrets are damaged.");
    expect(inFlight).toBe(0);
    const launched = decrypt.mock.calls.length;
    await tick(60);
    expect(decrypt).toHaveBeenCalledTimes(launched);
    expect(launched).toBeLessThan(ROWS);
  });
});
