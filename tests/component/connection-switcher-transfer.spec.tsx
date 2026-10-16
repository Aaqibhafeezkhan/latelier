import { describe, it, expect, afterEach, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, waitFor, within } from '../helpers/render';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import Workspace from '../../src/pages/Workspace';
import { ConnectionTransferProvider } from '../../src/features/connections/ConnectionTransferProvider';
import type { ConnectionSummary } from '@shared/types';

const row = (id: string, name: string): ConnectionSummary => ({
  id, name, color: '#1A6835', host: `${name.toLowerCase()}.example.com`, port: 27017,
  connectionType: 'standard', readOnly: false, status: 'unknown',
});

const THREE = [row('c1', 'Prod'), row('c2', 'Staging'), row('c3', 'Dev')];

function mount(connections: ConnectionSummary[]) {
  const backing = [...connections];
  const del = vi.fn(async (id: string) => {
    backing.splice(backing.findIndex((c) => c.id === id), 1);
    return { id };
  });
  const exp = vi.fn(async () => ({ written: 2, omittedSecrets: [] }));
  installAtelierMock({
    conn: { list: async () => [...backing], delete: del, export: exp },
    tabs: { list: async () => [] },
  });
  render(
    <MemoryRouter initialEntries={['/workspace']}>
      <ConnectionTransferProvider>
        <Workspace />
      </ConnectionTransferProvider>
    </MemoryRouter>,
  );
  return { del, exp };
}

async function openTable() {
  const titleBar = within(await screen.findByRole('banner'));
  await userEvent.click(await titleBar.findByRole('button', { name: /^Connection: / }));
  await userEvent.click(await screen.findByRole('button', { name: 'Manage connections' }));
  return screen.findByRole('dialog', { name: 'Connections' });
}

const check = (table: HTMLElement, name: string) =>
  userEvent.click(within(table).getByRole('checkbox', { name: `Check ${name}` }));
