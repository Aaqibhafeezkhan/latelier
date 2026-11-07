import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, render, screen } from '../helpers/render';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import { DeleteConfirm } from '../../src/pages/Workspace/DeleteConfirm';
import { RenameCollectionModal } from '../../src/pages/Workspace/RenameCollectionModal';
import { DropCollectionConfirm } from '../../src/pages/Workspace/DropCollectionConfirm';
import { DropDatabaseConfirm } from '../../src/pages/Workspace/DropDatabaseConfirm';
import { CreateCollectionDrawer } from '../../src/pages/Workspace/CreateCollectionDrawer';
import { ReferenceRulesEditor } from '../../src/features/references/ReferenceRulesEditor';

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

// Mantine's focus trap moves focus after mount (`setTimeout(0)`), to
// `[data-autofocus]` and otherwise to the header's Close button, overriding a
// plain `autoFocus`. React's own `autoFocus` has already run by then, so a
// check made before the trap settles passes for a dialog that ends on Close.
// This waits past that timer, then reads where focus really is.
const settleFocusTrap = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });

async function expectFocusOn(el: HTMLElement) {
  await settleFocusTrap();
  expect(document.activeElement).toBe(el);
}

describe('dialogs open on their first real control, not on Close', () => {
  it('Settings: the open section\'s rail tab', async () => {
    const { SettingsModal } = await import('../../src/pages/SettingsModal');
    const { HintsProvider } = await import('../../src/hints/HintsProvider');
    installAtelierMock({ prefs: { get: async () => null, set: async (_k: string, v: unknown) => v } as never });
    render(
      <HintsProvider>
        <SettingsModal initialSection="results" onClose={() => {}} />
      </HintsProvider>,
    );

    await expectFocusOn(await screen.findByRole('tab', { name: 'Results' }));
  });

  it('Delete one document: Cancel, the safe end of a destructive prompt', async () => {
    installAtelierMock({});
    render(
      <DeleteConfirm
        connectionId="c1"
        dbName="app"
        collection="orders"
        docs={[{ _id: '1' }]}
        onClose={() => {}}
        onDeleted={() => {}}
      />,
    );

    await expectFocusOn(screen.getByRole('button', { name: 'Cancel' }));
  });

  it('Rename collection: the new-name field', async () => {
    installAtelierMock({});
    render(
      <RenameCollectionModal
        connectionId="c1"
        dbName="shop"
        collection="orders"
        onCancel={() => {}}
        onRenamed={() => {}}
      />,
    );

    await expectFocusOn(screen.getByLabelText('New name'));
  });

  it('Drop collection: the confirmation field', async () => {
    installAtelierMock({});
    render(
      <DropCollectionConfirm
        connectionId="c1"
        dbName="shop"
        collection="orders"
        onCancel={() => {}}
        onDropped={() => {}}
      />,
    );

    await expectFocusOn(screen.getByLabelText('Confirm collection name'));
  });

  it('Drop database: the confirmation field', async () => {
    installAtelierMock({});
    render(<DropDatabaseConfirm connectionId="c1" dbName="shop" onCancel={() => {}} onDropped={() => {}} />);

    await expectFocusOn(screen.getByLabelText('Confirm database name'));
  });

  it('New collection: the collection name field', async () => {
    installAtelierMock({});
    render(<CreateCollectionDrawer connectionId="c1" dbName="shop" onCancel={() => {}} onCreated={() => {}} />);

    await expectFocusOn(screen.getByLabelText('Collection name'));
  });

  it('Reference rules: New rule', async () => {
    installAtelierMock({ refs: { list: (async () => []) as never } as never });
    render(<ReferenceRulesEditor connectionId="conn-1" dbName="shop" collection="orders" onClose={() => {}} />);

    await expectFocusOn(await screen.findByRole('button', { name: 'New rule' }));
  });
});
