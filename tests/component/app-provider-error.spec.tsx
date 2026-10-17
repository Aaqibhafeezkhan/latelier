import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '../helpers/render';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';

// A provider in the root stack that fails while rendering.
vi.mock('../../src/commands/PaletteContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/commands/PaletteContext')>()),
  PaletteContextProvider: () => {
    throw new Error('palette provider exploded');
  },
}));

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

describe('root layout', () => {
  it('shows the app error screen, not the router default, when a provider fails to render', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    installAtelierMock({});
    const { RootLayout } = await import('../../src/RootLayout');
    const router = createMemoryRouter(
      [{ element: <RootLayout />, children: [{ path: '/', element: <div>screen</div> }] }],
      { initialEntries: ['/'] },
    );
    render(<RouterProvider router={router} />);

    expect(await screen.findByText('Something went wrong')).toBeTruthy();
    expect(screen.queryByText(/Unexpected Application Error/)).toBeNull();
  });
});
