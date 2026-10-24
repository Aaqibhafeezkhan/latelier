import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
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
import { QueryBar } from '../../src/pages/Workspace/QueryBar';
import { CollectionWorkspaceProvider } from '../../src/pages/Workspace/CollectionWorkspaceProvider';
import Workspace from '../../src/pages/Workspace';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { BuilderState, CollectionTab, CollectionTabState } from '@shared/types';
import type { IpcApi } from '@shared/ipc';

/**
 * W14 §9 — the advanced region's options row: collation, hint, maxTimeMS and
 * readPreference. The bar is rendered under a wrapper that holds real state
 * and merges each patch, so what the row shows is what a patch round-trip
 * produced, not the fixture it started from.
 */

const b = (over: Partial<BuilderState> = {}): BuilderState => ({ projection: [], sort: '', limit: '', ...over });

function Harness({ initial, onState }: { initial: BuilderState; onState: (s: CollectionTabState) => void }) {
  const [state, setState] = React.useState<CollectionTabState>({
    view: 'Tree',
    builder: initial,
    queryRaw: '{}',
    page: 0,
    pageSize: 50,
    activeBuilderTab: 'Builder',
  });
  onState(state);
  const actions = React.useMemo(
    () =>
      emptyWorkspaceActions({
        patch: (p) => setState((s) => ({ ...s, ...p })),
      }),
    [],
  );
  return (
    <CollectionWorkspaceProvider state={state} actions={actions} meta={emptyWorkspaceMeta()}>
      <QueryBar suggestionContext={null} />
    </CollectionWorkspaceProvider>
  );
}

function mountBar(initial: BuilderState) {
  let latest: CollectionTabState | undefined;
  const r = render(<Harness initial={initial} onState={(s) => (latest = s)} />);
  return { ...r, builder: () => latest!.builder };
}

const runDisabled = () => screen.getByTestId<HTMLButtonElement>('query-run-btn').disabled;

const trigger = (container: HTMLElement) =>
  container.querySelector('[aria-controls="query-bar-advanced"]') as HTMLElement;

