// A delete or update-all confirm hands its completion to `useDocumentDialogs`
// through `DialogStack`. Focus can move while the request is in flight (the
// dialog closes, the request still lands), and the follow-up refresh and the
// Undo toast must then follow the collection that was written to rather than
// whichever tab is focused at completion.
//
// A write that lands must also leave alone a dialog the user has opened since,
// on whichever tab is focused by then: only the dialog that started the write
// closes itself.
//
// `use-document-dialogs.spec.tsx` drives the hook through a harness that
// mirrors `DialogStack`; this mounts the real page so the binding between the
// dialog and the hook is covered too.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createElement } from 'react';
import { act } from '@testing-library/react';
import { notifications } from '@mantine/notifications';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, fireEvent, waitFor, within } from '../helpers/render';
import Workspace from '../../src/pages/Workspace';
import { installAtelierMock, multiConnectionMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { CollectionWorkspaceActions } from '../../src/pages/Workspace/context';

const NOW = '2026-08-01T12:00:00.000Z';
const DOC = { _id: '1', sku: 'widget' };

// Rendered straight from tab state, so the rows show without a Run and the
// auto-run-on-open effect does not fire an unmocked `query.find`.
const lastRun = { documents: [DOC], durationMs: 1, ranAt: NOW };

const capturedActions: CollectionWorkspaceActions[] = [];

// Records the `actions` object the page hands its one provider, so a test can
// patch the Focused Tab's query the way the query bar does.
vi.mock('../../src/pages/Workspace/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/pages/Workspace/context')>();
  return {
    ...actual,
    CollectionWorkspaceProvider: (props: Parameters<typeof actual.CollectionWorkspaceProvider>[0]) => {
      capturedActions.push(props.actions);
      return createElement(actual.CollectionWorkspaceProvider, props);
    },
  };
});

afterEach(() => {
  notifications.clean();
  uninstallAtelierMock();
  vi.restoreAllMocks();
  capturedActions.length = 0;
});

type Kind = 'delete' | 'delete-all' | 'update-all';

const DIALOG_NAME: Record<Kind, string | RegExp> = {
  delete: 'Delete document?',
  'delete-all': /Delete .* matching documents?\?/,
  'update-all': 'Update all matching documents',
};

/** Opens `kind`'s confirm dialog on the Focused Tab. */
async function openDialog(kind: Kind) {
  if (kind === 'delete') {
    fireEvent.click(screen.getByRole('button', { name: /^Delete document/ }));
  } else {
    fireEvent.click(screen.getByRole('button', { name: 'Documents' }));
    fireEvent.click(screen.getByText(kind === 'delete-all' ? 'Delete all matching…' : 'Update all matching…'));
  }
  return screen.findByRole('dialog', { name: DIALOG_NAME[kind] });
}

