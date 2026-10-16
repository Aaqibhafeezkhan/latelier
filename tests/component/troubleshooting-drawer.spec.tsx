import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '../helpers/render';
import userEvent from '@testing-library/user-event';
import { notifications } from '@mantine/notifications';
import { InlineMarkdown } from '../../src/troubleshooting/markdown';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import { TroubleshootingProvider } from '../../src/troubleshooting/TroubleshootingProvider';
import { useTroubleshooting } from '../../src/troubleshooting/TroubleshootingContext';
import type { RecipeMatchInput } from '../../src/troubleshooting/types';

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

function Harness({ initialInput }: { initialInput?: RecipeMatchInput }) {
  return (
      <TroubleshootingProvider>
        <Opener initialInput={initialInput} />
      </TroubleshootingProvider>
  );
}

function Opener({ initialInput }: { initialInput?: RecipeMatchInput }) {
  const help = useTroubleshooting();
  return (
    <div>
      <button onClick={() => help.open(initialInput)}>open-trigger</button>
      <button onClick={() => help.close()}>close-trigger</button>
    </div>
  );
}

describe('TroubleshootingDrawer — shell', () => {
  it('opens via the hook and closes via Esc, ×, and backdrop click', async () => {
    installAtelierMock({});
    render(<Harness initialInput={{ errorCode: 'AUTH' }} />);

    // Closed initially.
    expect(screen.queryByRole('dialog')).toBeNull();

    // Open.
    await userEvent.click(screen.getByText('open-trigger'));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());

    // Close via ×.
    await userEvent.click(screen.getByLabelText('Close troubleshooting drawer'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // Reopen, then Esc. fireEvent on document.body so Mantine's keydown handler
    // sees an Element target (it calls target.getAttribute() defensively).
    await userEvent.click(screen.getByText('open-trigger'));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // Reopen, then click on the overlay (outside the dialog box). Mantine
    // renders the overlay as a sibling of the dialog, queryable by its
    // generated class name.
    await userEvent.click(screen.getByText('open-trigger'));
    await screen.findByRole('dialog');
    const overlay = document.querySelector('.mantine-Overlay-root');
    expect(overlay).toBeTruthy();
    fireEvent.click(overlay!);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('renders the AUTH recipe (auth-default) on AUTH input', async () => {
    installAtelierMock({});
    render(<Harness initialInput={{ errorCode: 'AUTH' }} />);

    await userEvent.click(screen.getByText('open-trigger'));
    await waitFor(() => expect(screen.getByText('Authentication failed')).toBeTruthy());
    expect(screen.getByText(/Check the auth database/)).toBeTruthy();
  });

  it('renders the docker-tls recipe on TIMEOUT + ECONNRESET', async () => {
    installAtelierMock({});
    render(
      <Harness
        initialInput={{
          errorCode: 'TIMEOUT',
          message: 'connect ECONNRESET 127.0.0.1:27017',
        }}
      />,
    );
    await userEvent.click(screen.getByText('open-trigger'));
    await waitFor(() =>
      expect(screen.getByText("Server doesn't speak TLS on this port")).toBeTruthy(),
    );
  });

  it('falls back to unknown when no input is given', async () => {
    installAtelierMock({});
    render(<Harness />);
    await userEvent.click(screen.getByText('open-trigger'));
    await waitFor(() => expect(screen.getByText('Connection failed')).toBeTruthy());
  });

  it('docs button calls api.app.openExternal with the docAnchor URL', async () => {
    const calls: string[] = [];
    installAtelierMock({
      app: {
        pickFile: async () => ({ path: null }),
        openExternal: async (url) => {
          calls.push(url);
          return { opened: true };
        },
        saveFile: async () => ({ path: null }),
      },
    });
    render(<Harness initialInput={{ errorCode: 'AUTH' }} />);
    await userEvent.click(screen.getByText('open-trigger'));
    await waitFor(() => expect(screen.getByText('Open the full guide ↗')).toBeTruthy());
    await userEvent.click(screen.getByText('Open the full guide ↗'));
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]).toMatch(/^https:\/\//);
    expect(calls[0]).toMatch(/#auth-default$/);
  });
});

describe('TroubleshootingDrawer — a guide link that cannot open says so', () => {
  afterEach(() => {
    notifications.clean();
  });

  it('toasts when the full guide cannot be opened', async () => {
    installAtelierMock({
      app: {
        pickFile: async () => ({ path: null }),
        openExternal: async () => {
          throw { code: 'VALIDATION', message: 'blocked' };
        },
        saveFile: async () => ({ path: null }),
      },
    });
    render(<Harness initialInput={{ errorCode: 'AUTH' }} />);
    await userEvent.click(screen.getByText('open-trigger'));
    await userEvent.click(await screen.findByText('Open the full guide ↗'));

    expect(await screen.findByText('Could not open the link')).toBeTruthy();
  });

  it('toasts when a link inside a recipe cannot be opened', async () => {
    installAtelierMock({
      app: {
        pickFile: async () => ({ path: null }),
        openExternal: async () => {
          throw { code: 'VALIDATION', message: 'blocked' };
        },
        saveFile: async () => ({ path: null }),
      },
    });
    render(<InlineMarkdown source="See [the guide](https://example.com/guide)." />);

    await userEvent.click(screen.getByText('the guide'));

    expect(await screen.findByText('Could not open the link')).toBeTruthy();
  });
});
