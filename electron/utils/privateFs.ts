import fs from 'node:fs';
import fsp, { type FileHandle } from 'node:fs/promises';

// POSIX modes carry no meaning on Windows, where the profile dir is already
// per-user by ACL. Read at call time so a test can stub the platform.
const posixModes = (): boolean => process.platform !== 'win32';

/**
 * A path could not be made owner-only, typically because the current user does
 * not own it (a shared folder, a mounted volume). Distinct from other fs errors
 * so a caller can tell a permissions problem from a damaged file.
 */
export class PrivateModeError extends Error {
  constructor(target: string, cause: unknown) {
    super(
      `Cannot restrict ${target} to its owner (${cause instanceof Error ? cause.message : String(cause)}). ` +
        'The folder must be owned by the current user.',
      { cause },
    );
    this.name = 'PrivateModeError';
  }
}

/**
 * Creates `dir` (and any missing parents) owner-only. `mkdirSync`'s mode is
 * ignored for a directory that already exists, so the explicit chmod is what
 * tightens an existing one. A failed mkdir throws as-is; a failed chmod throws
 * `PrivateModeError`, so a caller may degrade on that alone.
 */
export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!posixModes()) return;
  try {
    fs.chmodSync(dir, 0o700);
  } catch (err) {
    throw new PrivateModeError(dir, err);
  }
}

/**
 * Makes `path` exist with owner-only read/write. Creating it here, before
 * SQLite opens it, is what gives the `-wal`/`-shm` side files 0600 as well:
 * SQLite copies the main file's mode when it creates them. Throws `PrivateModeError`
 * on failure.
 */
export function ensurePrivateFile(path: string): void {
  if (!posixModes()) return;
  try {
    fs.closeSync(fs.openSync(path, 'a', 0o600));
    fs.chmodSync(path, 0o600);
  } catch (err) {
    throw new PrivateModeError(path, err);
  }
}

/**
 * Opens `path` for writing (truncating), owner-only. The `open` mode applies
 * only when the file is created, so an existing 0644 file is chmod-ed through
 * the handle before the caller writes anything: no data ever sits in a
 * group/world-readable file. The caller closes the handle. A failed open throws
 * as-is; a failed chmod closes the handle and throws `PrivateModeError`.
 */
export async function openPrivateFile(path: string): Promise<FileHandle> {
  const handle = await fsp.open(path, 'w', 0o600);
  if (!posixModes()) return handle;
  try {
    await handle.chmod(0o600);
  } catch (err) {
    await handle.close();
    throw new PrivateModeError(path, err);
  }
  return handle;
}

/** Writes `data` to `path` as UTF-8, owner-only even over an existing file. */
export async function writePrivateFile(path: string, data: string): Promise<void> {
  const handle = await openPrivateFile(path);
  try {
    await handle.writeFile(data, 'utf8');
  } finally {
    await handle.close();
  }
}
