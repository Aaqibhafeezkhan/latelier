import { describe, it, expect, afterEach, vi } from 'vitest';
import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '../helpers/render';
import { SchemaView } from '../../src/pages/Workspace/SchemaView';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import { DEFAULT_SCHEMA_TAB_STATE } from '@shared/defaults';
import type { SchemaTabState } from '@shared/types';

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

// The view only shows the effect of a patch once it round-trips back into
// props, so the harness has to hold the state the way Workspace does.
function Stateful() {
  const [state, setState] = React.useState<SchemaTabState>(DEFAULT_SCHEMA_TAB_STATE);
  const onPatch = React.useCallback(
    (patch: Partial<SchemaTabState>) => setState((s) => ({ ...s, ...patch })),
    [],
  );
  return (
    <SchemaView
      connectionId="c1"
      dbName="shop"
      collection="orders"
      state={state}
      onPatch={onPatch}
    />
  );
}

describe('SchemaView — a failed sample is an error, not an empty collection', () => {
  it('shows the error and not "No fields found" when the sample fails', async () => {
    installAtelierMock({
      meta: {
        sampleSchema: async () => {
          throw { code: 'MONGO_ERROR', message: 'sample failed' };
        },
      },
    });
    render(<Stateful />);

    expect((await screen.findByRole('alert')).textContent).toBe('sample failed');
    expect(screen.queryByText(/No fields found/)).toBeNull();
  });

  it('still says "No fields found" for a sample that succeeded with no documents', async () => {
    installAtelierMock({ meta: { sampleSchema: async () => ({ docs: [] }) } });
    render(<Stateful />);

    expect(await screen.findByText('No fields found in the sample.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('clears the banner when a refresh after an error succeeds', async () => {
    let fail = true;
    installAtelierMock({
      meta: {
        sampleSchema: async () => {
          if (fail) throw { code: 'MONGO_ERROR', message: 'sample failed' };
          return { docs: [] };
        },
      },
    });
    render(<Stateful />);
    await screen.findByRole('alert');

    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.getByText('No fields found in the sample.')).toBeTruthy();
  });
});

describe('SchemaView — table semantics', () => {
  it('marks every header cell as a column header (scope="col")', async () => {
    installAtelierMock({ meta: { sampleSchema: async () => ({ docs: [{ a: 1 }] }) } });
    render(<Stateful />);

    const headers = await screen.findAllByRole('columnheader');
    expect(headers).toHaveLength(5);
    for (const th of headers) expect(th.getAttribute('scope')).toBe('col');
  });
});
