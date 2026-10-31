import { describe, it, expect } from 'vitest';
import { PLAINTEXT_FALLBACK_KEY, isPrefGetKey, prefSetSchema } from '../../electron/ipc/prefKeys';

const UUID = '3f2b8c1e-9a4d-4e57-8b0c-1d2e3f4a5b6c';
const CONN_KEY = `ui.workspace.navigator.connExpanded:${UUID}`;

const VALID: Record<string, unknown> = {
  'ui.showSystemDbs': true,
  'ui.users.lastDb': 'admin',
  'ui.hints.dismissed': { dismissedIds: ['run.execute'], resetAt: '2026-01-01T00:00:00.000Z' },
  'ui.workspace.defaultPageSize': 50,
  'ui.workspace.defaultView': 'JSON',
  'ui.editor.fontSize': 14,
  'ui.workspace.leftWidth': 240,
  'ui.workspace.refDrawerWidth': 320,
  'ui.workspace.innerHSplit': 60,
  'ui.workspace.shellSplit': 40,
  'ui.workspace.sidebarCollapsed': false,
  'ui.workspace.builderCollapsed': true,
  'ui.workspace.restoreTabs': false,
  'ui.workspace.documentEditorSize': { width: 600, height: 400 },
  'ui.commandPalette.mru': ['tab.new', 'query.run'],
  'ui.connections.pinned': [UUID],
  [CONN_KEY]: true,
};

describe('prefKeys', () => {
  it.each(Object.entries(VALID))('%s accepts its value shape for set and get', (key, value) => {
    expect(prefSetSchema(key)?.safeParse(value).success).toBe(true);
    expect(isPrefGetKey(key)).toBe(true);
  });

  it('the plaintext switch is readable but never writable', () => {
    expect(isPrefGetKey(PLAINTEXT_FALLBACK_KEY)).toBe(true);
    expect(prefSetSchema(PLAINTEXT_FALLBACK_KEY)).toBeNull();
  });

  it.each([
    'window.bounds',
    'window.maximized',
    'theme.mode',
    'maintenance.lastRunAt',
    'ui.unknown',
    '',
    '__proto__',
    'constructor',
    'toString',
    'ui.workspace.navigator.connExpanded:',
    `ui.workspace.navigator.connExpanded:${UUID}x`,
    `xui.workspace.navigator.connExpanded:${UUID}`,
    `ui.workspace.navigator.connExpanded:${UUID.toUpperCase()}`,
    `ui.workspace.navigator.connExpanded:${UUID}\n`,
    'ui.workspace.navigator.connExpanded:not-a-uuid',
    `ui.workspace.navigator.connExpandedX${UUID}`,
  ])('%j is main-only or unknown: neither readable nor writable', (key) => {
    expect(isPrefGetKey(key)).toBe(false);
    expect(prefSetSchema(key)).toBeNull();
  });

  it.each([
    ['ui.showSystemDbs', 'yes'],
    ['ui.showSystemDbs', null],
    ['ui.users.lastDb', 5],
    ['ui.users.lastDb', 'x'.repeat(1025)],
    ['ui.workspace.defaultView', 'Grid'],
    ['ui.workspace.defaultView', 'table'],
    ['ui.workspace.defaultView', null],
    ['ui.editor.fontSize', 9],
    ['ui.editor.fontSize', 21],
    ['ui.editor.fontSize', 13.5],
    ['ui.editor.fontSize', '14'],
    ['ui.workspace.leftWidth', Number.NaN],
    ['ui.workspace.leftWidth', Number.POSITIVE_INFINITY],
    ['ui.workspace.leftWidth', '240'],
    ['ui.workspace.sidebarCollapsed', 1],
    ['ui.workspace.restoreTabs', 'false'],
    ['ui.workspace.documentEditorSize', { height: 4 }],
    ['ui.workspace.documentEditorSize', { width: 4, height: Number.NaN }],
    ['ui.hints.dismissed', { dismissedIds: 'run.execute' }],
    ['ui.hints.dismissed', { dismissedIds: [1] }],
    ['ui.hints.dismissed', { dismissedIds: Array.from({ length: 65 }, () => 'a') }],
    ['ui.hints.dismissed', { dismissedIds: ['x'.repeat(65)] }],
    ['ui.hints.dismissed', { dismissedIds: [], resetAt: 'x'.repeat(65) }],
    [CONN_KEY, 'true'],
    ['ui.commandPalette.mru', 'tab.new'],
    ['ui.commandPalette.mru', [1]],
    ['ui.commandPalette.mru', Array.from({ length: 17 }, () => 'a')],
    ['ui.commandPalette.mru', ['x'.repeat(513)]],
    ['ui.connections.pinned', UUID],
    ['ui.connections.pinned', ['not-a-uuid']],
    ['ui.connections.pinned', [1]],
    ['ui.connections.pinned', [UUID.slice(1)]],
    ['ui.connections.pinned', Array.from({ length: 501 }, () => UUID)],
  ])('%s rejects %j', (key, value) => {
    expect(prefSetSchema(key)?.safeParse(value).success).toBe(false);
  });

  it('the editor font size accepts both ends of its range', () => {
    expect(prefSetSchema('ui.editor.fontSize')?.safeParse(10).success).toBe(true);
    expect(prefSetSchema('ui.editor.fontSize')?.safeParse(20).success).toBe(true);
  });

  it('the default result view accepts each view the tab can show', () => {
    for (const v of ['Table', 'Tree', 'JSON']) {
      expect(prefSetSchema('ui.workspace.defaultView')?.safeParse(v).success).toBe(true);
    }
  });

  it('bounds hold at the limit', () => {
    expect(
      prefSetSchema('ui.connections.pinned')?.safeParse(Array.from({ length: 500 }, () => UUID)).success,
    ).toBe(true);
    expect(prefSetSchema('ui.connections.pinned')?.safeParse([]).success).toBe(true);
    expect(
      prefSetSchema('ui.users.lastDb')?.safeParse('x'.repeat(1024)).success,
    ).toBe(true);
    expect(
      prefSetSchema('ui.hints.dismissed')?.safeParse({
        dismissedIds: Array.from({ length: 64 }, () => 'x'.repeat(64)),
        resetAt: 'x'.repeat(64),
      }).success,
    ).toBe(true);
    expect(
      prefSetSchema('ui.workspace.documentEditorSize')?.safeParse({ width: 1 }).success,
    ).toBe(true);
    expect(
      prefSetSchema('ui.commandPalette.mru')?.safeParse(
        Array.from({ length: 16 }, () => 'x'.repeat(512)),
      ).success,
    ).toBe(true);
  });
});