const toolbar = () => screen.getByRole('toolbar', { name: 'Checked connections' });
/** The bar is always there; with nothing checked its actions are disabled and it shows no count. */
const expectNoneChecked = () => {
  for (const name of ['Export', 'Delete']) {
    expect((within(toolbar()).getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
  }
  expect(within(toolbar()).queryByText(/checked/)).toBeNull();
  expect(within(toolbar()).queryByRole('button', { name: 'Clear' })).toBeNull();
};

afterEach(uninstallAtelierMock);

describe('Connections table: adding', () => {
  it('stacks the Import Wizard on the table from Paste URIs', async () => {
    mount([row('c1', 'Prod')]);
    const table = await openTable();
    await userEvent.click(within(table).getByRole('button', { name: 'Paste URIs' }));
    expect(await screen.findByRole('dialog', { name: 'Import Connections' })).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Connections' })).toBeTruthy();
  });

  it('Import leaves the table for the Import Wizard', async () => {
    mount([row('c1', 'Prod')]);
    const table = await openTable();
    await userEvent.click(within(table).getByRole('button', { name: 'Import' }));
    expect(await screen.findByRole('dialog', { name: 'Import Connections' })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Connections' })).toBeNull();
  });

  it('Escape closes only the dialog stacked on the table', async () => {
    mount([row('c1', 'Prod')]);
    const table = await openTable();
    await userEvent.click(within(table).getByRole('button', { name: 'Paste URIs' }));
    await screen.findByRole('dialog', { name: 'Import Connections' });

    await userEvent.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Import Connections' })).toBeNull());
    expect(screen.getByRole('dialog', { name: 'Connections' })).toBeTruthy();
    // With nothing stacked, the table takes Escape again.
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Connections' })).toBeNull());
  });
});

describe('Connections table: checked rows', () => {
  it('keeps Export and Delete in place but disabled until something is checked, and Clear empties it', async () => {
    mount(THREE);
    const table = await openTable();
    expectNoneChecked();

    await check(table, 'Prod');
    await check(table, 'Dev');
    expect(within(toolbar()).getByText('2 checked')).toBeTruthy();
    expect((within(toolbar()).getByRole('button', { name: 'Export' }) as HTMLButtonElement).disabled).toBe(false);
    expect((within(toolbar()).getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(false);

    await userEvent.click(within(toolbar()).getByRole('button', { name: 'Clear' }));
    expectNoneChecked();
  });

  it('checking a row does not open or close its detail', async () => {
    mount(THREE);
    const table = await openTable();
    const tr = within(table).getByText('Prod').closest('tr')!;
    await check(table, 'Prod');
    expect(tr.getAttribute('aria-expanded')).toBe('false');
  });

  it('the header checks all shown rows, shows partial, and clears them again', async () => {
    mount(THREE);
    const table = await openTable();
    const all = within(table).getByRole('checkbox', { name: 'Check all shown connections' }) as HTMLInputElement;

    await check(table, 'Prod');
    expect(all.indeterminate).toBe(true);
    expect(all.checked).toBe(false);

    await userEvent.click(all);
    expect(all.checked).toBe(true);
    expect(within(toolbar()).getByText('3 checked')).toBeTruthy();

    await userEvent.click(all);
    expectNoneChecked();
  });

  it('a search drops the checks on the rows it hides, so no batch action reaches them', async () => {
    mount(THREE);
    const table = await openTable();
    await userEvent.click(within(table).getByRole('checkbox', { name: 'Check all shown connections' }));

    await userEvent.type(within(table).getByRole('textbox', { name: /search connections/i }), 'prod');
    expect(within(toolbar()).getByText('1 checked')).toBeTruthy();

    await userEvent.clear(within(table).getByRole('textbox', { name: /search connections/i }));
    expect(within(toolbar()).getByText('1 checked')).toBeTruthy();
  });

  it('the header checks only the rows the search shows', async () => {
    mount(THREE);
    const table = await openTable();
    await userEvent.type(within(table).getByRole('textbox', { name: /search connections/i }), 'staging');
    await userEvent.click(within(table).getByRole('checkbox', { name: 'Check all shown connections' }));
    await userEvent.clear(within(table).getByRole('textbox', { name: /search connections/i }));
    expect((within(table).getByRole('checkbox', { name: 'Check Staging' }) as HTMLInputElement).checked).toBe(true);
    expect((within(table).getByRole('checkbox', { name: 'Check Prod' }) as HTMLInputElement).checked).toBe(false);
  });

  it('Export exports exactly the checked rows, with no second checklist, and the table stays', async () => {
    const { exp } = mount(THREE);
    const table = await openTable();
    await check(table, 'Prod');
    await check(table, 'Dev');
    await userEvent.click(within(toolbar()).getByRole('button', { name: 'Export' }));

    const dialog = await screen.findByRole('dialog', { name: 'Export Connections' });
    expect(within(dialog).getByText('2 checked Connections.')).toBeTruthy();
    expect(within(dialog).queryByRole('checkbox', { name: 'Prod' })).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Export' }));

    await waitFor(() => expect(exp).toHaveBeenCalledWith({ ids: ['c1', 'c3'], includeSecrets: false }));
    await within(dialog).findByText('2 Connections written.');
    // The text button, not the header's ×, which carries the same name.
    await userEvent.click(within(dialog).getByText('Close', { selector: 'button *' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Export Connections' })).toBeNull());
    expect(screen.getByRole('dialog', { name: 'Connections' })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(within(toolbar()).getByRole('button', { name: 'Export' })));
  });

  it('Delete confirms once by typing, deletes each checked row, and keeps the table open', async () => {
    const { del } = mount(THREE);
    const table = await openTable();
    await check(table, 'Prod');
    await check(table, 'Staging');
    await userEvent.click(within(toolbar()).getByRole('button', { name: 'Delete' }));

    const confirm = await screen.findByRole('dialog', { name: 'Delete 2 connections?' });
    const go = within(confirm).getByRole('button', { name: 'Delete' }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    await userEvent.type(within(confirm).getByRole('textbox', { name: 'Confirm deletion' }), 'delete 2');
    await userEvent.click(go);

    await waitFor(() => expect(del.mock.calls.map((c) => c[0])).toEqual(['c1', 'c2']));
    await waitFor(() => expect(within(table).queryByText('Prod')).toBeNull());
    expect(within(table).getByText('Dev')).toBeTruthy();
    expectNoneChecked();
    expect(screen.getByRole('dialog', { name: 'Connections' })).toBeTruthy();
  });

  it('cancelling the batch delete deletes nothing and keeps the checks', async () => {
    const { del } = mount(THREE);
    const table = await openTable();
    await check(table, 'Prod');
    await userEvent.click(within(toolbar()).getByRole('button', { name: 'Delete' }));
    // One checked row is an ordinary delete: its own name is the phrase.
    const confirm = await screen.findByRole('dialog', { name: 'Delete "Prod"?' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: /^Delete/ })).toBeNull());
    expect(del).not.toHaveBeenCalled();
    expect(within(toolbar()).getByText('1 checked')).toBeTruthy();
  });
});
