// `npm run build` under a watchdog: a wedged build (Rolldown's thread pool can
// stall under load) would otherwise hang the e2e run forever. macOS has no
// timeout(1), so this is a Node spawn with a kill timer.
//
// The build runs in its own process group and the whole group is killed on
// expiry: killing only npm would leave the shell and the real tsc/vite alive.
import { spawn } from 'node:child_process';

const DEFAULT_MS = 5 * 60 * 1000;
const raw = process.env.ATELIER_BUILD_TIMEOUT_MS;
const timeoutMs = raw === undefined ? DEFAULT_MS : Number.parseInt(raw, 10);
if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
  console.error(`[run-e2e] ATELIER_BUILD_TIMEOUT_MS must be a positive integer, got "${raw}"`);
  process.exit(1);
}

// npm sets `npm_execpath` for everything it runs, so the build starts through
// the very npm that started this script rather than whatever `npm` PATH finds.
const npmCli = process.env.npm_execpath;
if (!npmCli) {
  console.error('[run-e2e] npm_execpath is unset - run this through `npm run test:e2e`');
  process.exit(1);
}

const child = spawn(process.execPath, [npmCli, 'run', 'build'], { stdio: 'inherit', detached: true });

const timer = setTimeout(() => {
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (err) {
    if (err.code !== 'ESRCH') throw err; // group already gone
  }
  console.error(`\n[run-e2e] build timed out after ${timeoutMs}ms - treating as failure.`);
  process.exit(1);
}, timeoutMs);

child.on('error', (err) => {
  clearTimeout(timer);
  console.error(`[run-e2e] could not start the build: ${err.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  clearTimeout(timer);
  process.exit(signal ? 1 : (code ?? 1));
});
