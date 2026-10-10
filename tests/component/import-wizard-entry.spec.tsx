import { describe, it, expect, afterEach, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { act, render, screen, waitFor, within } from '../helpers/render';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import Workspace from '../../src/pages/Workspace';
import { ConnectionTransferProvider } from '../../src/features/connections/ConnectionTransferProvider';
import { ImportWizard } from '../../src/features/connections/importWizard/ImportWizard';
import type { MenuCommand } from '@shared/ipc';
import type { ConnectionSummary } from '@shared/types';

const row = (id: string, name: string): ConnectionSummary => ({
  id, name, color: '#1A6835', host: `${name.toLowerCase()}.example.com`, port: 27017,
  connectionType: 'standard', readOnly: false, status: 'unknown',
});

const wizard = () => screen.findByRole('dialog', { name: 'Import Connections' });
const fileButton = () => screen.getByRole('button', { name: 'Choose file…' });
const pasteBox = () => screen.getByRole('textbox', { name: /paste connection strings/i });

/** The Source step shows both halves; the entry point decides which one has focus. */
async function expectOpenAt(source: 'file' | 'paste') {
  await wizard();
  await waitFor(() => expect(document.activeElement).toBe(source === 'file' ? fileButton() : pasteBox()));
}

function mountWorkspace(connections: ConnectionSummary[]) {
  let fire: (c: MenuCommand) => void = () => {};
  installAtelierMock({
    conn: { list: async () => connections },
    tabs: { list: async () => [] },
    app: {
      onMenuCommand: (cb) => {
        fire = cb;
        return () => {};
      },
    },
  });
  render(
    <MemoryRouter initialEntries={['/workspace']}>
      <ConnectionTransferProvider>
        <Workspace />
      </ConnectionTransferProvider>
    </MemoryRouter>,
  );
  return { fireMenu: (c: MenuCommand) => act(() => fire(c)) };
}

async function openTable() {
  const titleBar = within(await screen.findByRole('banner'));
  await userEvent.click(await titleBar.findByRole('button', { name: /^Connection: / }));
  await userEvent.click(await screen.findByRole('button', { name: 'Manage connections' }));
  return screen.findByRole('dialog', { name: 'Connections' });
}

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

describe('Import Wizard entry points', () => {
  it('the File menu opens the wizard at the file source', async () => {
    const { fireMenu } = mountWorkspace([row('c1', 'Prod')]);
    await screen.findByRole('banner');
    fireMenu('connections.import');
    await expectOpenAt('file');
  });

  it('the empty first-launch screen opens the wizard at the file source', async () => {
    mountWorkspace([]);
    await userEvent.click(await screen.findByRole('button', { name: 'Import connections' }));
    await expectOpenAt('file');
  });

  it("the table footer's Import leaves the table for the wizard at the file source", async () => {
    mountWorkspace([row('c1', 'Prod')]);
    const table = await openTable();
    await userEvent.click(within(table).getByRole('button', { name: 'Import' }));
    await expectOpenAt('file');
    expect(screen.queryByRole('dialog', { name: 'Connections' })).toBeNull();
  });

  it("the table footer's Paste URIs stacks the wizard on the table at the paste source", async () => {
    mountWorkspace([row('c1', 'Prod')]);
    const table = await openTable();
    await userEvent.click(within(table).getByRole('button', { name: 'Paste URIs' }));
    await expectOpenAt('paste');
    expect(screen.getByRole('dialog', { name: 'Connections' })).toBeTruthy();
  });

  it('Escape closes only the wizard stacked on the table', async () => {
    mountWorkspace([row('c1', 'Prod')]);
    const table = await openTable();
    await userEvent.click(within(table).getByRole('button', { name: 'Paste URIs' }));
    await wizard();

    await userEvent.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Import Connections' })).toBeNull());
    expect(screen.getByRole('dialog', { name: 'Connections' })).toBeTruthy();
  });
});

describe('Import Wizard dismiss', () => {
  function underSpies() {
    installAtelierMock({});
    const onKeyDown = vi.fn();
    const onClick = vi.fn();
    const onClose = vi.fn();
    render(
      // A plain interactive ancestor: portal events bubble to it through the React tree.
      <div onKeyDown={onKeyDown} onClick={onClick}>
        <ImportWizard initial="paste" onClose={onClose} />
      </div>,
    );
    return { onKeyDown, onClick, onClose };
  }

  it('Escape closes the wizard without reaching its ancestors', async () => {
    const { onKeyDown, onClose } = underSpies();
    await expectOpenAt('paste');
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onKeyDown.mock.calls.filter(([e]) => e.key === 'Escape')).toHaveLength(0);
  });

  it('a backdrop click closes the wizard without reaching its ancestors', async () => {
    const { onClick, onClose } = underSpies();
    await wizard();
    const overlay = document.querySelector('.mantine-Modal-overlay');
    expect(overlay).not.toBeNull();
    await userEvent.click(overlay!);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });
});