/** Fills in and confirms a dialog opened by `openDialog` for the Focused Tab's collection. */
async function confirmDialog(kind: Kind, dialog: HTMLElement, collection: string) {
  if (kind === 'delete') {
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
  } else if (kind === 'delete-all') {
    fireEvent.change(within(dialog).getByPlaceholderText(collection), { target: { value: collection } });
    await waitFor(() =>
      expect((within(dialog).getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
  } else {
    fireEvent.change(within(dialog).getByLabelText('Update document'), { target: { value: '{"$set":{"a":1}}' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Review/ }));
    fireEvent.change(await within(dialog).findByPlaceholderText(collection), { target: { value: collection } });
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Update' }));
  }
}

const FILTER = '{"status":"pending"}';

/** Mounts the page with `orders` (focused) and `users` open and every write held in flight until `land` is called. */
async function mountOrdersAndUsers() {
  let finish!: (v: unknown) => void;
  const inFlight = () => new Promise((r) => { finish = r; });
  const find = vi.fn(async () => ({ documents: [DOC], durationMs: 1, hasMore: false }));
  const undo = vi.fn(async () => ({ restored: 1, skipped: 0 }));
  const state = {
    view: 'Tree' as const,
    builder: { projection: [], sort: '', limit: '' },
    queryRaw: FILTER,
    page: 0,
    pageSize: 50,
    activeBuilderTab: 'Builder' as const,
    lastRun,
  };
  installAtelierMock({
    ...multiConnectionMock({
      connections: [{ id: 'c1', name: 'Prod' }],
      tabs: [
        { dbName: 'shop', collection: 'orders', isActive: true, state },
        { dbName: 'shop', collection: 'users', state },
      ],
    }),
    query: { find },
    doc: {
      deleteOne: inFlight as never,
      confirmDeleteMany: (async () => ({ count: 2, confirmToken: 'tok' })) as never,
      deleteMany: inFlight as never,
      confirmUpdateMany: (async () => ({ count: 2, confirmToken: 'tok' })) as never,
      updateMany: inFlight as never,
    },
    audit: { undo: undo as never },
  });
  render(
    <MemoryRouter initialEntries={['/workspace']}>
      <Workspace />
    </MemoryRouter>,
  );
  await screen.findByText(/widget/);
  const land = (kind: Kind) =>
    act(async () => {
      finish(kind === 'update-all' ? { matchedCount: 2, modifiedCount: 2, auditId: 'a1' } : { deletedCount: 2, auditId: 'a1' });
    });
  return { find, undo, land };
}

/**
 * Starts `kind` on `orders`, moves focus to `users` while the request is in
 * flight, optionally opens the same kind of dialog there, then lets the
 * `orders` write land.
 */
async function startWriteThenFocusUsers(kind: Kind, { reopenOnUsers = false } = {}) {
  const { find, undo, land } = await mountOrdersAndUsers();

  await confirmDialog(kind, await openDialog(kind), 'orders');

  // Focus moves to `users` while the write is still in flight.
  await userEvent.click(screen.getByRole('tab', { name: /^users/ }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  // A dialog of the same kind, opened on `users` and left unconfirmed.
  if (reopenOnUsers) await openDialog(kind);
  find.mockClear();

  await land(kind);
  return { find, undo };
}

const collectionsQueried = (find: ReturnType<typeof vi.fn>) =>
  find.mock.calls.map((c) => (c[0] as { collection: string }).collection);

describe('a write that lands after focus moved to another tab', () => {
  it.each([
    ['single-document delete', 'delete'],
    ['delete-all', 'delete-all'],
    ['update-all', 'update-all'],
  ] as const)('%s refreshes the collection it wrote to and its Undo refreshes it again', async (_name, kind) => {
    const { find, undo } = await startWriteThenFocusUsers(kind);

    await waitFor(() => expect(find).toHaveBeenCalled());
    expect(collectionsQueried(find)).toEqual(['orders']);

    find.mockClear();
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));

    await waitFor(() => expect(undo).toHaveBeenCalledWith({ entryId: 'a1' }));
    await waitFor(() => expect(find).toHaveBeenCalled());
    expect(collectionsQueried(find)).toEqual(['orders']);
  });
});

// The orders dialog's request is still in flight when the user focuses users
// and opens a dialog of their own there. The orders write landing is about
// orders: it refreshes orders and offers its Undo, and the users dialog the
// user is looking at stays where it is.
describe('a write that lands while a dialog is open on the tab focused since', () => {
  it.each([
    ['single-document delete', 'delete'],
    ['delete-all', 'delete-all'],
    ['update-all', 'update-all'],
  ] as const)('%s leaves that dialog open', async (_name, kind) => {
    const { find } = await startWriteThenFocusUsers(kind, { reopenOnUsers: true });

    // The write was handled: orders refreshed and the toast is up.
    await waitFor(() => expect(find).toHaveBeenCalled());
    expect(collectionsQueried(find)).toEqual(['orders']);
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeTruthy();

    expect(screen.getByRole('dialog', { name: DIALOG_NAME[kind] })).toBeTruthy();
  });
});

// A delete-all or update-all dialog reads its filter live from the Focused
// Tab, and `DialogStack` hides it while that filter is not runnable, leaving
// the open flag set. If the write lands in that state the flag must still be
// cleared, or the dialog would pop back, unconfirmed and blank, the moment the
// filter is valid again.
describe('a write that lands while its dialog is hidden by an invalid filter', () => {
  it.each([
    ['delete-all', 'delete-all'],
    ['update-all', 'update-all'],
  ] as const)('%s does not bring its dialog back once the filter is valid again', async (_name, kind) => {
    const { land } = await mountOrdersAndUsers();
    await confirmDialog(kind, await openDialog(kind), 'orders');

    // The filter goes blank mid-flight: no runnable filter, so the dialog unmounts.
    act(() => capturedActions.at(-1)!.patch({ queryRaw: '' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await land(kind);
    // The write was handled: its Undo toast is up.
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeTruthy();

    act(() => capturedActions.at(-1)!.patch({ queryRaw: FILTER }));

    await screen.findByText(/widget/);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
