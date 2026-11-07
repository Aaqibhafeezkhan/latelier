import { describe, it, expect, afterEach, vi } from 'vitest';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor, emptyWorkspaceActions, emptyWorkspaceMeta } from '../helpers/render';
import { installAtelierMock, multiConnectionMock, uninstallAtelierMock } from '../helpers/atelierMock';
import Workspace from '../../src/pages/Workspace';
import { ResultViewer } from '../../src/pages/Workspace/ResultViewer';
import { CollectionWorkspaceProvider } from '../../src/pages/Workspace/CollectionWorkspaceProvider';
import type { CollectionWorkspaceMeta } from '../../src/pages/Workspace/context';
import type { CollectionTabState, LastRun } from '@shared/types';

const noop = () => {};
const builder = { projection: [], sort: '', limit: '' };

function makeState(overrides: Partial<CollectionTabState> = {}): CollectionTabState {
  return {
    view: 'Tree',
    builder,
    queryRaw: '{}',
    page: 0,
    pageSize: 50,
    activeBuilderTab: 'Builder',
    ...overrides,
  };
}

const lastRun = (overrides: Partial<LastRun> = {}): LastRun => ({
  documents: [],
  durationMs: 0,
  ranAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const REFUSED = { code: 'VALIDATION', message: 'unknown top level operator: $badOp' };

/**
 * Holds the state for real and merges each patch back, because a revert only
 * shows once the patch has round-tripped into props. `run` stands in for the
 * runner: a good query comes back with rows.
 */
function Stateful({
  initial,
  onRun,
  onClearFilter = noop,
  onQueryReplaced,
  meta,
}: {
  initial: CollectionTabState;
  onRun?: (override?: Partial<CollectionTabState>) => void;
  onClearFilter?: () => void;
  onQueryReplaced?: () => void;
  meta?: Partial<CollectionWorkspaceMeta>;
}) {
  const [state, setState] = useState(initial);
  const actions = emptyWorkspaceActions({
    patch: (p) => setState((s) => ({ ...s, ...p })),
    run: (override) => {
      onRun?.(override);
      setState((s) => ({ ...s, ...override, lastRun: lastRun({ documents: [{ _id: 'back', name: 'recovered' }] }) }));
    },
  });
  return (
    <CollectionWorkspaceProvider state={state} actions={actions} meta={emptyWorkspaceMeta(meta)}>
      <ResultViewer>
        <span data-testid="query-text">{state.queryRaw}</span>
        <ResultViewer.Body
          onClearFilter={onClearFilter}
          onColumnResize={noop}
          onRowExpand={noop}
          onQueryReplaced={onQueryReplaced}
        />
      </ResultViewer>
    </CollectionWorkspaceProvider>
  );
}

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

describe('one pane state for everything that is not rows', () => {
  it('a filter with no match says so and offers clearing it', async () => {
    const onClearFilter = vi.fn();
    render(<Stateful initial={makeState({ queryRaw: '{"n":9}', lastRun: lastRun() })} onClearFilter={onClearFilter} />);

    expect(screen.getByTestId('pane-state').textContent).toContain('No matching documents');
    await userEvent.click(screen.getByRole('button', { name: 'Clear filter' }));
    expect(onClearFilter).toHaveBeenCalledTimes(1);
  });

  it('an empty collection offers an import, and a view that takes no writes a re-run', () => {
    const { unmount } = render(<Stateful initial={makeState({ lastRun: lastRun() })} />);
    expect(screen.getByTestId('pane-state').textContent).toContain('This collection is empty');
    expect(screen.getByRole('button', { name: /import documents/i })).toBeTruthy();
    unmount();

    render(<Stateful initial={makeState({ lastRun: lastRun() })} meta={{ isView: true }} />);
    expect(screen.queryByRole('button', { name: /import documents/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Run again' })).toBeTruthy();
  });

  it('a query not yet run offers running it', async () => {
    const onRun = vi.fn();
    render(<Stateful initial={makeState({ queryRaw: '{"n":9}' })} onRun={onRun} />);

    expect(screen.getByTestId('pane-state').textContent).toContain('Run the query');
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it('a failure that is not the query shows the error and offers running it again, not a revert', () => {
    render(
      <Stateful
        initial={makeState({
          queryRaw: '{"n":9}',
          lastRun: lastRun({ error: { code: 'NETWORK', message: 'socket hang up' } }),
          lastValidQuery: { queryRaw: '{}', builder },
        })}
      />,
    );

    expect(screen.getByRole('alert').textContent).toContain('NETWORK: socket hang up');
    expect(screen.getByRole('button', { name: 'Run again' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /revert/i })).toBeNull();
  });
});

describe('a query the server refused', () => {
  const failing = (overrides: Partial<CollectionTabState> = {}) =>
    makeState({ queryRaw: '{"$badOp":1}', lastRun: lastRun({ error: REFUSED }), ...overrides });

  it('replaces the results with the whole error', () => {
    render(<Stateful initial={failing()} />);

    expect(screen.getByRole('alert').textContent).toContain(`${REFUSED.code}: ${REFUSED.message}`);
    expect(screen.queryByText('recovered')).toBeNull();
  });

  it('Revert restores the last valid query, runs it, and reports the wholesale load', async () => {
    const onRun = vi.fn();
    const onQueryReplaced = vi.fn();
    const last = { queryRaw: '{"n":1}', builder: { ...builder, sort: '{"n":1}' } };
    render(<Stateful initial={failing({ lastValidQuery: last })} onRun={onRun} onQueryReplaced={onQueryReplaced} />);

    await userEvent.click(screen.getByRole('button', { name: 'Revert to last valid query' }));

    expect(onRun).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(last));
    expect(onQueryReplaced).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('query-text').textContent).toBe('{"n":1}');
    await waitFor(() => expect(screen.queryByTestId('pane-state')).toBeNull());
    expect(screen.getByText(/recovered/)).toBeTruthy();
  });

  it('with no valid query yet, offers no revert: clearing the filter instead', () => {
    render(<Stateful initial={failing()} />);

    expect(screen.queryByRole('button', { name: /revert/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Clear filter' })).toBeTruthy();
  });

  it('with nothing to clear either, offers running it again', () => {
    render(
      <Stateful
        initial={makeState({ builder: { ...builder, hint: 'gone_1' }, lastRun: lastRun({ error: REFUSED }) })}
      />,
    );

    expect(screen.queryByRole('button', { name: /revert/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear filter' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Run again' })).toBeTruthy();
  });

  it('is not dimmed when the box then holds text that cannot run', () => {
    const { container } = render(<Stateful initial={failing({ queryRaw: '{ bad:' })} />);
    expect(container.querySelector('[data-stale]')).toBeNull();
  });
});

describe('text that cannot parse', () => {
  it('keeps the rows, dimmed', () => {
    const { container } = render(
      <Stateful initial={makeState({ queryRaw: '{ bad:', lastRun: lastRun({ documents: [{ _id: 1, name: 'still here' }] }) })} />,
    );

    expect(container.querySelector('[data-stale="true"]')).not.toBeNull();
    expect(screen.getByText(/still here/)).toBeTruthy();
    expect(screen.queryByTestId('pane-state')).toBeNull();
  });
});

describe('the fixed band', () => {
  function renderBand(
    state: CollectionTabState,
    meta: Partial<CollectionWorkspaceMeta> = {},
    connectionLost?: { reason: string; reconnecting: boolean; onReconnect: () => void },
    cancel = vi.fn(),
  ) {
    render(
      <CollectionWorkspaceProvider state={state} actions={emptyWorkspaceActions({ cancel })} meta={emptyWorkspaceMeta(meta)}>
        <ResultViewer>
          <ResultViewer.SelectionBar onDeleteSelected={noop} connectionLost={connectionLost} />
        </ResultViewer>
      </CollectionWorkspaceProvider>,
    );
    return { band: screen.getByTestId('selection-bar'), cancel };
  }
  const withRows = makeState({ lastRun: lastRun({ documents: [{ _id: 1 }] }) });

  it('keeps one fixed height whoever holds it', () => {
    const { band } = renderBand(withRows);
    expect(band.style.height).toBe('31px');
  });

  it('says a re-run is running and offers Cancel', async () => {
    const { band, cancel } = renderBand(withRows, { isLoading: true });
    expect(band.style.height).toBe('31px');
    expect(screen.getByRole('status').textContent).toBe('Running…');

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('stays empty on a first load, where the placeholders say it', () => {
    renderBand(makeState(), { isLoading: true });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('gives a lost connection its reason and a way back, ahead of a running find', async () => {
    const onReconnect = vi.fn();
    const { band } = renderBand(
      withRows,
      { isLoading: true },
      { reason: 'connect ECONNREFUSED 10.0.0.1:27017', reconnecting: false, onReconnect },
    );
    expect(band.style.height).toBe('31px');
    expect(screen.getByRole('status').textContent).toContain('connect ECONNREFUSED 10.0.0.1:27017');

    await userEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it('holds Reconnect still while reconnecting', () => {
    renderBand(withRows, {}, { reason: 'gone', reconnecting: true, onReconnect: noop });
    expect((screen.getByRole('button', { name: 'Reconnecting…' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('the pane says what happened to the connection', () => {
  function mountWorkspace(opts: {
    status: 'error' | 'disconnected' | 'connecting';
    tabs?: boolean;
    errorMessage?: string;
    errorCode?: 'KEYCHAIN_BLOCKED' | 'NETWORK';
    lostReason?: string;
  }) {
    const connect = vi.fn(async (id: string) => ({ id, status: 'connecting' as const }));
    installAtelierMock({
      ...multiConnectionMock({
        connections: [{ id: 'c1', name: 'Prod', status: opts.status, lostReason: opts.lostReason }],
        tabs: opts.tabs === false
          ? []
          : [{ id: 't1', connectionId: 'c1', dbName: 'shop', collection: 'orders', isActive: true }],
      }),
      mongo: {
        connect,
        status: async (id: string) => ({
          id,
          status: opts.status,
          errorMessage: opts.errorMessage,
          errorCode: opts.errorCode,
        }),
      },
    });
    render(
      <MemoryRouter initialEntries={['/workspace']}>
        <Workspace />
      </MemoryRouter>,
    );
    return { connect };
  }

  it('a failed connect shows the real error in the pane, with Retry', async () => {
    const { connect } = mountWorkspace({ status: 'error', errorMessage: 'connect ECONNREFUSED 127.0.0.1:1' });

    await waitFor(() => expect(screen.getByTestId('pane-state').textContent).toContain('connect ECONNREFUSED 127.0.0.1:1'));
    expect(screen.getByTestId('pane-state').textContent).toContain('Could not connect to Prod');

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(connect).toHaveBeenCalledWith('c1'));
  });

  it('with no tabs open either, the pane shows it rather than asking for a connection', async () => {
    mountWorkspace({ status: 'error', tabs: false, errorMessage: 'connect ECONNREFUSED 127.0.0.1:1' });

    await waitFor(() => expect(screen.getByTestId('pane-state').textContent).toContain('connect ECONNREFUSED 127.0.0.1:1'));
    expect(screen.queryByText(/No connection is open/)).toBeNull();
  });

  it('offers no Retry for a denied keychain, which only a relaunch can fix', async () => {
    mountWorkspace({ status: 'error', errorMessage: 'macOS blocked access', errorCode: 'KEYCHAIN_BLOCKED' });

    await waitFor(() => expect(screen.getByTestId('pane-state').textContent).toContain('macOS blocked access'));
    expect(screen.getByTestId('pane-state').querySelector('button')).toBeNull();
  });

  it('a connection lost with no rows on screen gives its reason in the pane', async () => {
    mountWorkspace({ status: 'disconnected', lostReason: 'connect ECONNREFUSED 10.0.0.1:27017' });

    await waitFor(() => expect(screen.getByTestId('pane-state').textContent).toContain('was lost'));
    expect(screen.getByTestId('pane-state').textContent).toContain('connect ECONNREFUSED 10.0.0.1:27017');
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy();
  });

  it('says it is connecting while it is', async () => {
    mountWorkspace({ status: 'connecting' });
    await waitFor(() => expect(screen.getByTestId('pane-state').textContent).toContain('Connecting to Prod'));
  });
});
