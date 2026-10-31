import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';

vi.mock('electron', () => ({ dialog: {}, shell: {} }));

// Imports must come after the mock so the handler binds to the stub.
const { createRouter } = await import('../../electron/ipc/router');
const { registerAppChannels, resetGateOnFreshPage } = await import('../../electron/ipc/handlers/app');
const { IPC_CHANNELS } = await import('../../shared/ipc');
const { createLogger, createRateGate } = await import('../../electron/log');
import { invokeEvent, testSenderCheck } from '../helpers/ipcSender';
import { createPickedCredentialPaths } from '../../electron/security/credentialPaths';
import type { RateGate } from '../../electron/log';

type Handler = (evt: IpcMainInvokeEvent, payload: unknown) => unknown;
type Envelope<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
interface Line { level: string; tag: string; msg: string; data?: { source?: string; stack?: string } }

describe('app:log', () => {
  const handlers = new Map<string, Handler>();
  let dir: string;
  let gate: RateGate;
  const send = async (payload: unknown) =>
    (await handlers.get(IPC_CHANNELS.appLog)!(invokeEvent, payload)) as Envelope<void>;
  const allLines = (): Line[] => {
    const logsDir = path.join(dir, 'logs');
    return fs.readdirSync(logsDir)
      .flatMap((f) => fs.readFileSync(path.join(logsDir, f), 'utf8').trim().split('\n'))
      .filter((l) => l)
      .map((l) => JSON.parse(l) as Line);
  };
  // Only the lines the channel wrote: a refused call also gets the router's `ipc.err`.
  const rendererLines = (): Line[] => allLines().filter((l) => l.tag === 'renderer');

  function register(withSink = true, now: () => number = () => 1_000) {
    handlers.clear();
    const log = createLogger(dir, { toStderr: false });
    gate = createRateGate(50, 60_000, now);
    // The same logger as the router's, as in main, so the router's own lines land in the file too.
    const router = createRouter({ handle: (c: string, fn: Handler) => void handlers.set(c, fn) }, testSenderCheck, log);
    registerAppChannels(
      router, () => null, new Set(), createPickedCredentialPaths(), undefined, undefined, undefined,
      withSink ? { log, gate } : undefined,
    );
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'latelier-app-log-'));
    register();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes the line at its level under the renderer tag, with source and stack, scrubbed', async () => {
    const res = await send({
      level: 'error',
      message: 'connect failed for mongodb://alice:hunter2@host/db',
      source: 'window.error',
      stack: 'Error: x\n    at f (app.js:1:1)',
    });
    expect(res.ok).toBe(true);
    await send({ level: 'warn', message: 'mshell stop failed during cleanup', source: 'component' });
    const lines = rendererLines();
    expect(lines).toEqual([
      {
        t: expect.any(String),
        level: 'error',
        tag: 'renderer',
        msg: 'connect failed for mongodb://***@host/db',
        data: { source: 'window.error', stack: 'Error: x\n    at f (app.js:1:1)' },
      },
      { t: expect.any(String), level: 'warn', tag: 'renderer', msg: 'mshell stop failed during cleanup', data: { source: 'component' } },
    ]);
    expect(JSON.stringify(lines)).not.toContain('hunter2');
  });

  it('accepts a message and a stack exactly at their caps', async () => {
    const res = await send({ level: 'warn', message: 'm'.repeat(2000), source: 'errorBoundary', stack: 's'.repeat(8000) });
    expect(res.ok).toBe(true);
    expect(rendererLines()).toHaveLength(1);
  });

  it.each([
    ['an unknown level', { level: 'info', message: 'x', source: 'component' }],
    ['an unknown source', { level: 'warn', message: 'x', source: 'console' }],
    ['a message over 2000 characters', { level: 'warn', message: 'm'.repeat(2001), source: 'component' }],
    ['a stack over 8000 characters', { level: 'warn', message: 'x', source: 'component', stack: 's'.repeat(8001) }],
    ['a missing message', { level: 'warn', source: 'component' }],
    ['a non-object payload', 'boom'],
  ])('refuses %s without writing anything', async (_label, payload) => {
    const res = await send(payload);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('VALIDATION');
    expect(rendererLines()).toEqual([]);
  });

  it('writes 50 lines a window, then one notice, then nothing, still answering ok', async () => {
    for (let i = 0; i < 50; i++) {
      expect((await send({ level: 'error', message: `m${i}`, source: 'component' })).ok).toBe(true);
    }
    expect((await send({ level: 'error', message: 'm50', source: 'component' })).ok).toBe(true);
    expect((await send({ level: 'error', message: 'm51', source: 'component' })).ok).toBe(true);
    const lines = rendererLines();
    expect(lines).toHaveLength(51);
    expect(lines.slice(0, 50).map((l) => l.msg)).toEqual(Array.from({ length: 50 }, (_, i) => `m${i}`));
    // The window opened at t=1000 ms on the injected clock.
    expect(lines[50]).toMatchObject({
      level: 'warn',
      tag: 'renderer',
      msg: `renderer log rate limit reached; dropping until ${new Date(61_000).toISOString()}`,
    });
  });

  it('a flood writes only the gated lines and one notice: the router adds nothing per call', async () => {
    for (let i = 0; i < 200; i++) {
      await send({ level: 'error', message: `loop ${i}`, source: 'window.error', stack: 's'.repeat(8000) });
    }
    const lines = allLines();
    expect(lines).toHaveLength(51);
    expect(lines.filter((l) => l.tag !== 'renderer')).toEqual([]);
    expect(lines.at(-1)!.msg).toMatch(/^renderer log rate limit reached/);
  });

  it('takes lines again once the gate is reset, as a fresh page does', async () => {
    for (let i = 0; i < 51; i++) await send({ level: 'error', message: `m${i}`, source: 'component' });
    gate.reset();
    await send({ level: 'error', message: 'after reload', source: 'component' });
    expect(rendererLines().at(-1)).toMatchObject({ level: 'error', msg: 'after reload' });
  });

  it('fails as INTERNAL when no sink was given', async () => {
    register(false);
    const res = await send({ level: 'warn', message: 'x', source: 'component' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('INTERNAL');
  });
});

describe('resetGateOnFreshPage', () => {
  type Details = { isMainFrame: boolean; isSameDocument: boolean };
  function setup() {
    let listener: ((d: Details) => void) | null = null;
    const webContents = {
      on: (event: 'did-start-navigation', fn: (d: Details) => void) => {
        expect(event).toBe('did-start-navigation');
        listener = fn;
      },
    };
    const gate = createRateGate(1, 60_000, () => 0);
    resetGateOnFreshPage(webContents, gate);
    gate.take();
    return { gate, navigate: (d: Details) => listener!(d) };
  }

  it('gives a full page load a fresh allowance', () => {
    const { gate, navigate } = setup();
    navigate({ isMainFrame: true, isSameDocument: false });
    expect(gate.take()).toEqual({ allow: true });
  });

  it.each([
    ['a same-document (hash) navigation', { isMainFrame: true, isSameDocument: true }],
    ['a subframe navigation', { isMainFrame: false, isSameDocument: false }],
  ])('keeps the window through %s', (_label, details) => {
    const { gate, navigate } = setup();
    navigate(details);
    expect(gate.take()).toMatchObject({ allow: false });
  });
});
