import { describe, it, expect, afterEach, vi } from 'vitest';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { IpcApi } from '@shared/ipc';

// The "warned once" flag is module state, so each test takes a fresh copy.
async function load() {
  vi.resetModules();
  return import('../../src/utils/rendererLog');
}

function mockLog(impl: IpcApi['app']['log'] = async () => undefined) {
  const log = vi.fn<IpcApi['app']['log']>(impl);
  installAtelierMock({ app: { log } });
  return log;
}

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

describe('logToMain', () => {
  it('sends the line as given, with no stack key when there is no stack', async () => {
    const { logToMain } = await load();
    const log = mockLog();
    logToMain('warn', 'hello', 'component');
    logToMain('error', 'boom', 'window.error', 'Error: boom\n    at f');
    expect(log.mock.calls.map((c) => c[0])).toEqual([
      { level: 'warn', message: 'hello', source: 'component' },
      { level: 'error', message: 'boom', source: 'window.error', stack: 'Error: boom\n    at f' },
    ]);
  });

  it('cuts the message to 2000 and the stack to 8000 characters, for any source', async () => {
    const { logToMain } = await load();
    const log = mockLog();
    logToMain('error', 'm'.repeat(2001), 'unhandledrejection', 's'.repeat(8001));
    logToMain('error', 'm'.repeat(2000), 'component', 's'.repeat(8000));
    for (const [sent] of log.mock.calls) {
      expect(sent.message).toBe('m'.repeat(2000));
      expect(sent.stack).toBe('s'.repeat(8000));
    }
  });

  it('warns once on the console when main refuses, and never rejects', async () => {
    const { logToMain } = await load();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const refusal = { code: 'VALIDATION', message: 'bad' };
    mockLog(async () => {
      throw refusal;
    });
    expect(logToMain('error', 'a', 'component')).toBeUndefined();
    logToMain('error', 'b', 'component');
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toBe(refusal);
  });

  it('does not throw when the bridge is missing, and warns once', async () => {
    const { logToMain } = await load();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The test helpers leave a permissive stub behind; take the bridge away entirely.
    delete (window as { atelier?: IpcApi }).atelier;
    expect(() => {
      logToMain('error', 'a', 'component');
      logToMain('error', 'b', 'component');
    }).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not throw for a message or stack that is not a string', async () => {
    const { logToMain } = await load();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockLog();
    expect(() => logToMain('error', 42 as unknown as string, 'component', {} as unknown as string)).not.toThrow();
  });
});

// An Error whose message and stack were reassigned to non-strings.
function oddError(): Error {
  const err = new Error('x');
  (err as { message: unknown }).message = 42;
  (err as { stack: unknown }).stack = { toString: () => 'custom stack' };
  return err;
}

describe('describeError', () => {
  it('coerces an Error message and stack that are not strings', async () => {
    const { describeError } = await load();
    expect(describeError(oddError())).toStrictEqual({ message: '42', stack: 'custom stack' });
  });

  it('leaves the stack out when an Error has none', async () => {
    const { describeError } = await load();
    const err = new Error('bare');
    err.stack = undefined;
    expect(describeError(err)).toStrictEqual({ message: 'bare' });
  });

  it('survives an Error whose message getter throws', async () => {
    const { describeError } = await load();
    const err = new Error('x');
    Object.defineProperty(err, 'message', { get: () => { throw new Error('no'); } });
    expect(describeError(err)).toEqual({ message: 'a value that cannot be printed was thrown' });
  });

  it('takes the message and stack of an Error', async () => {
    const { describeError } = await load();
    const err = new TypeError('nope');
    expect(describeError(err)).toEqual({ message: 'nope', stack: err.stack });
  });

  it.each([
    ['a string', 'plain', 'plain'],
    ['a number', 42, '42'],
    ['undefined', undefined, 'undefined'],
  ])('prints %s, with no stack', async (_label, value, message) => {
    const { describeError } = await load();
    expect(describeError(value)).toEqual({ message });
  });

  it('survives a value String() cannot print', async () => {
    const { describeError } = await load();
    expect(describeError(Object.create(null))).toEqual({ message: 'a value that cannot be printed was thrown' });
  });
});

describe('installGlobalErrorLogging', () => {
  async function setup() {
    const { installGlobalErrorLogging } = await load();
    const log = mockLog();
    const target = new EventTarget() as Window;
    installGlobalErrorLogging(target);
    return { log, target };
  }

  it('forwards an uncaught error with its stack', async () => {
    const { log, target } = await setup();
    const error = new Error('kaput');
    target.dispatchEvent(new ErrorEvent('error', { error, message: 'Uncaught Error: kaput' }));
    expect(log).toHaveBeenCalledWith({ level: 'error', message: 'kaput', source: 'window.error', stack: error.stack });
  });

  it('still logs an Error whose message and stack are not strings', async () => {
    const { log, target } = await setup();
    target.dispatchEvent(new ErrorEvent('error', { error: oddError(), message: 'Uncaught' }));
    expect(log).toHaveBeenCalledWith({ level: 'error', message: '42', source: 'window.error', stack: 'custom stack' });
  });

  it('falls back to the event message when the error object is withheld', async () => {
    const { log, target } = await setup();
    target.dispatchEvent(new ErrorEvent('error', { message: 'Script error.' }));
    expect(log).toHaveBeenCalledWith({ level: 'error', message: 'Script error.', source: 'window.error' });
  });

  it('forwards an unhandled rejection, Error or not', async () => {
    const { log, target } = await setup();
    const error = new Error('rejected');
    for (const reason of [error, 'just a string']) {
      // jsdom has no PromiseRejectionEvent constructor.
      const event = Object.assign(new Event('unhandledrejection'), { reason });
      target.dispatchEvent(event);
    }
    expect(log.mock.calls.map((c) => c[0])).toEqual([
      { level: 'error', message: 'rejected', source: 'unhandledrejection', stack: error.stack },
      { level: 'error', message: 'just a string', source: 'unhandledrejection' },
    ]);
  });
});

describe('logFailure', () => {
  it('names the action, carries the error message, and adds a stack only for an Error', async () => {
    const { logFailure } = await load();
    const log = mockLog();
    const error = new Error('disk full');
    logFailure('saving preference ui.x', error);
    logFailure('saving preference ui.x', { code: 'INTERNAL', message: 'refused' });
    logFailure('saving preference ui.x', 'a bare string');
    expect(log.mock.calls.map((c) => c[0])).toEqual([
      { level: 'warn', message: 'saving preference ui.x failed: disk full', source: 'component', stack: error.stack },
      { level: 'warn', message: 'saving preference ui.x failed: refused', source: 'component' },
      { level: 'warn', message: 'saving preference ui.x failed: unknown error', source: 'component' },
    ]);
  });
});