describe('QueryBar options row', () => {
  it('names each option off its visible label cell', () => {
    mountBar(b({ hint: '_id_' }));
    expect(screen.getByLabelText('collation')).toBe(screen.getByTestId('query-bar-collation'));
    expect(screen.getByLabelText('hint')).toBe(screen.getByTestId('query-bar-hint'));
    expect(screen.getByLabelText('maxTimeMS')).toBe(screen.getByTestId('query-bar-maxtime'));
    expect(screen.getByLabelText('read pref')).toBe(screen.getByTestId('query-bar-readpref'));
  });

  it('opens with the advanced row when only an option is set, and patches the builder', () => {
    const { builder } = mountBar(b({ collation: '{"locale":"en"}' }));
    expect(screen.getByTestId<HTMLInputElement>('query-bar-collation').value).toBe('{"locale":"en"}');

    fireEvent.change(screen.getByTestId('query-bar-hint'), { target: { value: 'name_1' } });
    fireEvent.change(screen.getByTestId('query-bar-maxtime'), { target: { value: '500' } });
    fireEvent.change(screen.getByTestId('query-bar-readpref'), { target: { value: 'nearest' } });
    fireEvent.change(screen.getByTestId('query-bar-collation'), { target: { value: '' } });

    expect(builder()).toEqual(
      b({ collation: '', hint: 'name_1', maxTimeMS: '500', readPreference: 'nearest' }),
    );
    expect(screen.getByTestId<HTMLSelectElement>('query-bar-readpref').value).toBe('nearest');
  });

  it('lists the connection default and every read preference mode', () => {
    mountBar(b({ hint: '_id_' }));
    const options = within(screen.getByTestId('query-bar-readpref'))
      .getAllByRole('option')
      .map((o) => (o as HTMLOptionElement).value);
    expect(options).toEqual(['', 'primary', 'primaryPreferred', 'secondary', 'secondaryPreferred', 'nearest']);
  });

  it('an unparseable collation raises its notice and disables Run', () => {
    mountBar(b());
    fireEvent.click(trigger(document.body));
    expect(runDisabled()).toBe(false);

    fireEvent.change(screen.getByTestId('query-bar-collation'), { target: { value: '{"locale":' } });
    const input = screen.getByTestId('query-bar-collation');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe('query-bar-collation-error');
    expect(document.getElementById('query-bar-collation-error')?.textContent).toMatch(/Can't parse this collation/);
    expect(runDisabled()).toBe(true);
  });

  it('names a bad hint key pattern, maxTimeMS and a restored read preference', () => {
    mountBar(b({ hint: '{"a":', maxTimeMS: '0', readPreference: 'secondaryOnly' }));
    expect(document.getElementById('query-bar-hint-error')?.textContent).toMatch(/Can't parse this hint/);
    expect(document.getElementById('query-bar-maxtime-error')?.textContent).toMatch(/whole number/);
    expect(document.getElementById('query-bar-readpref-error')?.textContent).toMatch(/"secondaryOnly" is not a read preference/);
    // The restored value stays the selected one, so the notice names what is shown.
    expect(screen.getByTestId<HTMLSelectElement>('query-bar-readpref').value).toBe('secondaryOnly');
  });

  it('says a maxTimeMS over the cap runs at 30000, without blocking Run', () => {
    mountBar(b({ maxTimeMS: '40000' }));
    expect(screen.getByTestId('query-bar-maxtime').getAttribute('placeholder')).toBe('max 30000');
    expect(document.getElementById('query-bar-maxtime-error')?.textContent).toMatch(
      'Running with maxTimeMS 30000, the most a query may run.',
    );
    expect(screen.getByTestId('query-bar-maxtime').getAttribute('aria-invalid')).toBe('false');
    expect(runDisabled()).toBe(false);
  });

  it('counts set options and their errors on the collapsed trigger', () => {
    const { container } = mountBar(b({ sort: '{"a":1}', collation: '{"locale":"en"}', hint: '{' }));
    fireEvent.click(trigger(container));
    expect(within(trigger(container)).getByText(/set/).textContent).toBe('3 set · 1 error');
  });
});

/** Through the real Workspace: what Run sends once the options are on the tab. */
describe('QueryBar options reach the query channels', () => {
  const now = '2026-10-22T12:00:00.000Z';
  const tab = (builder: BuilderState): CollectionTab => ({
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
      builder,
      queryRaw: '{}',
      page: 0,
      pageSize: 50,
      activeBuilderTab: 'Builder',
      lastRun: { documents: [], durationMs: 0, ranAt: now },
    },
  });

  afterEach(() => {
    uninstallAtelierMock();
    vi.restoreAllMocks();
  });

  async function runWith(builder: BuilderState) {
    const find = vi.fn<IpcApi['query']['find']>(async () => ({ documents: [], durationMs: 1, hasMore: false }));
    const count = vi.fn<IpcApi['query']['count']>(async () => ({ count: 0 }));
    const explain = vi.fn<IpcApi['query']['explain']>(async () => ({ plan: {}, verbosity: 'queryPlanner' }));
    installAtelierMock({
      tabs: {
        list: async () => [tab(builder)],
        setActive: async (id) => ({ id }),
        update: async () => tab(builder),
      },
      conn: {
        list: async () => [
          {
            id: 'c1',
            name: 'Local',
            color: '#1A6835',
            host: 'localhost',
            port: 27017,
            connectionType: 'standard',
            readOnly: false,
            status: 'connected',
          },
        ],
      },
      query: { find, count, explain },
    });
    render(
      <MemoryRouter initialEntries={['/workspace']}>
        <Workspace />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByTestId('query-run-btn'));
    await waitFor(() => expect(count).toHaveBeenCalled());
    return { find, count, explain };
  }

  it('find gets all four options; count and explain get the ones that decide the match', async () => {
    const { find, count, explain } = await runWith(
      b({
        collation: '{"locale":"en","strength":2}',
        hint: '_id_',
        maxTimeMS: '500',
        readPreference: 'secondaryPreferred',
      }),
    );
    const match = { collation: '{"locale":"en","strength":2}', hint: '_id_', readPreference: 'secondaryPreferred' };
    expect(find.mock.calls[0]![0]).toMatchObject({ ...match, maxTimeMS: 500 });
    expect(count.mock.calls[0]![0]).toMatchObject(match);
    expect(count.mock.calls[0]![0]).not.toHaveProperty('maxTimeMS');
    await waitFor(() => expect(explain).toHaveBeenCalled());
    expect(explain.mock.calls[0]![0]).toMatchObject(match);
  });

  // X14 — Shell Syntax runs as typed, and a quoted index name runs as the name.
  it('a Shell Syntax collation and a quoted hint run, sent as EJSON and the bare name', async () => {
    const { find, count } = await runWith(b({ collation: "{locale: 'en', strength: 2}", hint: '"_id_"' }));
    expect(screen.queryByRole('alert')).toBeNull();
    const match = { collation: '{"locale": "en", "strength": 2}', hint: '_id_' };
    expect(find.mock.calls[0]![0]).toMatchObject(match);
    expect(count.mock.calls[0]![0]).toMatchObject(match);
  });
});
