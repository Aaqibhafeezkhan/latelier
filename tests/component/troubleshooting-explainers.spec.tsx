import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '../helpers/render';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import NewConnection from '../../src/pages/NewConnection';
import { TroubleshootingProvider } from '../../src/troubleshooting/TroubleshootingProvider';
import {
  TLS_INLINE_EXPLAINER,
  DIRECT_CONNECTION_INLINE_EXPLAINER,
} from '../../src/troubleshooting/recipes';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

function renderNew() {
  return render(
      <TroubleshootingProvider>
        <RouterProvider
          router={createMemoryRouter([{ path: '/connections/new', element: <NewConnection /> }], {
            initialEntries: ['/connections/new'],
          })}
        />
      </TroubleshootingProvider>
  );
}

describe('Inline explainers render in NewConnection', () => {
  it('TLS tab shows the TLS_INLINE_EXPLAINER under the toggle, regardless of toggle state', async () => {
    installAtelierMock({});
    renderNew();
    await userEvent.click(screen.getByText('TLS'));
    // First snippet of the explainer.
    await waitFor(() =>
      expect(
        screen.getByText(new RegExp(TLS_INLINE_EXPLAINER.slice(0, 40))),
      ).toBeTruthy(),
    );

    // Toggle off and confirm the explainer is still there.
    await userEvent.click(screen.getByText(/Enable TLS \/ SSL/));
    await waitFor(() =>
      expect(
        screen.getByText(new RegExp(TLS_INLINE_EXPLAINER.slice(0, 40))),
      ).toBeTruthy(),
    );
  });

  it('Advanced tab shows the DIRECT_CONNECTION_INLINE_EXPLAINER under the toggle', async () => {
    installAtelierMock({});
    renderNew();
    await userEvent.click(screen.getByText('Advanced'));
    await waitFor(() =>
      expect(
        screen.getByText(new RegExp(DIRECT_CONNECTION_INLINE_EXPLAINER.slice(0, 40))),
      ).toBeTruthy(),
    );
  });
});
