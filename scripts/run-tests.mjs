#!/usr/bin/env node
/**
 * run-tests.mjs
 *
 * Runs the unit / integration / component vitest projects sequentially
 * instead of combined (`vitest run` with vitest.config.ts's `projects`
 * array) — the combined run intermittently hangs at 0% CPU with
 * no worker children, and a killed hang can report exit 0 on an empty log.
 * Run separately, each project always completes quickly.
 *
 * Each project also gets a hard wall-clock timeout so a hang fails loudly
 * (non-zero exit) instead of running forever or being silently killed.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const PROJECTS = ['unit', 'integration', 'component'];

// Resolve vitest's own entry point rather than shelling out to `npx vitest`.
// `npx` is looked up on PATH — a writable directory ahead of the real npm bin
// wins the lookup — and it will happily fetch vitest from the registry when the
// local install is missing. Running the lockfile-pinned file under this Node
// removes both. Resolution goes through `package.json` (the only path vitest's
// `exports` map publishes besides its API entries) and then its own `bin` entry,
// so a bin rename is followed rather than hard-coded. `createRequire` is needed
// because ESM has no `require.resolve`.
const vitestManifest = createRequire(import.meta.url).resolve('vitest/package.json');
const VITEST_BIN = join(dirname(vitestManifest), createRequire(vitestManifest)('./package.json').bin.vitest);

// A hang detector, not a performance budget. The hang sits at 0% CPU
// with no worker children and never finishes, so a generous ceiling catches it
// exactly as well as a tight one — while a tight one fails runs where every
// test passed. That is what happened at 5 minutes: the component project
// legitimately takes ~5 min on CI's 2-core runner and was clearing the kill by
// 8 seconds, less than the observed run-to-run variance.
//
// Size this at several times the slowest project's real wall-clock. If the
// component project ever approaches 15 minutes, the answer is to look at why,
// not to raise this again.
const TIMEOUT_MS = 15 * 60 * 1000;

// Extra arguments go to every project (`npm test -- --coverage` in CI). Each
// project is its own vitest run and would wipe the previous one's report, so a
// coverage run writes one per project for SonarCloud to merge.
const extra = process.argv.slice(2);
const coverage = extra.includes('--coverage');

for (const project of PROJECTS) {
  const args = [VITEST_BIN, 'run', '--project', project, ...extra];
  if (coverage) args.push(`--coverage.reportsDirectory=coverage/${project}`);
  const result = spawnSync(process.execPath, args, {
    stdio: 'inherit',
    timeout: TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });

  if (result.error || result.signal) {
    console.error(
      `\n[run-tests] "${project}" project timed out or was killed (signal: ${result.signal ?? 'n/a'}) after ${TIMEOUT_MS}ms — treating as failure.`,
    );
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
