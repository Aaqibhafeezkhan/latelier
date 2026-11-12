import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { test, expect, type Page } from '@playwright/test';
import { MongoClient } from 'mongodb';
import { baseConnInput, startMemoryServer, stopAllMemoryServers, withApp } from '../helpers/e2eApp';
import { seedActiveConnectionWithDocs } from './helpers/uiSeed';
import { expectStatusDot } from './helpers/uiAsserts';
import { WorkspacePage } from './pages/WorkspacePage';

/**
 * Palette performance harness (X07 §13.7 rule 6). Measures, against a
 * 10,000-collection fixture, the time from ⌘K to the first painted list and
 * from a keystroke to the next paint. Opt-in: `npm run perf:palette`
 * (`ATELIER_PALETTE_PERF=1`); the normal e2e suite skips it and pays nothing.
 *
 * Results go to `$ATELIER_PALETTE_PERF_OUT` (default `test-results/palette-perf.json`).
 *
 * The palette is found by role (`combobox` input, `listbox` list), never by
 * class name, so the harness runs unchanged against later palette versions.
 *
 * Timing method: t0 is the `timeStamp` of the keydown (same clock as
 * `performance.now()`, so main-thread queueing before the handler counts).
 * t1 is taken by polling once per animation frame for the condition (list
 * present / list changed) and then reading the timestamp of the *next*
 * requestAnimationFrame callback, which starts only after the frame that
 * contained the update was produced. Resolution is therefore one frame
 * (~16 ms), and a blocked main thread shows up in full. Chosen over a
 * MutationObserver because the condition (visible, non-empty) is easier to
 * state per frame than as a mutation, and it behaves the same however a later
 * palette version mounts its list.
 */

const RUN = process.env.ATELIER_PALETTE_PERF === '1';
const DBS = 20;
const PER_DB = 500;
const RUNS = 15;
const WARMUP = 2;
const OUT = process.env.ATELIER_PALETTE_PERF_OUT ?? 'test-results/palette-perf.json';
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const collName = (db: number, i: number) =>
  `p${String(db).padStart(2, '0')}_c${String(i).padStart(4, '0')}`;

function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]!;
  return {
    n: s.length,
    median: Number(at(0.5).toFixed(1)),
    p90: Number(at(0.9).toFixed(1)),
    min: Number(s[0]!.toFixed(1)),
    max: Number(s[s.length - 1]!.toFixed(1)),
    runs: xs.map((x) => Number(x.toFixed(1))),
  };
}

type Probe = { ms: number; rows: number };

