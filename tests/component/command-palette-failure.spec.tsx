import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '../helpers/render';
import { MemoryRouter } from 'react-router-dom';
import { notifications } from '@mantine/notifications';
import {
  CommandPaletteRoot,
  usePaletteApi,
  _resetPaletteStoreForTests,
} from '../../src/commands/CommandPalette';
import { PaletteContextProvider } from '../../src/commands/PaletteContext';
import { useRegisterCommands } from '../../src/commands/useRegisterCommands';
import { useRegisterObjects } from '../../src/commands/useRegisterObjects';
import { notify } from '../../src/theme/notifications';
import { commandRegistry } from '../../src/commands/registry';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';

function ToggleButton() {
  const palette = usePaletteApi();
  return <button onClick={palette.toggle}>toggle</button>;
}

/** Whether the palette was still open at each moment a command ran. */
const openAtPerform: boolean[] = [];

function Register({ perform }: { perform: () => void | Promise<void> }) {
  const palette = usePaletteApi();
  useRegisterCommands(
    [
      {
        id: 'test.export',
        title: 'Export collection…',
        group: 'general',
        perform: () => {
          openAtPerform.push(palette.isOpen());
          return perform();
        },
      },
    ],
    [perform, palette],
  );
  return null;
}

/** A collection whose Export… rejects. */
function RegisterObject() {
  useRegisterObjects(
    [
      {
        id: 'tab.open:c1:shop:orders',
        kind: 'collection',
        name: 'shop.orders',
        subtitle: 'Production',
        actions: [
          { id: 'open', verb: 'open', title: 'Open', perform: () => {} },
          { id: 'export', verb: 'export', title: 'Export…', perform: () => Promise.reject(new Error('lost')) },
        ],
      },
    ],
    [],
  );
  return null;
}

function mount(perform: () => void | Promise<void>) {
  installAtelierMock({});
  return render(
    <MemoryRouter>
      <PaletteContextProvider>
        <CommandPaletteRoot>
          <Register perform={perform} />
          <RegisterObject />
          <ToggleButton />
        </CommandPaletteRoot>
      </PaletteContextProvider>
    </MemoryRouter>,
  );
}

async function run() {
  fireEvent.click(screen.getByText('toggle'));
  fireEvent.click(await screen.findByText('Export collection…'));
}

afterEach(() => {
  openAtPerform.length = 0;
  // The notification store outlives a test.
  notifications.clean();
  commandRegistry._resetForTests();
  _resetPaletteStoreForTests();
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

describe('a command that fails', () => {
  it('toasts once, naming the command and carrying the error message, after the palette closes', async () => {
    mount(() => Promise.reject(new Error('The connection to Production was lost.')));
    await run();

    expect(await screen.findByText('Couldn\'t run "Export collection…"')).toBeTruthy();
    expect(screen.getByText('The connection to Production was lost.')).toBeTruthy();
    expect(screen.getAllByText(/Couldn't run/)).toHaveLength(1);
    await waitFor(() => expect(screen.queryByLabelText('Search commands')).toBeNull());
    // The palette was already closed when the command ran, so the toast follows it.
    expect(openAtPerform).toEqual([false]);
  });

  it('draws the artboard’s error icon and red border on its own toast only', async () => {
    mount(() => Promise.reject(new Error('lost')));
    await run();
    const toast = (await screen.findByText('Couldn\'t run "Export collection…"')).closest('[role="alert"]') as HTMLElement;
    expect(toast.style.border).toBe('1px solid var(--atelier-red-border)');
    const icon = toast.querySelector('svg circle')!.closest('div') as HTMLElement;
    expect(icon.style.color).toBe('var(--atelier-red)');
    expect(icon.style.background).toBe('transparent');

    act(() => {
      notify.error('plain', { title: 'Plain error' });
    });
    const plain = (await screen.findByText('Plain error')).closest('[role="alert"]') as HTMLElement;
    expect(plain.style.border).toBe('');
    expect(plain.querySelector('svg circle')).toBeNull();
  });

  it('names an object action with the kind it acts on, as the artboard does', async () => {
    mount(() => {});
    fireEvent.click(screen.getByText('toggle'));
    fireEvent.change(await screen.findByLabelText('Search commands'), { target: { value: 'export orders' } });
    fireEvent.click(await screen.findByRole('option', { name: /shop\.orders/ }));
    expect(await screen.findByText('Couldn\'t run "Export collection…"')).toBeTruthy();
    expect(screen.getByText('lost')).toBeTruthy();
    expect(screen.getAllByText(/Couldn't run/)).toHaveLength(1);
  });

  it('toasts for a synchronous throw as well', async () => {
    mount(() => {
      throw new Error('boom');
    });
    await run();

    expect(await screen.findByText('boom')).toBeTruthy();
    expect(screen.getAllByText(/Couldn't run/)).toHaveLength(1);
  });

  it('toasts in a production build, where nothing is logged', async () => {
    vi.stubEnv('DEV', false);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mount(() => Promise.reject(new Error('nope')));
      await run();
      expect(await screen.findByText('nope')).toBeTruthy();
      expect(error).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('falls back to a plain message when the failure carries none', async () => {
    mount(() => Promise.reject(undefined));
    await run();
    expect(await screen.findByText('The command failed.')).toBeTruthy();
  });

  it('toasts nothing when the command succeeds', async () => {
    mount(() => {});
    await run();
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText(/Couldn't run/)).toBeNull();
  });
});
