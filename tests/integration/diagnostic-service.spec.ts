import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DiagnosticService } from '../../electron/services/DiagnosticService';

interface FakeRow {
  id: string;
  name: string;
  connection_type: string;
  host: string;
  port: number;
  auth_mech: string;
  tls_enabled: number;
  ssh_enabled: number;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

function makeRow(overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    id: 'c1',
    name: 'local',
    connection_type: 'standalone',
    host: 'localhost',
    port: 27017,
    auth_mech: 'none',
    tls_enabled: 0,
    ssh_enabled: 0,
    created_at: '2026-05-07T00:00:00.000Z',
    updated_at: '2026-05-07T00:00:00.000Z',
    last_used_at: null,
    ...overrides,
  };
}

describe('DiagnosticService', () => {
  let userDataDir: string;
  let logsDir: string;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mongolab-diag-'));
    logsDir = path.join(userDataDir, 'logs');
    await fs.mkdir(logsDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  it('build() includes redacted connections, runtime metadata, and recent logs', async () => {
    await fs.writeFile(path.join(logsDir, 'latelier.2026-05-01.log'), 'old line\n');
    await fs.writeFile(path.join(logsDir, 'latelier.2026-05-07.log'), 'recent line\n');
    // Non-log file in the directory should be ignored.
    await fs.writeFile(path.join(logsDir, 'README.txt'), 'ignore me');

    const svc = new DiagnosticService({
      userDataDir,
      connRepo: { list: () => [makeRow({ id: 'c1', name: 'local' })] },
    });

    const bundle = await svc.build();

    expect(bundle.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(bundle.app.platform).toBe(process.platform);
    expect(bundle.app.node).toBe(process.versions.node);
    expect(bundle.connections).toEqual([
      expect.objectContaining({ id: 'c1', name: 'local', host: 'localhost', port: 27017 }),
    ]);
    expect(Object.keys(bundle.logs)).toEqual(
      expect.arrayContaining(['latelier.2026-05-01.log', 'latelier.2026-05-07.log']),
    );
    expect(bundle.logs['latelier.2026-05-07.log']).toContain('recent line');
    expect(Object.keys(bundle.logs)).not.toContain('README.txt');
  });

  it('includes the secrets status block only when a probe is supplied', async () => {
    const without = await new DiagnosticService({
      userDataDir,
      connRepo: { list: () => [] },
    }).build();
    expect(without).not.toHaveProperty('secrets');

    const svc = new DiagnosticService({
      userDataDir,
      connRepo: { list: () => [] },
      secretsStatus: () => ({ encryptionAvailable: false, backend: 'basic_text', columnKeyProtected: false }),
    });
    expect((await svc.build()).secrets).toEqual({
      encryptionAvailable: false,
      backend: 'basic_text',
      columnKeyProtected: false,
    });
    expect(JSON.parse(await svc.serialize()).secrets).toEqual({
      encryptionAvailable: false,
      backend: 'basic_text',
      columnKeyProtected: false,
    });
  });

  it('strips unknown fields from connection rows so a leaked password cannot surface', async () => {
    const svc = new DiagnosticService({
      userDataDir,
      // The repo wouldn't normally hand out a password, but if one ever does
      // (or future fields shadow REDACTED_KEYS), the explicit shape filter in
      // redactedConnections() must drop it. This is the first line of defense;
      // redactSecrets() in serialize() is the second.
      connRepo: {
        list: () =>
          [
            { ...makeRow(), password: 'super-secret' } as unknown as FakeRow,
          ],
      },
    });
    const json = await svc.serialize();
    expect(json).not.toContain('super-secret');
    expect(json).not.toContain('"password"');
  });

  it('keeps only the most recent N log files when more exist than the cap (pre-rename names)', async () => {
    for (const day of ['01', '02', '03', '04', '05', '06', '07', '08']) {
      await fs.writeFile(path.join(logsDir, `mongolab.2026-05-${day}.log`), `day-${day}\n`);
    }
    const svc = new DiagnosticService({
      userDataDir,
      connRepo: { list: () => [] },
      maxLogFiles: 3,
    });
    const bundle = await svc.build();
    expect(Object.keys(bundle.logs).sort((a, b) => a.localeCompare(b))).toEqual([
      'mongolab.2026-05-06.log',
      'mongolab.2026-05-07.log',
      'mongolab.2026-05-08.log',
    ]);
  });

  it('keeps the newest logs across the rename, not the legacy ones that sort after them by name', async () => {
    for (const day of ['01', '02', '03', '04', '05']) {
      await fs.writeFile(path.join(logsDir, `mongolab.2026-05-${day}.log`), `legacy-${day}\n`);
    }
    for (const day of ['06', '07', '08']) {
      await fs.writeFile(path.join(logsDir, `latelier.2026-05-${day}.log`), `current-${day}\n`);
    }
    const svc = new DiagnosticService({
      userDataDir,
      connRepo: { list: () => [] },
      maxLogFiles: 4,
    });
    const bundle = await svc.build();
    expect(Object.keys(bundle.logs).sort((a, b) => a.localeCompare(b))).toEqual([
      'latelier.2026-05-06.log',
      'latelier.2026-05-07.log',
      'latelier.2026-05-08.log',
      'mongolab.2026-05-05.log',
    ]);
  });

  it('treats the pre-rename log as older than the current one written on the same day', async () => {
    await fs.writeFile(path.join(logsDir, 'mongolab.2026-05-07.log'), 'before upgrade\n');
    await fs.writeFile(path.join(logsDir, 'latelier.2026-05-07.log'), 'after upgrade\n');
    const svc = new DiagnosticService({
      userDataDir,
      connRepo: { list: () => [] },
      maxLogFiles: 1,
    });
    const bundle = await svc.build();
    expect(Object.keys(bundle.logs)).toEqual(['latelier.2026-05-07.log']);
  });

  it('keeps the newest size-cap parts of a day, counting part numbers as numbers', async () => {
    for (const name of [
      'mongolab.2026-10-29.log',
      'latelier.2026-10-29.log',
      'latelier.2026-10-29.1.log',
      'latelier.2026-10-29.2.log',
      'latelier.2026-10-29.10.log',
    ]) {
      await fs.writeFile(path.join(logsDir, name), `${name}\n`);
    }
    const svc = new DiagnosticService({
      userDataDir,
      connRepo: { list: () => [] },
      maxLogFiles: 3,
    });
    const bundle = await svc.build();
    // In whole-name order `.1` and `.10` sort before the bare name and `.2`,
    // so the kept three would be `.2`, the bare name and `mongolab.`.
    expect(Object.keys(bundle.logs).sort((a, b) => a.localeCompare(b))).toEqual([
      'latelier.2026-10-29.1.log',
      'latelier.2026-10-29.10.log',
      'latelier.2026-10-29.2.log',
    ]);
  });

  it('truncates oversized log files to the configured byte cap and starts on a clean line', async () => {
    const big = path.join(logsDir, 'latelier.2026-05-07.log');
    // 10 lines, each 100 chars-ish.
    const lines = Array.from({ length: 10 }, (_, i) => `line-${i}-${'x'.repeat(100)}`);
    await fs.writeFile(big, lines.join('\n') + '\n');
    const svc = new DiagnosticService({
      userDataDir,
      connRepo: { list: () => [] },
      maxLogFileBytes: 200, // forces truncation
    });
    const bundle = await svc.build();
    const tail = bundle.logs['latelier.2026-05-07.log']!;
    expect(tail.length).toBeLessThanOrEqual(200);
    // The truncation logic discards the partial first line — so the first
    // character of the slice must be the start of a complete record.
    expect(tail.startsWith('line-')).toBe(true);
  });

  it('build() succeeds when the logs directory does not exist', async () => {
    await fs.rm(logsDir, { recursive: true, force: true });
    const svc = new DiagnosticService({
      userDataDir,
      connRepo: { list: () => [] },
    });
    const bundle = await svc.build();
    expect(bundle.logs).toEqual({});
  });

  it('defaultFilename() encodes a sortable timestamp', () => {
    const svc = new DiagnosticService({
      userDataDir,
      connRepo: { list: () => [] },
    });
    expect(svc.defaultFilename()).toMatch(/^latelier-diagnostic-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/);
  });
});
