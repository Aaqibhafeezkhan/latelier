// Behaviour-triggered hints (X06 §4): startup.restore, monitor.live,
// monitor.profiler, indexes.usage, find.options. Each is shown when its
// trigger holds, absent when it does not, and gone for good once dismissed.
// Hints sit behind the provider's 1.5 s settle window, so a "hidden" check
// waits it out first or it would pass for the wrong reason.
import React from 'react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
  emptyWorkspaceActions,
  emptyWorkspaceMeta,
} from '../helpers/render';
import { HintsProvider } from '../../src/hints/HintsProvider';
import { HINT_REGISTRY } from '../../src/hints/registry';
import { resetLaunchRestore } from '../../src/hints/launchRestore';
import { MonitorTab } from '../../src/pages/MonitorTab';
import { IndexesTab } from '../../src/pages/IndexesTab';
import { QueryBar } from '../../src/pages/Workspace/QueryBar';
import { CollectionWorkspaceProvider } from '../../src/pages/Workspace/CollectionWorkspaceProvider';
import Workspace from '../../src/pages/Workspace';
import { SettingsProvider } from '../../src/pages/SettingsContext';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type {
  BuilderState,
  CollectionTab,
  CollectionTabState,
  ConnectionRuntime,
  ConnectionSummary,
  FeatureHintDismissalState,
  FeatureHintId,
  IndexInfo,
} from '@shared/types';

const HINTS_KEY = 'ui.hints.dismissed';
const SETTLE_WAIT_MS = 1800;

beforeEach(() => resetLaunchRestore());
afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

const settle = () => new Promise((r) => setTimeout(r, SETTLE_WAIT_MS));
const hintDialog = (id: FeatureHintId) =>
  screen.queryByRole('dialog', { name: HINT_REGISTRY[id].title });

/** In-memory prefs; `dismissed` pre-seeds ui.hints.dismissed so one hint cannot hide behind another. */
function memoryPrefs(dismissed: FeatureHintId[] = []) {
  const store = new Map<string, unknown>([
    [HINTS_KEY, { dismissedIds: dismissed } satisfies FeatureHintDismissalState],
  ]);
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
      return value;
    }),
  } as never;
}

