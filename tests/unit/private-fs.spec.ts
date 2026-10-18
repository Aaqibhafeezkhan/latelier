import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ensurePrivateDir,
  ensurePrivateFile,
  openPrivateFile,
  writePrivateFile,
  PrivateModeError,
} from '../../electron/utils/privateFs';
import { useUmask022 } from '../helpers/umask';

const posix = process.platform !== 'win32';
const mode = (p: string): number => fs.statSync(p).mode & 0o777;

describe('privateFs', () => {
  let root: string;
  let restoreUmask: () => void;

  beforeEach(() => {
    restoreUmask = useUmask022();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mongolab-privfs-'));
  });

  afterEach(() => {
    restoreUmask();
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe.skipIf(!posix)('on POSIX', () => {
    it('creates a missing directory and its new parents as 0700', () => {
      const leaf = path.join(root, 'a', 'b');
      ensurePrivateDir(leaf);
      expect(mode(leaf)).toBe(0o700);
      expect(mode(path.join(root, 'a'))).toBe(0o700);
    });

    it('tightens an existing 0755 directory, where mkdir ignores the mode', () => {
      const dir = path.join(root, 'existing');
      fs.mkdirSync(dir, { mode: 0o755 });
      ensurePrivateDir(dir);
      expect(mode(dir)).toBe(0o700);
    });

    it('creates a missing file as 0600 and empty', () => {
      const file = path.join(root, 'new.db');
      ensurePrivateFile(file);
      expect(mode(file)).toBe(0o600);
      expect(fs.statSync(file).size).toBe(0);
    });

    it('tightens an existing 0644 file without touching its content', () => {
      const file = path.join(root, 'old.log');
      fs.writeFileSync(file, 'keep\n', { mode: 0o644 });
      ensurePrivateFile(file);
      expect(mode(file)).toBe(0o600);
      expect(fs.readFileSync(file, 'utf8')).toBe('keep\n');
    });

    it('lets a failed mkdir through as a plain error, not a PrivateModeError', () => {
      const file = path.join(root, 'plain');
      fs.writeFileSync(file, 'x');
      const attempt = () => ensurePrivateDir(path.join(file, 'child'));
      expect(attempt).toThrow();
      expect(attempt).not.toThrow(PrivateModeError);
    });

    it('wraps a failed chmod of the directory in a PrivateModeError naming the path', () => {
      const dir = path.join(root, 'not-ours');
      const eperm = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      vi.spyOn(fs, 'chmodSync').mockImplementation(() => {
        throw eperm;
      });
      let caught: unknown;
      try {
        ensurePrivateDir(dir);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(PrivateModeError);
      const e = caught as PrivateModeError;
      expect(e.name).toBe('PrivateModeError');
      expect(e.message).toContain(dir);
      expect(e.message).toContain('EPERM: operation not permitted');
      expect(e.message).toContain('must be owned by the current user');
      expect(e.cause).toBe(eperm);
    });

    it('wraps a failed file create in a PrivateModeError that keeps the cause', () => {
      const file = path.join(root, 'missing-dir', 'f');
      let caught: unknown;
      try {
        ensurePrivateFile(file);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(PrivateModeError);
      expect((caught as PrivateModeError).message).toContain(file);
      expect(((caught as PrivateModeError).cause as NodeJS.ErrnoException).code).toBe('ENOENT');
    });

    it('wraps a failed chmod of an existing file in a PrivateModeError', () => {
      const file = path.join(root, 'f');
      fs.writeFileSync(file, 'x');
      vi.spyOn(fs, 'chmodSync').mockImplementation(() => {
        throw new Error('EPERM');
      });
      expect(() => ensurePrivateFile(file)).toThrow(PrivateModeError);
    });

    it('writePrivateFile leaves a pre-existing 0644 file 0600 with the new content', async () => {
      const file = path.join(root, 'export.json');
      fs.writeFileSync(file, 'old content that is longer', { mode: 0o644 });
      await writePrivateFile(file, 'new');
      expect(mode(file)).toBe(0o600);
      expect(fs.readFileSync(file, 'utf8')).toBe('new');
    });

    it('writePrivateFile creates a missing file as 0600', async () => {
      const file = path.join(root, 'fresh.json');
      await writePrivateFile(file, 'x');
      expect(mode(file)).toBe(0o600);
      expect(fs.readFileSync(file, 'utf8')).toBe('x');
    });

    it('openPrivateFile tightens an existing 0644 file before any write', async () => {
      const file = path.join(root, 'stream.ndjson');
      fs.writeFileSync(file, 'old', { mode: 0o644 });
      const handle = await openPrivateFile(file);
      try {
        expect(mode(file)).toBe(0o600);
        await handle.write('streamed');
      } finally {
        await handle.close();
      }
      expect(mode(file)).toBe(0o600);
      expect(fs.readFileSync(file, 'utf8')).toBe('streamed');
    });

    it('openPrivateFile wraps a failed chmod in a PrivateModeError and closes the handle', async () => {
      const file = path.join(root, 'f');
      const eperm = new Error('EPERM');
      const close = vi.fn(async () => {});
      const fakeHandle = {
        chmod: vi.fn(async () => {
          throw eperm;
        }),
        close,
      };
      vi.spyOn(fsp, 'open').mockResolvedValue(fakeHandle as never);
      let caught: unknown;
      try {
        await openPrivateFile(file);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(PrivateModeError);
      expect((caught as PrivateModeError).cause).toBe(eperm);
      expect((caught as PrivateModeError).message).toContain(file);
      expect(close).toHaveBeenCalledTimes(1);
    });

    it('openPrivateFile lets a failed open through as a plain error', async () => {
      const file = path.join(root, 'missing-dir', 'f');
      const attempt = openPrivateFile(file);
      await expect(attempt).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(attempt).rejects.not.toBeInstanceOf(PrivateModeError);
    });

    it('writePrivateFile closes the handle when the write fails', async () => {
      const close = vi.fn(async () => {});
      const boom = new Error('ENOSPC');
      vi.spyOn(fsp, 'open').mockResolvedValue({
        chmod: async () => {},
        writeFile: async () => {
          throw boom;
        },
        close,
      } as never);
      await expect(writePrivateFile(path.join(root, 'f'), 'x')).rejects.toBe(boom);
      expect(close).toHaveBeenCalledTimes(1);
    });

    it('describes a non-Error cause by its string form', () => {
      expect(new PrivateModeError('/x', 'boom').message).toContain('(boom)');
    });
  });

  describe('on win32', () => {
    beforeEach(() => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    });

    it('creates the directory but applies no mode', () => {
      const chmod = vi.spyOn(fs, 'chmodSync');
      const dir = path.join(root, 'win');
      ensurePrivateDir(dir);
      expect(fs.existsSync(dir)).toBe(true);
      expect(chmod).not.toHaveBeenCalled();
    });

    it('writePrivateFile still writes the file and calls no chmod', async () => {
      const file = path.join(root, 'win.json');
      const chmod = vi.spyOn(fsp, 'chmod');
      await writePrivateFile(file, 'data');
      expect(fs.readFileSync(file, 'utf8')).toBe('data');
      expect(chmod).not.toHaveBeenCalled();
    });

    it('openPrivateFile never calls chmod on the handle', async () => {
      const chmod = vi.fn(async () => {});
      vi.spyOn(fsp, 'open').mockResolvedValue({ chmod, close: async () => {} } as never);
      await openPrivateFile(path.join(root, 'w'));
      expect(chmod).not.toHaveBeenCalled();
    });

    it('does not create or chmod a file', () => {
      const chmod = vi.spyOn(fs, 'chmodSync');
      const file = path.join(root, 'win.db');
      ensurePrivateFile(file);
      expect(fs.existsSync(file)).toBe(false);
      expect(chmod).not.toHaveBeenCalled();
    });
  });
});
