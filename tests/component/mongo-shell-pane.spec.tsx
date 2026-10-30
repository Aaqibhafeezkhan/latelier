import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from '@testing-library/react';
import { render, screen, waitFor, fireEvent } from '../helpers/render';
import { MongoShellPane } from '../../src/pages/Workspace/MongoShellPane';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { IpcApi } from '@shared/ipc';
import type { ShellOutputEvent, ShellSessionInfo } from '@shared/types';

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

function paneElement(dbName?: string) {
  return (
    <MongoShellPane
      connectionId="c1"
      connectionName="Local"
      height={260}
      dbName={dbName}
      onClose={() => {}}
    />
  );
}

function mount(dbName?: string) {
  return render(paneElement(dbName));
}

describe('MongoShellPane', () => {
  it('starts a session on mount and posts user input through mshell.write', async () => {
    const writeSpy = vi.fn(async () => undefined);
    installAtelierMock({
      mshell: {
        start: async (): Promise<ShellSessionInfo> => ({
          sessionId: 's1',
          connectionId: 'c1',
          startedAt: new Date().toISOString(),
        }),
        write: writeSpy,
        stop: async () => undefined,
        list: async () => [],
        onOutput: () => () => {},
      },
    });

    mount();
    const input = await screen.findByLabelText('Mongo shell input');
    await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false));

    fireEvent.change(input, { target: { value: 'db.runCommand({ ping: 1 })' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(writeSpy).toHaveBeenCalledWith({
        sessionId: 's1',
        data: 'db.runCommand({ ping: 1 })\n',
      });
    });
  });

  describe('the database the shell opens on', () => {
    function installStartSpy() {
      const startSpy = vi.fn<IpcApi['mshell']['start']>(
        async (): Promise<ShellSessionInfo> => ({
          sessionId: 's1',
          connectionId: 'c1',
          startedAt: new Date().toISOString(),
        }),
      );
      installAtelierMock({
        mshell: {
          start: startSpy,
          write: async () => undefined,
          stop: async () => undefined,
          list: async () => [],
          onOutput: () => () => {},
        },
      });
      return startSpy;
    }

    it('passes the focused tab database to mshell.start', async () => {
      const startSpy = installStartSpy();
      mount('shop');
      await waitFor(() => expect(startSpy).toHaveBeenCalledTimes(1));
      expect(startSpy).toHaveBeenCalledWith({ connectionId: 'c1', dbName: 'shop' });
    });

    it('leaves dbName out when there is no focused tab database', async () => {
      const startSpy = installStartSpy();
      mount();
      await waitFor(() => expect(startSpy).toHaveBeenCalledTimes(1));
      expect(startSpy.mock.calls[0]![0]).toEqual({ connectionId: 'c1' });
    });

    it('does not restart when the focused tab changes, but Restart uses the new database', async () => {
      const startSpy = installStartSpy();
      const { rerender } = mount('shop');
      const input = await screen.findByLabelText('Mongo shell input');
      await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false));
      expect(startSpy).toHaveBeenCalledTimes(1);

      rerender(paneElement('billing'));
      // A tab switch must not tear the session (and its scrollback) down.
      await new Promise((r) => setTimeout(r, 20));
      expect(startSpy).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
      await waitFor(() => expect(startSpy).toHaveBeenCalledTimes(2));
      expect(startSpy).toHaveBeenLastCalledWith({ connectionId: 'c1', dbName: 'billing' });
    });
  });

  it('renders streamed stdout in the output area', async () => {
    let outputCb: ((evt: ShellOutputEvent) => void) | null = null;
    installAtelierMock({
      mshell: {
        start: async (): Promise<ShellSessionInfo> => ({
          sessionId: 's1',
          connectionId: 'c1',
          startedAt: new Date().toISOString(),
        }),
        write: async () => undefined,
        stop: async () => undefined,
        list: async () => [],
        onOutput: (cb) => {
          outputCb = cb;
          return () => {
            outputCb = null;
          };
        },
      },
    });

    mount();
    await waitFor(() => expect(outputCb).toBeTruthy());

    outputCb!({ sessionId: 's1', kind: 'stdout', data: 'hello world\n' });

    const output = await screen.findByTestId('mongo-shell-output');
    await waitFor(() => expect(output.textContent).toContain('hello world'));
  });

  it('renders an error banner when start rejects', async () => {
    installAtelierMock({
      mshell: {
        start: async () => {
          throw { code: 'INTERNAL', message: 'connect failed' };
        },
        write: async () => undefined,
        stop: async () => undefined,
        list: async () => [],
        onOutput: () => () => {},
      },
    });

    mount();
    await waitFor(() => {
      expect(screen.getByTestId('mongo-shell-output').textContent).toMatch(
        /\[error\] connect failed/,
      );
    });
  });

  // ─── Performance regression guard ─────────────────────────────────────
  //
  // Each `stdout` event runs `setBuffer((prev) => prev + chunk)` and a
  // `useEffect` that reads `scrollHeight` + sets `scrollTop`. A regression
  // that drops the 200 KB cap on the buffer (or replaces the slice-from-front
  // with naive append) means a chatty shell session pegs renderer memory.
  // This test fires 1500 chunks rapidly and asserts the buffer respects the
  // cap and stays responsive.
  it('honours the 200 KB buffer cap under a burst of output events', async () => {
    let outputCb: ((evt: ShellOutputEvent) => void) | null = null;
    installAtelierMock({
      mshell: {
        start: async (): Promise<ShellSessionInfo> => ({
          sessionId: 's1',
          connectionId: 'c1',
          startedAt: new Date().toISOString(),
        }),
        write: async () => undefined,
        stop: async () => undefined,
        list: async () => [],
        onOutput: (cb) => {
          outputCb = cb;
          return () => {
            outputCb = null;
          };
        },
      },
    });

    mount();
    await waitFor(() => expect(outputCb).toBeTruthy());

    // 1500 chunks × 200 bytes = 300 KB total. The component is capped at
    // 200 KB; the oldest chunks must be discarded.
    const chunk = 'x'.repeat(200) + '\n';
    const totalChunks = 1500;
    const t0 = Date.now();
    for (let i = 0; i < totalChunks; i++) {
      outputCb!({ sessionId: 's1', kind: 'stdout', data: chunk });
    }
    const dispatchMs = Date.now() - t0;

    // Pure dispatch into the React state setter must stay snappy even
    // under a burst — well under 1 s for 1500 events.
    expect(dispatchMs).toBeLessThan(1000);

    // Wait for the final flush + the component to render the final buffer.
    const output = await screen.findByTestId('mongo-shell-output');
    await waitFor(() => {
      expect(output.textContent?.length ?? 0).toBeGreaterThan(0);
    });

    // The buffer in state has the cap applied; the rendered DOM may be a
    // touch larger because of any leading framing / status text the pane
    // adds. Assert the rendered text doesn't blow past the cap by a wide
    // margin — i.e., the slice-from-front is firing.
    const len = output.textContent?.length ?? 0;
    expect(len).toBeLessThan(220_000);
    expect(len).toBeGreaterThan(150_000);
  });

  // ─── Stick-to-bottom scrolling ─────────────────────────────────────────
  //
  // jsdom never lays out content, so scrollHeight/clientHeight/scrollTop are
  // all 0 by default. Stub them via Object.defineProperty on the output
  // <pre> to simulate a scrolled-up viewport before dispatching output.

  function stubScrollMetrics(el: HTMLElement, metrics: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: metrics.scrollHeight });
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: metrics.clientHeight });
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      writable: true,
      value: metrics.scrollTop,
    });
  }

  it('keeps following new output when the user was at the bottom', async () => {
    let outputCb: ((evt: ShellOutputEvent) => void) | null = null;
    installAtelierMock({
      mshell: {
        start: async (): Promise<ShellSessionInfo> => ({
          sessionId: 's1',
          connectionId: 'c1',
          startedAt: new Date().toISOString(),
        }),
        write: async () => undefined,
        stop: async () => undefined,
        list: async () => [],
        onOutput: (cb) => {
          outputCb = cb;
          return () => {
            outputCb = null;
          };
        },
      },
    });

    mount();
    await waitFor(() => expect(outputCb).toBeTruthy());

    const output = await screen.findByTestId('mongo-shell-output');
    // Simulate a viewport where the user is pinned to the bottom.
    stubScrollMetrics(output, { scrollHeight: 500, clientHeight: 200, scrollTop: 300 });
    fireEvent.scroll(output);

    // The next chunk grows scrollHeight; a pinned user should be scrolled
    // to follow it.
    stubScrollMetrics(output, { scrollHeight: 600, clientHeight: 200, scrollTop: 300 });
    outputCb!({ sessionId: 's1', kind: 'stdout', data: 'more output\n' });

    await waitFor(() => expect(output.textContent).toContain('more output'));
    // The follow-scroll runs in a passive effect, after the text is already in
    // the DOM, so a check made the moment the text appears can still read 300.
    await waitFor(() => expect(output.scrollTop).toBe(600));
  });

  it('leaves scrollTop unchanged when the user has scrolled up', async () => {
    let outputCb: ((evt: ShellOutputEvent) => void) | null = null;
    installAtelierMock({
      mshell: {
        start: async (): Promise<ShellSessionInfo> => ({
          sessionId: 's1',
          connectionId: 'c1',
          startedAt: new Date().toISOString(),
        }),
        write: async () => undefined,
        stop: async () => undefined,
        list: async () => [],
        onOutput: (cb) => {
          outputCb = cb;
          return () => {
            outputCb = null;
          };
        },
      },
    });

    mount();
    await waitFor(() => expect(outputCb).toBeTruthy());

    const output = await screen.findByTestId('mongo-shell-output');
    // Simulate the user having scrolled up, away from the bottom.
    stubScrollMetrics(output, { scrollHeight: 500, clientHeight: 200, scrollTop: 50 });
    fireEvent.scroll(output);

    outputCb!({ sessionId: 's1', kind: 'stdout', data: 'more output\n' });

    await waitFor(() => expect(output.textContent).toContain('more output'));
    // scrollTop must stay put — no forced jump to the bottom.
    expect(output.scrollTop).toBe(50);
  });

  it('re-pins to the bottom when the user submits a command while scrolled up', async () => {
    installAtelierMock({
      mshell: {
        start: async (): Promise<ShellSessionInfo> => ({
          sessionId: 's1',
          connectionId: 'c1',
          startedAt: new Date().toISOString(),
        }),
        write: async () => undefined,
        stop: async () => undefined,
        list: async () => [],
        onOutput: () => () => {},
      },
    });

    mount();
    const input = await screen.findByLabelText('Mongo shell input');
    await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false));

    const output = await screen.findByTestId('mongo-shell-output');
    // Simulate the user having scrolled up, away from the bottom.
    stubScrollMetrics(output, { scrollHeight: 500, clientHeight: 200, scrollTop: 50 });
    fireEvent.scroll(output);
    expect(output.scrollTop).toBe(50);

    // Submitting a command — even while scrolled up — must surface its
    // echo and output, like a real terminal.
    fireEvent.change(input, { target: { value: 'db.stats()' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(output.textContent).toContain('db.stats()'));
    expect(output.scrollTop).toBe(output.scrollHeight);
  });

  // ─── Busy shell, interrupt, stopped shell ─────────────────────────────

  function installDrivable(startResult?: () => Promise<ShellSessionInfo>) {
    // Each start is a new session, s1, s2, ...
    let started = 0;
    const nextSession = async (): Promise<ShellSessionInfo> => ({
      sessionId: `s${++started}`,
      connectionId: 'c1',
      startedAt: new Date().toISOString(),
    });
    let outputCb: ((evt: ShellOutputEvent) => void) | null = null;
    const mshell = {
      start: vi.fn<IpcApi['mshell']['start']>(startResult ?? nextSession),
      write: vi.fn<IpcApi['mshell']['write']>(async () => undefined),
      stop: vi.fn<IpcApi['mshell']['stop']>(async () => undefined),
      list: async () => [],
      onOutput: (cb: (evt: ShellOutputEvent) => void) => {
        outputCb = cb;
        return () => {
          outputCb = null;
        };
      },
    };
    const log = vi.fn<IpcApi['app']['log']>(async () => undefined);
    installAtelierMock({ mshell, app: { log } });
    return {
      mshell,
      log,
      push: (evt: ShellOutputEvent) => act(() => outputCb!(evt)),
    };
  }

  async function readyInput(): Promise<HTMLInputElement> {
    const input = (await screen.findByLabelText('Mongo shell input')) as HTMLInputElement;
    await waitFor(() => expect(input.disabled).toBe(false));
    return input;
  }

  function submit(input: HTMLInputElement, line: string) {
    fireEvent.change(input, { target: { value: line } });
    fireEvent.keyDown(input, { key: 'Enter' });
  }

  it('shows that a command is running from the moment it is sent until the shell is ready again', async () => {
    const { push } = installDrivable();
    mount();
    const input = await readyInput();
    expect(screen.queryByTestId('mongo-shell-busy')).toBeNull();

    submit(input, 'await db.big.find().toArray()');
    expect((await screen.findByTestId('mongo-shell-busy')).textContent).toContain('running');
    expect(screen.getByRole('button', { name: 'Interrupt' })).toBeTruthy();
    expect(input.placeholder).toBe('running… Ctrl+C to interrupt');

    await push({ sessionId: 's1', kind: 'prompt' });
    await waitFor(() => expect(screen.queryByTestId('mongo-shell-busy')).toBeNull());
    expect(screen.queryByRole('button', { name: 'Interrupt' })).toBeNull();
    expect(input.placeholder).toBe('');
  });

  it('stays busy until every line sent has come back with a prompt', async () => {
    const { push } = installDrivable();
    mount();
    const input = await readyInput();

    submit(input, 'a');
    submit(input, 'b');
    await push({ sessionId: 's1', kind: 'prompt' });
    expect(screen.getByTestId('mongo-shell-busy')).toBeTruthy();
    await push({ sessionId: 's1', kind: 'prompt' });
    await waitFor(() => expect(screen.queryByTestId('mongo-shell-busy')).toBeNull());
  });

  it('a line main refuses to send is not left running: the reason is printed instead', async () => {
    const { mshell } = installDrivable();
    mshell.write.mockRejectedValueOnce(new Error('This connection is read-only'));
    mount();
    const input = await readyInput();

    submit(input, 'db.x.drop()');

    expect(await screen.findByText(/could not send the command: This connection is read-only/)).toBeTruthy();
    expect(screen.queryByTestId('mongo-shell-busy')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Interrupt' })).toBeNull();
    expect(input.placeholder).toBe('');
  });

  it('keeps accepting input while a command runs', async () => {
    const { mshell } = installDrivable();
    mount();
    const input = await readyInput();

    submit(input, 'await db.slow.find().toArray()');
    await screen.findByTestId('mongo-shell-busy');
    expect(input.disabled).toBe(false);
    submit(input, '1+1');

    await waitFor(() =>
      expect(mshell.write).toHaveBeenLastCalledWith({ sessionId: 's1', data: '1+1\n' }),
    );
    expect(mshell.write).toHaveBeenCalledTimes(2);
  });

  it('Ctrl+C while a command runs stops the shell and starts a fresh one, keeping the scrollback', async () => {
    const { mshell, push } = installDrivable();
    // Stopping a session makes main announce its exit before the call returns.
    mshell.stop.mockImplementation(async ({ sessionId }) => {
      await push({ sessionId, kind: 'exit', exitCode: 0, signal: null });
    });
    mount();
    const input = await readyInput();
    await push({ sessionId: 's1', kind: 'stdout', data: 'earlier output\n' });

    submit(input, 'await new Promise(() => {})');
    await screen.findByTestId('mongo-shell-busy');
    expect(mshell.start).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(input, { key: 'c', ctrlKey: true });

    await waitFor(() => expect(mshell.stop).toHaveBeenCalledWith({ sessionId: 's1' }));
    await waitFor(() => expect(mshell.start).toHaveBeenCalledTimes(2));
    const stopOrder = mshell.stop.mock.invocationCallOrder[0]!;
    expect(stopOrder).toBeLessThan(mshell.start.mock.invocationCallOrder[1]!);

    await waitFor(() => expect(screen.queryByTestId('mongo-shell-busy')).toBeNull());
    const output = screen.getByTestId('mongo-shell-output');
    expect(output.textContent).toContain('earlier output');
    expect(output.textContent).toContain('interrupted');
    expect(output.textContent).toContain('variables were lost');
    // The old session's goodbye must not read as the new shell ending.
    expect(output.textContent).not.toContain('[shell session ended]');
  });

  it('the Interrupt button does the same as Ctrl+C', async () => {
    const { mshell } = installDrivable();
    mount();
    const input = await readyInput();
    submit(input, 'await new Promise(() => {})');

    fireEvent.click(await screen.findByRole('button', { name: 'Interrupt' }));

    await waitFor(() => expect(mshell.start).toHaveBeenCalledTimes(2));
    expect(mshell.stop).toHaveBeenCalledWith({ sessionId: 's1' });
  });

  it('Ctrl+C with nothing running does not restart the shell', async () => {
    const { mshell } = installDrivable();
    mount();
    const input = await readyInput();

    fireEvent.keyDown(input, { key: 'c', ctrlKey: true });
    await new Promise((r) => setTimeout(r, 30));

    expect(mshell.stop).not.toHaveBeenCalled();
    expect(mshell.start).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+C over selected text is left to copy, even while a command runs', async () => {
    const { mshell } = installDrivable();
    mount();
    const input = await readyInput();
    submit(input, 'await new Promise(() => {})');
    await screen.findByTestId('mongo-shell-busy');
    fireEvent.change(input, { target: { value: 'copy me' } });
    input.setSelectionRange(0, 4);

    fireEvent.keyDown(input, { key: 'c', ctrlKey: true });
    await new Promise((r) => setTimeout(r, 30));

    expect(mshell.stop).not.toHaveBeenCalled();
  });

  it('says the shell stopped, not that it is starting, once it has ended', async () => {
    const { push } = installDrivable();
    mount();
    const input = await readyInput();
    expect(input.placeholder).toBe('');

    await push({ sessionId: 's1', kind: 'exit', exitCode: 0, signal: null });

    await waitFor(() => expect(input.placeholder).toBe('shell stopped — press Restart'));
    expect(input.disabled).toBe(true);
    expect(screen.queryByTestId('mongo-shell-busy')).toBeNull();
  });

  it('says the shell is unavailable when it could not start', async () => {
    installDrivable(async () => {
      throw { code: 'INTERNAL', message: 'connect failed' };
    });
    mount();
    const input = (await screen.findByLabelText('Mongo shell input')) as HTMLInputElement;

    await waitFor(() => expect(input.placeholder).toBe('shell unavailable — press Restart'));
  });

  it('says it is starting only while it starts', async () => {
    let release!: (info: ShellSessionInfo) => void;
    installDrivable(
      () =>
        new Promise<ShellSessionInfo>((resolve) => {
          release = resolve;
        }),
    );
    mount();
    const input = (await screen.findByLabelText('Mongo shell input')) as HTMLInputElement;
    await waitFor(() => expect(input.placeholder).toBe('starting…'));

    await act(async () => {
      release({ sessionId: 's1', connectionId: 'c1', startedAt: new Date().toISOString() });
    });

    await waitFor(() => expect(input.placeholder).toBe(''));
  });

  it('Restart after the shell stopped starts a new session', async () => {
    const { mshell, push } = installDrivable();
    mount();
    const input = await readyInput();
    await push({ sessionId: 's1', kind: 'exit', exitCode: 0, signal: null });
    await waitFor(() => expect(input.placeholder).toBe('shell stopped — press Restart'));

    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));

    await waitFor(() => expect(mshell.start).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(input.placeholder).toBe(''));
  });

  // ─── A stop that fails ─────────────────────────────────────────────────

  // Main rejects with the plain `{ code, message }` shape, not an Error.
  const sessionGone = { code: 'NOT_FOUND', message: 'no session s1' };

  it('Stop that main refuses prints why in the pane and logs it', async () => {
    const { mshell, log } = installDrivable();
    mshell.stop.mockRejectedValueOnce(sessionGone);
    mount();
    await readyInput();

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));

    expect(await screen.findByText(/\[could not stop the shell: no session s1\]/)).toBeTruthy();
    expect(log).toHaveBeenCalledWith({
      level: 'warn', message: 'mshell stop failed: no session s1', source: 'component',
    });
  });

  it('a stop that fails while the pane unmounts is logged, not swallowed', async () => {
    const { mshell, log } = installDrivable();
    mshell.stop.mockRejectedValueOnce(sessionGone);
    const view = mount();
    await readyInput();

    view.unmount();

    await waitFor(() => expect(log).toHaveBeenCalledWith({
      level: 'warn', message: 'mshell stop failed during cleanup: no session s1', source: 'component',
    }));
  });

  it('a stop that throws an Error sends its stack as the stack', async () => {
    const { mshell, log } = installDrivable();
    const err = new Error('bridge gone');
    mshell.stop.mockRejectedValueOnce(err);
    mount();
    await readyInput();

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));

    await waitFor(() => expect(log).toHaveBeenCalledWith({
      level: 'warn', message: 'mshell stop failed: bridge gone', source: 'component', stack: err.stack,
    }));
  });

  it('a stop that fails for a session that started after the pane went away is logged', async () => {
    let release!: (info: ShellSessionInfo) => void;
    const { mshell, log } = installDrivable(
      () =>
        new Promise<ShellSessionInfo>((resolve) => {
          release = resolve;
        }),
    );
    mshell.stop.mockRejectedValueOnce(sessionGone);
    const view = mount();
    await waitFor(() => expect(mshell.start).toHaveBeenCalledTimes(1));
    view.unmount();

    await act(async () => {
      release({ sessionId: 's1', connectionId: 'c1', startedAt: new Date().toISOString() });
    });

    await waitFor(() => expect(mshell.stop).toHaveBeenCalledWith({ sessionId: 's1' }));
    await waitFor(() => expect(log).toHaveBeenCalledWith({
      level: 'warn', message: 'mshell stop failed during cleanup: no session s1', source: 'component',
    }));
  });
});