async function expectDismissible(id: FeatureHintId, prefs: ReturnType<typeof memoryPrefs>) {
  const dialog = await waitFor(() => screen.getByRole('dialog', { name: HINT_REGISTRY[id].title }), {
    timeout: 3000,
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Got it' }));
  await waitFor(() => expect(hintDialog(id)).toBeNull());
  const set = (prefs as unknown as { set: ReturnType<typeof vi.fn> }).set;
  await waitFor(() =>
    expect(set).toHaveBeenCalledWith(
      HINTS_KEY,
      expect.objectContaining({ dismissedIds: expect.arrayContaining([id]) }),
    ),
  );
}

// ─── startup.restore ──────────────────────────────────────────────────────

const now = '2026-06-01T12:00:00.000Z';
const collectionTab: CollectionTab = {
  id: 't1',
  kind: 'collection',
  connectionId: 'c1',
  dbName: 'mydb',
  collection: 'users',
  position: 0,
  isActive: true,
  openedAt: now,
  pinned: false,
  state: {
    view: 'Tree',
    builder: { projection: [], sort: '', limit: '' },
    queryRaw: '{}',
    page: 0,
    pageSize: 50,
    activeBuilderTab: 'Builder',
  },
};
const connections = [
  {
    id: 'c1',
    name: 'Local',
    color: '#1A6835',
    host: 'localhost',
    port: 27017,
    connectionType: 'standard' as const,
    readOnly: false,
    status: 'connected' as const,
  },
];

function mountWorkspace(tabsList: () => Promise<CollectionTab[]>, prefs = memoryPrefs()) {
  installAtelierMock({
    prefs,
    tabs: {
      list: tabsList,
      setActive: async (id) => ({ id }),
      update: async () => collectionTab,
    },
    conn: { list: async () => connections },
    query: {
      find: async () => ({ documents: [{ _id: { $oid: 'abc123abc123abc123abc123' }, name: 'Alice' }], durationMs: 1, hasMore: false }),
      count: async () => ({ count: 1 }),
    },
  });
  const view = render(
    <MemoryRouter initialEntries={['/workspace']}>
      <SettingsProvider>
        <HintsProvider>
          <Workspace />
        </HintsProvider>
      </SettingsProvider>
    </MemoryRouter>,
  );
  return { prefs, unmount: view.unmount };
}

describe('startup.restore hint', () => {
  it('shows when tabs came back at launch, anchored on the tab strip', async () => {
    mountWorkspace(async () => [collectionTab]);
    await waitFor(() => expect(hintDialog('startup.restore')).not.toBeNull(), { timeout: 3000 });
    expect(document.querySelector('[data-hint-anchor="startup.restore"]')).toBe(
      screen.getByRole('tablist', { name: 'Open tabs' }),
    );
  });

  it('stays hidden when no tab came back', async () => {
    mountWorkspace(async () => []);
    await screen.findByRole('tablist', { name: 'Open tabs' });
    await settle();
    expect(hintDialog('startup.restore')).toBeNull();
  });

  it('stays hidden for a tab opened in-session after an empty launch', async () => {
    let list: CollectionTab[] = [];
    const first = mountWorkspace(async () => list);
    await screen.findByRole('tablist', { name: 'Open tabs' });
    first.unmount();
    // The user opens a tab, then comes back to the Workspace route: the
    // launch snapshot was taken once and must not be re-read.
    list = [collectionTab];
    mountWorkspace(async () => list);
    await screen.findByRole('tablist', { name: 'Open tabs' });
    await settle();
    expect(hintDialog('startup.restore')).toBeNull();
  });

  it('is hidden after dismiss and the dismissal is persisted', async () => {
    const { prefs } = mountWorkspace(async () => [collectionTab]);
    await expectDismissible('startup.restore', prefs);
  });

  it('its CTA opens Settings', async () => {
    mountWorkspace(async () => [collectionTab]);
    const dialog = await waitFor(() => screen.getByRole('dialog', { name: HINT_REGISTRY['startup.restore'].title }), {
      timeout: 3000,
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open settings' }));
    expect(await screen.findByRole('switch', { name: 'Reopen tabs on launch' })).toBeTruthy();
  });
});

// ─── monitor.live / monitor.profiler ──────────────────────────────────────

const conn: ConnectionSummary = {
  id: 'c1',
  name: 'MyConn',
  color: '#1A6835',
  host: 'localhost',
  port: 27017,
  connectionType: 'standard',
  readOnly: false,
  status: 'connected',
  defaultDb: 'shop',
};
const connectedRuntime: ConnectionRuntime = { id: 'c1', status: 'connected' };

function mountMonitor(
  runtime: ConnectionRuntime,
  prefs: ReturnType<typeof memoryPrefs>,
  admin: Record<string, unknown> = {},
  dbNames: string[] = ['shop'],
) {
  installAtelierMock({
    prefs,
    meta: { listDatabases: async () => dbNames.map((name) => ({ name, sizeOnDisk: 0, empty: false })) },
    admin: {
      currentOp: async () => ({ ops: [] }),
      profileStatus: async () => ({ level: 0 as const, slowms: 100 }),
      profileTail: async () => ({ docs: [] }),
      setProfileLevel: async () => ({ ok: true as const }),
      ...admin,
    } as never,
  });
  render(
    <HintsProvider>
      <MonitorTab conn={conn} runtime={runtime} />
    </HintsProvider>,
  );
}

describe('monitor.live hint', () => {
  it('shows once connected, quotes the poll interval, anchors on Pause', async () => {
    mountMonitor(connectedRuntime, memoryPrefs());
    const dialog = await waitFor(() => screen.getByRole('dialog', { name: HINT_REGISTRY['monitor.live'].title }), {
      timeout: 3000,
    });
    expect(dialog.textContent).toContain('every 5 s');
    expect(document.querySelector('[data-hint-anchor="monitor.live"]')).toBe(
      screen.getByRole('button', { name: 'Pause' }),
    );
  });

  it('stays hidden while disconnected', async () => {
    mountMonitor({ id: 'c1', status: 'disconnected' }, memoryPrefs());
    await settle();
    expect(hintDialog('monitor.live')).toBeNull();
  });

  it('is hidden after dismiss and the dismissal is persisted', async () => {
    const prefs = memoryPrefs();
    mountMonitor(connectedRuntime, prefs);
    await expectDismissible('monitor.live', prefs);
  });
});

describe('monitor.profiler hint', () => {
  it('shows after Apply succeeds with a level other than Off, anchored on the profiler toolbar', async () => {
    mountMonitor(connectedRuntime, memoryPrefs(['monitor.live']));
    const prof = screen.getByRole('region', { name: 'Profiler' });
    await waitFor(() => expect((within(prof).getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(false));
    await settle();
    expect(hintDialog('monitor.profiler')).toBeNull();

    fireEvent.click(within(prof).getByText('All'));
    fireEvent.click(within(prof).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(hintDialog('monitor.profiler')).not.toBeNull(), { timeout: 3000 });
    // The toolbar, not the section: the profile table below can run off-screen.
    const anchor = document.querySelector('[data-hint-anchor="monitor.profiler"]');
    expect(anchor).not.toBe(prof);
    expect(prof.contains(anchor)).toBe(true);
    expect(within(prof).getByRole('button', { name: 'Apply' }).closest('[data-hint-anchor]')).toBe(anchor);
  });

  it('ignores an Apply that finishes after another database was picked', async () => {
    let release!: () => void;
    const setProfileLevel = vi.fn(
      () => new Promise<{ ok: true }>((resolve) => (release = () => resolve({ ok: true }))),
    );
    mountMonitor(connectedRuntime, memoryPrefs(['monitor.live']), { setProfileLevel }, ['shop', 'other']);
    const prof = screen.getByRole('region', { name: 'Profiler' });
    await waitFor(() => expect((within(prof).getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(prof).getByText('All'));
    fireEvent.click(within(prof).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(setProfileLevel).toHaveBeenCalled());

    fireEvent.change(within(prof).getByRole('combobox', { name: 'Profiler database' }), { target: { value: 'other' } });
    release();
    await settle();
    expect(hintDialog('monitor.profiler')).toBeNull();
  });

  it('stays hidden when Apply sets the level to Off', async () => {
    const setProfileLevel = vi.fn(async () => ({ ok: true as const }));
    mountMonitor(connectedRuntime, memoryPrefs(['monitor.live']), { setProfileLevel });
    const prof = screen.getByRole('region', { name: 'Profiler' });
    await waitFor(() => expect((within(prof).getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(prof).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(setProfileLevel).toHaveBeenCalled());
    await settle();
    expect(hintDialog('monitor.profiler')).toBeNull();
  });

  it('stays hidden when Apply fails', async () => {
    const setProfileLevel = vi.fn(async () => {
      throw new Error('not authorized');
    });
    mountMonitor(connectedRuntime, memoryPrefs(['monitor.live']), { setProfileLevel });
    const prof = screen.getByRole('region', { name: 'Profiler' });
    await waitFor(() => expect((within(prof).getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(prof).getByText('All'));
    fireEvent.click(within(prof).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(setProfileLevel).toHaveBeenCalled());
    await settle();
    expect(hintDialog('monitor.profiler')).toBeNull();
  });

  it('is hidden after dismiss and the dismissal is persisted', async () => {
    const prefs = memoryPrefs(['monitor.live']);
    mountMonitor(connectedRuntime, prefs);
    const prof = screen.getByRole('region', { name: 'Profiler' });
    await waitFor(() => expect((within(prof).getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(prof).getByText('Slow'));
    fireEvent.click(within(prof).getByRole('button', { name: 'Apply' }));
    await expectDismissible('monitor.profiler', prefs);
  });
});

// ─── indexes.usage ────────────────────────────────────────────────────────

const baseIndex: IndexInfo = {
  name: 'email_1',
  key: [{ field: 'email', direction: 1 }],
  isIdIndex: false,
  unique: false,
  sparse: false,
  hidden: false,
  version: 2,
};
const usedIndex: IndexInfo = { ...baseIndex, usage: { ops: 3, since: '2026-04-01T00:00:00.000Z' } };

function mountIndexes(list: IndexInfo[], prefs = memoryPrefs()) {
  installAtelierMock({ prefs, index: { list: async () => list } });
  render(
    <HintsProvider>
      <IndexesTab connectionId="c1" dbName="alpha" collection="people" />
    </HintsProvider>,
  );
  return prefs;
}

describe('indexes.usage hint', () => {
  it('shows once an index has usage data, anchored on the Use column', async () => {
    mountIndexes([usedIndex]);
    await waitFor(() => expect(hintDialog('indexes.usage')).not.toBeNull(), { timeout: 3000 });
    expect(document.querySelector('[data-hint-anchor="indexes.usage"]')?.textContent).toBe('Use');
  });

  it('stays hidden when no index carries usage data', async () => {
    mountIndexes([baseIndex]);
    await screen.findByText('email_1');
    await settle();
    expect(hintDialog('indexes.usage')).toBeNull();
  });

  it('is hidden after dismiss and the dismissal is persisted', async () => {
    const prefs = mountIndexes([usedIndex]);
    await expectDismissible('indexes.usage', prefs);
  });
});

// ─── find.options ─────────────────────────────────────────────────────────

const b = (over: Partial<BuilderState> = {}): BuilderState => ({ projection: [], sort: '', limit: '', ...over });

function QueryBarHarness({ initial }: { initial: BuilderState }) {
  const [state, setState] = React.useState<CollectionTabState>({
    view: 'Tree',
    builder: initial,
    queryRaw: '{}',
    page: 0,
    pageSize: 50,
    activeBuilderTab: 'Builder',
  });
  const actions = React.useMemo(
    () => emptyWorkspaceActions({ patch: (p) => setState((s) => ({ ...s, ...p })) }),
    [],
  );
  return (
    <CollectionWorkspaceProvider state={state} actions={actions} meta={emptyWorkspaceMeta()}>
      <QueryBar suggestionContext={null} />
    </CollectionWorkspaceProvider>
  );
}

function mountQueryBar(initial: BuilderState, prefs = memoryPrefs()) {
  installAtelierMock({ prefs });
  render(
    <HintsProvider>
      <QueryBarHarness initial={initial} />
    </HintsProvider>,
  );
  return prefs;
}

describe('find.options hint', () => {
  it('shows when the builder carries a hint, anchored on the options row', async () => {
    mountQueryBar(b({ hint: '_id_' }));
    await waitFor(() => expect(hintDialog('find.options')).not.toBeNull(), { timeout: 3000 });
    expect(document.querySelector('[data-hint-anchor="find.options"]')).toBe(
      screen.getByTestId('query-bar-collation').parentElement!.parentElement,
    );
  });

  it('stays hidden when neither collation nor hint is set', async () => {
    mountQueryBar(b({ sort: '{"a":1}' }));
    await screen.findByTestId('query-bar-collation');
    await settle();
    expect(hintDialog('find.options')).toBeNull();
  });

  it('follows the builder: appears once a collation is typed, goes when it is cleared', async () => {
    mountQueryBar(b({ sort: '{"a":1}' }));
    const collation = await screen.findByTestId('query-bar-collation');
    await settle();
    fireEvent.change(collation, { target: { value: '{"locale":"en"}' } });
    await waitFor(() => expect(hintDialog('find.options')).not.toBeNull(), { timeout: 3000 });
    fireEvent.change(collation, { target: { value: '' } });
    await waitFor(() => expect(hintDialog('find.options')).toBeNull());
  });

  it('is hidden after dismiss and the dismissal is persisted', async () => {
    const prefs = mountQueryBar(b({ collation: '{"locale":"en"}' }));
    await expectDismissible('find.options', prefs);
  });
});
