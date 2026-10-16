import { describe, it, expect, vi, afterEach } from 'vitest';
import { notifications } from '@mantine/notifications';
import { act, render, screen, waitFor, fireEvent } from '../helpers/render';
import { installAtelierMock } from '../helpers/atelierMock';
import { UpdateReadyPrompt } from '../../src/features/updates/UpdateReadyPrompt';
import type { UpdateState } from '../../shared/types';

afterEach(() => {
  notifications.clean();
});

function setup(initial: UpdateState = { status: 'idle' }, restart = vi.fn(async (): Promise<{ restarting: boolean }> => ({ restarting: true }))) {
  let push: (s: UpdateState) => void = () => {};
  const unsubscribe = vi.fn();
  installAtelierMock({
    updates: {
      getState: async () => initial,
      restart,
      onState: (cb) => {
        push = cb;
        return unsubscribe;
      },
    },
  });
  // helpers/render already mounts <Notifications />.
  const view = render(<UpdateReadyPrompt />);
  return { view, restart, unsubscribe, push: (s: UpdateState) => act(() => push(s)) };
}

describe('UpdateReadyPrompt', () => {
  it('shows nothing while idle', async () => {
    setup();
    await act(async () => {});
    expect(screen.queryByText(/is ready/)).toBeNull();
  });

  it('shows the version and a Restart button when ready on mount', async () => {
    setup({ status: 'ready', version: '1.2.3' });
    expect(await screen.findByText('Version 1.2.3 is ready')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Restart to update' })).toBeTruthy();
  });

  it('shows a pushed ready event, and a second push replaces rather than stacks', async () => {
    const { push } = setup();
    push({ status: 'ready', version: '1.0.0' });
    push({ status: 'ready', version: '1.1.0' });
    expect(await screen.findByText('Version 1.1.0 is ready')).toBeTruthy();
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Restart to update' })).toHaveLength(1));
    expect(screen.queryByText('Version 1.0.0 is ready')).toBeNull();
  });

  it('ignores a pushed idle state', async () => {
    const { push } = setup();
    push({ status: 'idle' });
    expect(screen.queryByText(/is ready/)).toBeNull();
  });

  it('calls updates.restart once when Restart is clicked', async () => {
    const { restart } = setup({ status: 'ready', version: '1.2.3' });
    fireEvent.click(await screen.findByRole('button', { name: 'Restart to update' }));
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('shows a non-modal error when restart fails', async () => {
    const restart = vi.fn(async () => {
      throw { code: 'VALIDATION', message: 'No update is ready to install' };
    });
    setup({ status: 'ready', version: '1.2.3' }, restart as never);
    fireEvent.click(await screen.findByRole('button', { name: 'Restart to update' }));
    expect(await screen.findByText(/No update is ready to install\. It will be applied when you quit\./)).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a cancelled restart shows no error, and the prompt is offered again when ready is re-sent', async () => {
    const restart = vi.fn(async () => ({ restarting: false }));
    const { push } = setup({ status: 'ready', version: '1.2.3' }, restart);
    fireEvent.click(await screen.findByRole('button', { name: 'Restart to update' }));
    await waitFor(() => expect(restart).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Restart to update' })).toBeNull());
    // Main re-sends ready after a cancel; the toast the click hid comes back.
    push({ status: 'ready', version: '1.2.3' });
    expect(await screen.findByRole('button', { name: 'Restart to update' })).toBeTruthy();
    await act(async () => {});
    expect(screen.queryByText(/could not be applied|will be applied when you quit/)).toBeNull();
  });

  it('is not a modal', async () => {
    setup({ status: 'ready', version: '1.2.3' });
    await screen.findByText('Version 1.2.3 is ready');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('unsubscribes on unmount', async () => {
    const { view, unsubscribe } = setup();
    await act(async () => {});
    view.unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
