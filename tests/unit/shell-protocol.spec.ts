import { describe, it, expect } from 'vitest';
import {
  isShellInput,
  isShellMessage,
  isShellStartRequest,
} from '../../electron/script-runner/shellProtocol';

describe('isShellMessage (child -> main)', () => {
  it('accepts output with text and an exit notice', () => {
    expect(isShellMessage({ type: 'shell-out', data: 'x' })).toBe(true);
    expect(isShellMessage({ type: 'shell-out', data: '' })).toBe(true);
    expect(isShellMessage({ type: 'shell-exit' })).toBe(true);
  });

  it('accepts the notice that the REPL is waiting for input again', () => {
    expect(isShellMessage({ type: 'shell-prompt' })).toBe(true);
  });

  it('rejects output without text, other types, and non-objects', () => {
    expect(isShellMessage({ type: 'shell-out' })).toBe(false);
    expect(isShellMessage({ type: 'shell-out', data: 5 })).toBe(false);
    expect(isShellMessage({ type: 'result' })).toBe(false);
    expect(isShellMessage({ data: 'x' })).toBe(false);
    expect(isShellMessage(null)).toBe(false);
    expect(isShellMessage('shell-exit')).toBe(false);
    expect(isShellMessage(undefined)).toBe(false);
  });
});

describe('isShellStartRequest', () => {
  it('needs a db name and a banner, both strings', () => {
    expect(isShellStartRequest({ type: 'shell-start', dbName: 'test', banner: 'hi' })).toBe(true);
    expect(isShellStartRequest({ type: 'shell-start', dbName: '', banner: '' })).toBe(true);
    expect(isShellStartRequest({ type: 'shell-start', dbName: 'test' })).toBe(false);
    expect(isShellStartRequest({ type: 'shell-start', banner: 'hi' })).toBe(false);
    expect(isShellStartRequest({ type: 'shell-start', dbName: 1, banner: 'hi' })).toBe(false);
    expect(isShellStartRequest({ type: 'run', dbName: 'test', banner: 'hi' })).toBe(false);
    expect(isShellStartRequest(null)).toBe(false);
    expect(isShellStartRequest(7)).toBe(false);
  });
});

describe('isShellInput', () => {
  it('needs text', () => {
    expect(isShellInput({ type: 'shell-in', data: '1\n' })).toBe(true);
    expect(isShellInput({ type: 'shell-in', data: '' })).toBe(true);
    expect(isShellInput({ type: 'shell-in' })).toBe(false);
    expect(isShellInput({ type: 'shell-in', data: null })).toBe(false);
    expect(isShellInput({ type: 'shell-out', data: 'x' })).toBe(false);
    expect(isShellInput(null)).toBe(false);
    expect(isShellInput('shell-in')).toBe(false);
  });
});
