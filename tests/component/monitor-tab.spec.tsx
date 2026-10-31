import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor, within } from '../helpers/render';
import { modals } from '@mantine/modals';
import { MonitorTab } from '../../src/pages/MonitorTab';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { ConnectionRuntime, ConnectionSummary, CurrentOpSummary } from '@shared/types';

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
const connected: ConnectionRuntime = { id: 'c1', status: 'connected' };

const op: CurrentOpSummary = {
  opid: '4242',
  op: 'query',
  ns: 'shop.orders',
  secsRunning: 12,
  client: '127.0.0.1:5000',
  planSummary: 'COLLSCAN',
  command: '{"find":"orders"}',
};

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

afterEach(() => {
  modals.closeAll();
  uninstallAtelierMock();
  vi.useRealTimers();
  vi.restoreAllMocks();
  setVisibility('visible');
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const twoDbs = async () => [
  { name: 'shop', sizeOnDisk: 0, empty: false },
  { name: 'logs', sizeOnDisk: 0, empty: false },
];

describe('MonitorTab', () => {
  it('shows the Not connected text when disconnected and calls nothing', () => {
    const currentOp = vi.fn(async () => ({ ops: [] }));
    installAtelierMock({ admin: { currentOp } });
    render(<MonitorTab conn={conn} runtime={{ id: 'c1', status: 'disconnected' }} />);
    expect(screen.getByText('Not connected. Open the Overview tab to connect.')).toBeTruthy();
    expect(currentOp).not.toHaveBeenCalled();
  });

  it('renders ops from currentOp and expands the command as text', async () => {
    installAtelierMock({ admin: { currentOp: async () => ({ ops: [op] }) } });
    render(<MonitorTab conn={conn} runtime={connected} />);
    const ops = screen.getByRole('region', { name: 'Current operations' });
    expect(await within(ops).findByText('shop.orders')).toBeTruthy();
    expect(within(ops).getByText('COLLSCAN')).toBeTruthy();
    expect(within(ops).getByText('127.0.0.1:5000')).toBeTruthy();

    const toggle = within(ops).getByRole('button', { expanded: false });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(within(ops).getByText('{"find":"orders"}')).toBeTruthy();
  });

  it('asks before killing, and kills only once confirmed', async () => {
    const killOp = vi.fn(async () => ({ ok: true as const }));
    installAtelierMock({ admin: { currentOp: async () => ({ ops: [op] }), killOp } });
    render(<MonitorTab conn={conn} runtime={connected} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Kill operation 4242' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Kill operation 4242?');
    expect(dialog.textContent).toContain('query on shop.orders, running 12s');
    expect(killOp).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Kill' }));
    await waitFor(() => expect(killOp).toHaveBeenCalledWith({ connectionId: 'c1', opid: '4242' }));
  });

  it('cancelling the confirm does not kill', async () => {
    const killOp = vi.fn(async () => ({ ok: true as const }));
    installAtelierMock({ admin: { currentOp: async () => ({ ops: [op] }), killOp } });
    render(<MonitorTab conn={conn} runtime={connected} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Kill operation 4242' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(killOp).not.toHaveBeenCalled();
  });

  it('a read-only connection disables Kill and every profiler control, and says why', async () => {
    installAtelierMock({ admin: { currentOp: async () => ({ ops: [op] }) } });
    render(<MonitorTab conn={{ ...conn, readOnly: true }} runtime={connected} />);
    const kill = await screen.findByRole('button', { name: 'Kill operation 4242' });
    const apply = screen.getByRole('button', { name: 'Apply' });
    const slowms = screen.getByLabelText('slowms');
    const levels = within(screen.getByRole('region', { name: 'Profiler' })).getAllByRole('radio');
    expect(levels).toHaveLength(3);
    for (const el of [kill, apply, slowms, ...levels]) {
      expect((el as HTMLButtonElement | HTMLInputElement).disabled).toBe(true);
    }
    // The reason is visible text the disabled controls point at.
    const note = screen.getByText(/Read-only connection: killing operations and changing the profiler are disabled/);
    for (const el of [kill, apply, slowms]) {
      expect(el.getAttribute('aria-describedby')).toBe(note.id);
    }
  });

  it('a writable connection enables the level control and shows no read-only note', async () => {
    installAtelierMock({ admin: { currentOp: async () => ({ ops: [op] }) } });
    render(<MonitorTab conn={conn} runtime={connected} />);
    await screen.findByRole('button', { name: 'Kill operation 4242' });
    const levels = within(screen.getByRole('region', { name: 'Profiler' })).getAllByRole('radio');
    for (const el of levels) expect((el as HTMLInputElement).disabled).toBe(false);
    expect(screen.queryByText(/Read-only connection/)).toBeNull();
  });

  it('clicking Kill neither toggles the row nor reaches a parent click handler', async () => {
    const parentClick = vi.fn();
    installAtelierMock({ admin: { currentOp: async () => ({ ops: [op] }) } });
    render(
      <div onClick={parentClick}>
        <MonitorTab conn={conn} runtime={connected} />
      </div>,
    );
    const ops = screen.getByRole('region', { name: 'Current operations' });
    fireEvent.click(await within(ops).findByRole('button', { name: 'Kill operation 4242' }));
    expect(within(ops).getByRole('button', { expanded: false })).toBeTruthy();
    expect(parentClick).not.toHaveBeenCalled();
  });

  it('a row without an opid shows no Kill and keys without warnings', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const noOpid: CurrentOpSummary = { op: 'none', desc: 'idle', command: '{}' };
    installAtelierMock({ admin: { currentOp: async () => ({ ops: [noOpid, { ...noOpid, desc: 'idle2' }, op] }) } });
    render(<MonitorTab conn={conn} runtime={connected} />);
    const table = await screen.findByRole('table', { name: 'Running operations' });
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    expect(within(table).getAllByRole('button', { name: /^Kill/ })).toHaveLength(1);
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toContain('Actions');
    expect(consoleError.mock.calls.flat().join(' ')).not.toMatch(/key/i);
    // Expanding one opid-less row expands that row only.
    fireEvent.click(within(table).getAllByRole('button', { expanded: false })[0]!);
    expect(within(table).getAllByRole('button', { expanded: true })).toHaveLength(1);
  });

  it('skips an interval tick while the previous request is still pending', async () => {
    vi.useFakeTimers();
    setVisibility('visible');
    let release: () => void = () => {};
    const currentOp = vi.fn(
      () => new Promise<{ ops: CurrentOpSummary[] }>((resolve) => {
        release = () => resolve({ ops: [] });
      }),
    );
    installAtelierMock({ admin: { currentOp } });
    render(<MonitorTab conn={conn} runtime={connected} />);
    await act(async () => {});
    expect(currentOp).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(currentOp).toHaveBeenCalledTimes(1);

    await act(async () => { release(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(currentOp).toHaveBeenCalledTimes(2);
  });

  it('polls every 5s while visible, skips while hidden, and stops on Pause', async () => {
    vi.useFakeTimers();
    setVisibility('visible');
    const currentOp = vi.fn(async () => ({ ops: [] }));
    installAtelierMock({ admin: { currentOp } });
    render(<MonitorTab conn={conn} runtime={connected} />);
    await act(async () => {});
    expect(currentOp).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(currentOp).toHaveBeenCalledTimes(2);

    setVisibility('hidden');
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(currentOp).toHaveBeenCalledTimes(2);

    setVisibility('visible');
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(currentOp).toHaveBeenCalledTimes(3);

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(currentOp).toHaveBeenCalledTimes(3);
    expect(screen.getByText('Paused')).toBeTruthy();
  });

  it('sends the filters: active only by default, and the minimum seconds once typed', async () => {
    const currentOp = vi.fn(async () => ({ ops: [] }));
    installAtelierMock({ admin: { currentOp } });
    render(<MonitorTab conn={conn} runtime={connected} />);
    await waitFor(() =>
      expect(currentOp).toHaveBeenLastCalledWith({ connectionId: 'c1', activeOnly: true }),
    );

    fireEvent.change(screen.getByLabelText('Minimum seconds running'), { target: { value: '3' } });
    await waitFor(() =>
      expect(currentOp).toHaveBeenLastCalledWith({ connectionId: 'c1', activeOnly: true, minSecsRunning: 3 }),
    );

    fireEvent.click(screen.getByLabelText('Active only'));
    await waitFor(() =>
      expect(currentOp).toHaveBeenLastCalledWith({ connectionId: 'c1', activeOnly: false, minSecsRunning: 3 }),
    );
  });

  it('typing the minimum seconds sends one request after a pause, not one per keystroke', async () => {
    vi.useFakeTimers();
    setVisibility('visible');
    const currentOp = vi.fn(async () => ({ ops: [] }));
    installAtelierMock({ admin: { currentOp } });
    render(<MonitorTab conn={conn} runtime={connected} />);
    await act(async () => {});
    expect(currentOp).toHaveBeenCalledTimes(1);

    const field = screen.getByLabelText('Minimum seconds running');
    for (const value of ['1', '12', '120']) {
      fireEvent.change(field, { target: { value } });
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    }
    expect(currentOp).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(currentOp).toHaveBeenCalledTimes(2);
    expect(currentOp).toHaveBeenLastCalledWith({ connectionId: 'c1', activeOnly: true, minSecsRunning: 120 });
  });

  it('profiler: shows the level, reads canonical EJSON rows, and applies a new level', async () => {
    const setProfileLevel = vi.fn(async () => ({ ok: true as const }));
    installAtelierMock({
      meta: { listDatabases: async () => [{ name: 'shop', sizeOnDisk: 0, empty: false }] },
      admin: {
        profileStatus: async () => ({ level: 1 as const, slowms: 20 }),
        setProfileLevel,
        profileTail: async () => ({
          docs: [
            {
              op: 'query',
              ns: 'shop.orders',
              millis: { $numberInt: '37' },
              planSummary: 'IXSCAN { a: 1 }',
              ts: { $date: { $numberLong: '1760000000000' } },
            },
          ],
        }),
      },
    });
    render(<MonitorTab conn={conn} runtime={connected} />);
    const prof = screen.getByRole('region', { name: 'Profiler' });
    expect(await within(prof).findByText('Current: Slow, slowms 20')).toBeTruthy();
    expect(within(prof).getByText('37')).toBeTruthy();
    expect(within(prof).getByText('IXSCAN { a: 1 }')).toBeTruthy();
    expect(within(prof).getByText(new Date(1760000000000).toLocaleString())).toBeTruthy();

    fireEvent.click(within(prof).getByText('All'));
    fireEvent.click(within(prof).getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(setProfileLevel).toHaveBeenCalledWith({ connectionId: 'c1', dbName: 'shop', level: 2, slowms: 20 }),
    );
  });

  it('profiler: a late reply for a database no longer picked does not land', async () => {
    const shop = deferred<{ level: 0 | 1 | 2; slowms: number }>();
    installAtelierMock({
      meta: { listDatabases: twoDbs },
      admin: {
        profileStatus: ({ dbName }) =>
          dbName === 'shop' ? shop.promise : Promise.resolve({ level: 2 as const, slowms: 7 }),
      },
    });
    render(<MonitorTab conn={conn} runtime={connected} />);
    const prof = screen.getByRole('region', { name: 'Profiler' });
    await within(prof).findByRole('option', { name: 'logs' });
    fireEvent.change(within(prof).getByLabelText('Profiler database'), { target: { value: 'logs' } });
    expect(await within(prof).findByText('Current: All, slowms 7')).toBeTruthy();

    await act(async () => { shop.resolve({ level: 0, slowms: 100 }); });
    expect(within(prof).getByText('Current: All, slowms 7')).toBeTruthy();
    expect(within(prof).queryByText(/slowms 100/)).toBeNull();
  });

  it('profiler: a failed load clears the status and keeps Apply off', async () => {
    const setProfileLevel = vi.fn(async () => ({ ok: true as const }));
    installAtelierMock({
      meta: { listDatabases: twoDbs },
      admin: {
        profileStatus: async () => {
          throw { code: 'UNAUTHORIZED', message: 'not authorized on shop' };
        },
        setProfileLevel,
      },
    });
    render(<MonitorTab conn={conn} runtime={connected} />);
    const prof = screen.getByRole('region', { name: 'Profiler' });
    expect((await within(prof).findByRole('alert')).textContent).toContain('not authorized on shop');
    const apply = within(prof).getByRole('button', { name: 'Apply' }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    fireEvent.click(apply);
    expect(setProfileLevel).not.toHaveBeenCalled();
    expect(within(prof).queryByText(/^Current:/)).toBeNull();
  });

  it('profiler: re-picking the database already shown keeps its status and Apply', async () => {
    installAtelierMock({
      meta: { listDatabases: twoDbs },
      admin: { profileStatus: async () => ({ level: 0 as const, slowms: 100 }) },
    });
    render(<MonitorTab conn={conn} runtime={connected} />);
    const prof = screen.getByRole('region', { name: 'Profiler' });
    expect(await within(prof).findByText('Current: Off, slowms 100')).toBeTruthy();
    // A select fires change even for the value it already holds (Playwright's selectOption does).
    fireEvent.change(within(prof).getByLabelText('Profiler database'), { target: { value: 'shop' } });
    expect(within(prof).getByText('Current: Off, slowms 100')).toBeTruthy();
    expect((within(prof).getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(false);
  });
  it('profiler: Apply on one database, then picking another, never shows or sends the first one\'s values', async () => {
    const applyShop = deferred<{ ok: true }>();
    const setProfileLevel = vi.fn(({ dbName }: { dbName: string }) =>
      dbName === 'shop' ? applyShop.promise : Promise.resolve({ ok: true as const }),
    );
    installAtelierMock({
      meta: { listDatabases: twoDbs },
      admin: {
        profileStatus: async ({ dbName }) =>
          dbName === 'shop' ? { level: 1 as const, slowms: 100 } : { level: 2 as const, slowms: 7 },
        setProfileLevel,
      },
    });
    render(<MonitorTab conn={conn} runtime={connected} />);
    const prof = screen.getByRole('region', { name: 'Profiler' });
    expect(await within(prof).findByText('Current: Slow, slowms 100')).toBeTruthy();
    fireEvent.click(within(prof).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(setProfileLevel).toHaveBeenCalledTimes(1));

    fireEvent.change(within(prof).getByLabelText('Profiler database'), { target: { value: 'logs' } });
    expect(await within(prof).findByText('Current: All, slowms 7')).toBeTruthy();

    await act(async () => { applyShop.resolve({ ok: true }); });
    expect(within(prof).getByText('Current: All, slowms 7')).toBeTruthy();
    expect((within(prof).getByLabelText('slowms') as HTMLInputElement).value).toBe('7');

    fireEvent.click(within(prof).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(setProfileLevel).toHaveBeenCalledTimes(2));
    expect(setProfileLevel).toHaveBeenLastCalledWith({ connectionId: 'c1', dbName: 'logs', level: 2, slowms: 7 });
  });
});