/** Arm an in-page probe; the result is read back with `readProbe` after the key press. */
async function armProbe(win: Page, kind: 'open' | 'keystroke'): Promise<void> {
  await win.evaluate((k) => {
    const w = window as unknown as { __perfP?: Promise<Probe | null> };
    // Scoped to the palette dialog: the Data View has its own comboboxes (rows per page).
    const palette = () => document.querySelector('[role="dialog"]:has(input[role="combobox"])');
    const options = () =>
      Array.from(palette()?.querySelectorAll('[role="listbox"] [role="option"]') ?? []);
    const sig = () => {
      const o = options();
      return `${o.length}|${o.slice(0, 30).map((e) => e.textContent).join('~')}`;
    };
    const before = sig();
    w.__perfP = new Promise((resolve) => {
      let t0 = -1;
      const onKey = (e: KeyboardEvent) => {
        if (k === 'open' && e.key.toLowerCase() !== 'k') return;
        t0 = e.timeStamp;
        window.removeEventListener('keydown', onKey, true);
        const deadline = performance.now() + 5000;
        const frame = () => {
          const lb = palette()?.querySelector('[role="listbox"]');
          const input = palette()?.querySelector('input[role="combobox"]');
          const shown =
            !!lb && !!input && (input as HTMLElement).checkVisibility() && options().length > 0;
          const ready = k === 'open' ? shown : shown && sig() !== before;
          if (ready) requestAnimationFrame((t) => resolve({ ms: t - t0, rows: options().length }));
          else if (performance.now() > deadline) resolve(null);
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      };
      window.addEventListener('keydown', onKey, true);
    });
  }, kind);
}

/** Wait until the palette's option list has stopped changing, so a probe never starts on a stale or still-rendering list. */
const settle = (win: Page) =>
  win.evaluate(async () => {
    const snap = () =>
      Array.from(
        document
          .querySelector('[role="dialog"]:has(input[role="combobox"])')
          ?.querySelectorAll('[role="listbox"] [role="option"]') ?? [],
      )
        .slice(0, 30)
        .map((e) => e.textContent)
        .join('~');
    let last = snap();
    let stable = 0;
    while (stable < 4) {
      await new Promise((r) => setTimeout(r, 100));
      const now = snap();
      stable = now === last ? stable + 1 : 0;
      last = now;
    }
  });

const readProbe = (win: Page) =>
  win.evaluate(() => (window as unknown as { __perfP: Promise<Probe | null> }).__perfP);

test.describe('palette performance', () => {
  test.skip(!RUN, 'set ATELIER_PALETTE_PERF=1 (npm run perf:palette) to run');
  test.setTimeout(20 * 60_000);
  test.afterAll(stopAllMemoryServers);

  test(`⌘K and keystroke latency with ${DBS * PER_DB} collections`, async () => {
    const { host, port } = await startMemoryServer();

    // Seeding is not measured: DBS × PER_DB collections, created in parallel batches.
    const client = await MongoClient.connect(`mongodb://${host}:${port}/?directConnection=true`);
    try {
      for (let d = 0; d < DBS; d++) {
        const db = client.db(`perf${String(d).padStart(2, '0')}`);
        for (let i = 0; i < PER_DB; i += 100) {
          await Promise.all(
            Array.from({ length: 100 }, (_, j) => db.createCollection(collName(d, i + j))),
          );
        }
      }
    } finally {
      await client.close();
    }

    await withApp(async (app) => {
      const win = await app.firstWindow();
      await win.waitForLoadState('domcontentloaded');
      const connName = 'Perf';
      await seedActiveConnectionWithDocs(
        win,
        { ...baseConnInput(host, port), name: connName },
        { dbName: 'shop', collection: 'orders', docs: [{ sku: 'a' }] },
      );
      await expectStatusDot(win, connName, 'connected');
      await new WorkspacePage(win).openCollectionFromNavigator('shop', 'orders');

      const search = win.getByRole('dialog').getByRole('combobox');
      const open = async () => {
        await win.keyboard.press(`${MOD}+K`);
        await expect(search).toBeVisible();
        await settle(win);
      };
      const close = async () => {
        // v1 keeps the query across close; every run must start from an empty one.
        await search.fill('');
        await win.keyboard.press('Escape');
        await expect(search).toBeHidden();
      };

      // Wait for the sweep: the last collection of every database is findable.
      await open();
      for (let d = 0; d < DBS; d++) {
        await search.fill(collName(d, PER_DB - 1));
        await expect(win.getByRole('option', { name: new RegExp(collName(d, PER_DB - 1)) }).first())
          .toBeVisible({ timeout: 180_000 });
      }
      await close();

      const opens: Probe[] = [];
      const single: Probe[] = [];
      const ord: [Probe[], Probe[], Probe[]] = [[], [], []];
      const keyC: Probe[] = [];
      const seqP: [Probe[], Probe[], Probe[]] = [[], [], []];
      const timed = async (arm: 'open' | 'keystroke', act: () => Promise<void>) => {
        await armProbe(win, arm);
        await act();
        const ms = await readProbe(win);
        await settle(win);
        expect(ms, `${arm} probe timed out: list never painted/changed`).not.toBeNull();
        return ms!;
      };

      for (let r = 0; r < WARMUP + RUNS; r++) {
        const keep = r >= WARMUP;
        const o = await timed('open', () => win.keyboard.press(`${MOD}+K`));
        await expect(search).toHaveValue('');
        const k1 = await timed('keystroke', () => win.keyboard.press('o'));
        await close();

        await open();
        await expect(search).toHaveValue('');
        const a = await timed('keystroke', () => win.keyboard.press('o'));
        const b = await timed('keystroke', () => win.keyboard.press('r'));
        const c = await timed('keystroke', () => win.keyboard.press('d'));
        await close();

        // Broad arms: every collection matches through its `<db>.<coll>` text in any palette version.
        await open();
        const bc = await timed('keystroke', () => win.keyboard.press('c'));
        await close();

        await open();
        const bp = await timed('keystroke', () => win.keyboard.press('p'));
        const bp0 = await timed('keystroke', () => win.keyboard.press('0'));
        const bp00 = await timed('keystroke', () => win.keyboard.press('0'));
        await close();

        if (keep) {
          keyC.push(bc);
          seqP[0].push(bp);
          seqP[1].push(bp0);
          seqP[2].push(bp00);
          opens.push(o);
          single.push(k1);
          ord[0].push(a);
          ord[1].push(b);
          ord[2].push(c);
        }
      }

      // Per arm: latency stats plus the median number of option rows at the measured frame.
      const arm = (xs: Probe[]) => ({
        ...stats(xs.map((x) => x.ms)),
        rowsMedian: stats(xs.map((x) => x.rows)).median,
      });
      const result = {
        collections: DBS * PER_DB + 1,
        runs: RUNS,
        platform: `${process.platform}-${process.arch}`,
        cpus: os.cpus()[0]?.model,
        openToFirstPaintMs: arm(opens),
        keystrokeOMs: arm(single),
        keystrokeCMs: arm(keyC),
        sequenceOrdMs: {
          o: arm(ord[0]),
          or: arm(ord[1]),
          ord: arm(ord[2]),
        },
        sequenceP00Ms: {
          p: arm(seqP[0]),
          p0: arm(seqP[1]),
          p00: arm(seqP[2]),
        },
      };
      fs.mkdirSync(path.dirname(OUT), { recursive: true });
      fs.writeFileSync(OUT, JSON.stringify(result, null, 2) + '\n');
      process.stdout.write(
        `palette-perf: open median ${result.openToFirstPaintMs.median}ms p90 ${result.openToFirstPaintMs.p90}ms | ` +
          `key "o" median ${result.keystrokeOMs.median}ms p90 ${result.keystrokeOMs.p90}ms | ` +
          `"ord" 3rd key median ${result.sequenceOrdMs.ord.median}ms p90 ${result.sequenceOrdMs.ord.p90}ms ` +
          `key "c" median ${result.keystrokeCMs.median}ms rows ${result.keystrokeCMs.rowsMedian} | ` +
          `"p00" 3rd key median ${result.sequenceP00Ms.p00.median}ms rows ${result.sequenceP00Ms.p00.rowsMedian} -> ${OUT}\n`,
      );
    });
  });
});
