import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '../helpers/render';
import { DeleteConfirm } from '../../src/pages/Workspace/DeleteConfirm';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import { invalidateSampleSchemaCache } from '../../src/features/fieldSuggestions/sources/sampleSchemaSource';

// Mocked at the exact module DeleteConfirm imports; the rest stays real in
// case the dialog's tree reaches the suggestion sources through their barrel.
vi.mock('../../src/features/fieldSuggestions/sources/sampleSchemaSource', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/features/fieldSuggestions/sources/sampleSchemaSource')>()),
  invalidateSampleSchemaCache: vi.fn(),
}));

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
  vi.mocked(invalidateSampleSchemaCache).mockClear();
});

describe('DeleteConfirm — single document (regression)', () => {
  it('deletes via doc.deleteOne and never calls confirmDeleteMany', async () => {
    const deleteOne = vi.fn(async () => ({ deletedCount: 1 }));
    const confirmDeleteMany = vi.fn();
    installAtelierMock({ doc: { deleteOne, confirmDeleteMany } });

    const onClose = vi.fn();
    const onDeleted = vi.fn();

    render(
      <DeleteConfirm
        connectionId="c1"
        dbName="app"
        collection="orders"
        docs={[{ _id: '1', sku: 'a' }]}
        onClose={onClose}
        onDeleted={onDeleted}
      />,
    );

    expect(screen.getByText('Delete document?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleteOne).toHaveBeenCalledTimes(1));
    expect(confirmDeleteMany).not.toHaveBeenCalled();
    expect(deleteOne).toHaveBeenCalledWith({
      connectionId: 'c1',
      dbName: 'app',
      collection: 'orders',
      filterJson: JSON.stringify({ _id: '1' }),
    });
    expect(onDeleted).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // N0.1 — a row from a `find` with an `_id`-excluding projection carries no
  // `_id`. Deleting it must refuse (via `buildIdFilter` returning null)
  // rather than falling through to `JSON.stringify({ _id: undefined })` ===
  // "{}", which would silently delete an ARBITRARY document server-side.
  it('refuses to delete a document with no _id: surfaces an error and never calls doc.deleteOne', async () => {
    const deleteOne = vi.fn(async () => ({ deletedCount: 1 }));
    const confirmDeleteMany = vi.fn();
    installAtelierMock({ doc: { deleteOne, confirmDeleteMany } });

    const onClose = vi.fn();
    const onDeleted = vi.fn();

    render(
      <DeleteConfirm
        connectionId="c1"
        dbName="app"
        collection="orders"
        docs={[{ sku: 'a' }]}
        onClose={onClose}
        onDeleted={onDeleted}
      />,
    );

    expect(screen.getByText('Delete document?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(deleteOne).not.toHaveBeenCalled();
    expect(confirmDeleteMany).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  // #91 — the Delete button no longer goes real-`disabled` while `loading`
  // (only `data-disabled`/`aria-disabled` — a focused button that goes
  // real `disabled` gets blurred to `<body>` by Chromium, with nothing to
  // restore it on a failure). Two layers now stop a second click from
  // firing a second `doc.deleteOne`: `SubmitButton`'s own click-swallow
  // (the one actually reached here — this button is Mantine, not native),
  // and `handleDelete`'s own `loading` guard behind it. This test proves
  // the outcome, not which layer; removing `handleDelete`'s guard alone
  // does not go red, because `SubmitButton` already catches it first.
  it('a second click while a delete is in flight makes only one doc.deleteOne call', async () => {
    let resolveDeleteOne!: (v: { deletedCount: number }) => void;
    const deleteOne = vi.fn(
      () => new Promise<{ deletedCount: number }>((r) => (resolveDeleteOne = r)),
    );
    installAtelierMock({ doc: { deleteOne } });

    render(
      <DeleteConfirm
        connectionId="c1"
        dbName="app"
        collection="orders"
        docs={[{ _id: '1', sku: 'a' }]}
        onClose={() => undefined}
        onDeleted={() => undefined}
      />,
    );

    const deleteBtn = screen.getByRole('button', { name: 'Delete' });
    fireEvent.click(deleteBtn);
    fireEvent.click(deleteBtn);

    expect(deleteOne).toHaveBeenCalledTimes(1);
    resolveDeleteOne({ deletedCount: 1 });
  });

  // read-only connections disable Delete outright rather than
  // letting the confirm flow run into a server-side rejection.
  it('disables Delete and never calls doc.deleteOne when readOnly is true, even on click, and shows the read-only alert', async () => {
    const deleteOne = vi.fn(async () => ({ deletedCount: 1 }));
    installAtelierMock({ doc: { deleteOne } });

    render(
      <DeleteConfirm
        connectionId="c1"
        dbName="app"
        collection="orders"
        docs={[{ _id: '1', sku: 'a' }]}
        readOnly
        onClose={() => undefined}
        onDeleted={() => undefined}
      />,
    );

    const deleteBtn = screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement;
    expect(deleteBtn.disabled).toBe(true);

    fireEvent.click(deleteBtn);

    expect(deleteOne).not.toHaveBeenCalled();
    expect(
      screen.getByText('This connection is read-only. Deleting is disabled.'),
    ).toBeTruthy();
  });
});

describe('DeleteConfirm — delete-all-matching (filter-scoped)', () => {
  it('fetches the count exactly once on mount, even under StrictMode double-invocation', async () => {
    const confirmDeleteMany = vi.fn(async () => ({ count: 3, confirmToken: 'tok-1' }));
    installAtelierMock({ doc: { confirmDeleteMany } });

    render(
      <React.StrictMode>
        <DeleteConfirm
          connectionId="c1"
          dbName="app"
          collection="orders"
          docs={[]}
          filter='{"status":"pending"}'
          onClose={() => undefined}
          onDeleted={() => undefined}
        />
      </React.StrictMode>,
    );

    await waitFor(() => expect(confirmDeleteMany).toHaveBeenCalledTimes(1));
    expect(confirmDeleteMany).toHaveBeenCalledWith({
      connectionId: 'c1',
      dbName: 'app',
      collection: 'orders',
      filterJson: '{"status":"pending"}',
    });
  });

  it('shows the fetched count in the title once resolved', async () => {
    installAtelierMock({
      doc: { confirmDeleteMany: async () => ({ count: 42, confirmToken: 'tok-1' }) },
    });

    render(
      <DeleteConfirm
        connectionId="c1"
        dbName="app"
        collection="orders"
        docs={[]}
        filter='{"status":"pending"}'
        onClose={() => undefined}
        onDeleted={() => undefined}
      />,
    );

    await waitFor(() => expect(screen.getByText(/42 matching document/)).toBeTruthy());
  });

  it('keeps Delete disabled until the collection name is typed and the count has resolved, then reuses the token from the count fetch (no second confirmDeleteMany call)', async () => {
    const confirmDeleteMany = vi.fn(async () => ({ count: 5, confirmToken: 'tok-xyz' }));
    const deleteMany = vi.fn(async () => ({ deletedCount: 5 }));
    installAtelierMock({ doc: { confirmDeleteMany, deleteMany } });

    const onClose = vi.fn();
    const onDeleted = vi.fn();

    render(
      <DeleteConfirm
        connectionId="c1"
        dbName="app"
        collection="orders"
        docs={[]}
        filter='{"status":"pending"}'
        onClose={onClose}
        onDeleted={onDeleted}
      />,
    );

    const deleteBtn = () => screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement;

    // Not yet typed the collection name, and count still resolving.
    expect(deleteBtn().disabled).toBe(true);

    // Type the collection name before the count resolves — still disabled.
    fireEvent.change(screen.getByPlaceholderText('orders'), { target: { value: 'orders' } });
    expect(deleteBtn().disabled).toBe(true);

    await waitFor(() => expect(confirmDeleteMany).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(deleteBtn().disabled).toBe(false));

    fireEvent.click(deleteBtn());

    await waitFor(() => expect(deleteMany).toHaveBeenCalledTimes(1));
    expect(deleteMany).toHaveBeenCalledWith({
      connectionId: 'c1',
      dbName: 'app',
      collection: 'orders',
      filterJson: '{"status":"pending"}',
      confirmToken: 'tok-xyz',
    });
    // No second confirmDeleteMany round trip on click.
    expect(confirmDeleteMany).toHaveBeenCalledTimes(1);
    expect(onDeleted).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps Delete disabled when the matched count resolves to 0, even after typing the collection name', async () => {
    const confirmDeleteMany = vi.fn(async () => ({ count: 0, confirmToken: 'tok-empty' }));
    const deleteMany = vi.fn();
    installAtelierMock({ doc: { confirmDeleteMany, deleteMany } });

    render(
      <DeleteConfirm
        connectionId="c1"
        dbName="app"
        collection="orders"
        docs={[]}
        filter='{"status":"nonexistent"}'
        onClose={() => undefined}
        onDeleted={() => undefined}
      />,
    );

    const deleteBtn = () => screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement;

    await waitFor(() => expect(confirmDeleteMany).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByPlaceholderText('orders'), { target: { value: 'orders' } });

    // Count resolved to 0 — even with the collection name typed correctly,
    // there is nothing to delete, so the button must stay disabled.
    expect(deleteBtn().disabled).toBe(true);
    fireEvent.click(deleteBtn());
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('states the pending delete is within the undo limit at 999 matches', async () => {
    installAtelierMock({
      doc: { confirmDeleteMany: async () => ({ count: 999, confirmToken: 'tok-1' }) },
    });

    render(
      <DeleteConfirm
        connectionId="c1"
        dbName="app"
        collection="orders"
        docs={[]}
        filter='{"status":"pending"}'
        onClose={() => undefined}
        onDeleted={() => undefined}
      />,
    );

    await waitFor(() => expect(screen.getByText(/within the 1,000-document undo limit/i)).toBeTruthy());
    expect(screen.queryByText(/cannot be undone/)).toBeNull();
  });

  it('states the pending delete is beyond the undo limit at 1001 matches', async () => {
    installAtelierMock({
      doc: { confirmDeleteMany: async () => ({ count: 1001, confirmToken: 'tok-1' }) },
    });

    render(
      <DeleteConfirm
        connectionId="c1"
        dbName="app"
        collection="orders"
        docs={[]}
        filter='{"status":"pending"}'
        onClose={() => undefined}
        onDeleted={() => undefined}
      />,
    );

    await waitFor(() => expect(screen.getByText(/cannot be undone/)).toBeTruthy());
  });

  it('surfaces a confirmDeleteMany rejection via the alert and leaves Delete disabled', async () => {
    installAtelierMock({
      doc: {
        confirmDeleteMany: async () => {
          throw new Error('boom');
        },
      },
    });

    render(
      <DeleteConfirm
        connectionId="c1"
        dbName="app"
        collection="orders"
        docs={[]}
        filter='{"status":"pending"}'
        onClose={() => undefined}
        onDeleted={() => undefined}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('orders'), { target: { value: 'orders' } });

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect((screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

// W14 §9 — `deleteMany` sends only the filter, so with a collation on the tab
// it would delete a different set than the one on screen.
describe('DeleteConfirm — a collation refuses a delete by filter', () => {
  it('disables Delete, says why, and asks for no count: a count by the filter alone would mislead', async () => {
    const deleteMany = vi.fn();
    const confirmDeleteMany = vi.fn(async () => ({ count: 3, confirmToken: 'tok-1' }));
    installAtelierMock({ doc: { confirmDeleteMany, deleteMany } });

    render(
      <DeleteConfirm
        connectionId="c1"
        dbName="app"
        collection="orders"
        docs={[]}
        filter='{"name":"a"}'
        collation='{"locale":"en","strength":2}'
        onClose={() => undefined}
        onDeleted={() => undefined}
      />,
    );

    expect(
      screen.getByText('Clear the collation to delete by filter: it would change which documents match.'),
    ).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Delete matching documents?' })).toBeTruthy();
    expect(screen.queryByText('Counting matching documents…')).toBeNull();
    await Promise.resolve();
    expect(confirmDeleteMany).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Type orders to confirm' }), {
      target: { value: 'orders' },
    });
    const del = screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    fireEvent.click(del);
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('a blank collation, or a single-document delete, is not refused', async () => {
    installAtelierMock({ doc: { confirmDeleteMany: async () => ({ count: 3, confirmToken: 'tok-1' }) } });
    const { unmount } = render(
      <DeleteConfirm
        connectionId="c1"
        dbName="app"
        collection="orders"
        docs={[]}
        filter='{"name":"a"}'
        collation="  "
        onClose={() => undefined}
        onDeleted={() => undefined}
      />,
    );
    await waitFor(() => expect(screen.getByText(/3 matching documents/)).toBeTruthy());
    fireEvent.change(screen.getByRole('textbox', { name: 'Type orders to confirm' }), {
      target: { value: 'orders' },
    });
    expect((screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(false);
    unmount();

    render(
      <DeleteConfirm
        connectionId="c1"
        dbName="app"
        collection="orders"
        docs={[{ _id: '1' }]}
        collation='{"locale":"en"}'
        onClose={() => undefined}
        onDeleted={() => undefined}
      />,
    );
    expect(screen.queryByText(/Clear the collation/)).toBeNull();
    expect((screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

// W14 §9 — a hint can name a sparse index, so the documents on screen can be
// fewer than the filter matches, and `deleteMany` sends only the filter.
describe('DeleteConfirm — a hint refuses a delete by filter', () => {
  const HINT_TEXT = 'Clear the hint to delete by filter: a hinted sparse index can show fewer documents than the filter matches.';

  it('disables Delete, says why, and asks for no count', async () => {
    const deleteMany = vi.fn();
    const confirmDeleteMany = vi.fn(async () => ({ count: 3, confirmToken: 'tok-1' }));
    installAtelierMock({ doc: { confirmDeleteMany, deleteMany } });
    render(
      <DeleteConfirm
        connectionId="c1"
        dbName="app"
        collection="orders"
        docs={[]}
        filter='{"name":"a"}'
        hint="name_1_sparse"
        onClose={() => undefined}
        onDeleted={() => undefined}
      />,
    );

    expect(screen.getByText(HINT_TEXT)).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Delete matching documents?' })).toBeTruthy();
    expect(screen.queryByText('Counting matching documents…')).toBeNull();
    await Promise.resolve();
    expect(confirmDeleteMany).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Type orders to confirm' }), {
      target: { value: 'orders' },
    });
    const del = screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    fireEvent.click(del);
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('a blank hint, or a single-document delete, is not refused', async () => {
    installAtelierMock({ doc: { confirmDeleteMany: async () => ({ count: 3, confirmToken: 'tok-1' }) } });
    const { unmount } = render(
      <DeleteConfirm
        connectionId="c1"
        dbName="app"
        collection="orders"
        docs={[]}
        filter='{"name":"a"}'
        hint="  "
        onClose={() => undefined}
        onDeleted={() => undefined}
      />,
    );
    await waitFor(() => expect(screen.getByText(/3 matching documents/)).toBeTruthy());
    fireEvent.change(screen.getByRole('textbox', { name: 'Type orders to confirm' }), {
      target: { value: 'orders' },
    });
    expect((screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(false);
    unmount();

    render(
      <DeleteConfirm
        connectionId="c1"
        dbName="app"
        collection="orders"
        docs={[{ _id: '1' }]}
        hint="name_1_sparse"
        onClose={() => undefined}
        onDeleted={() => undefined}
      />,
    );
    expect(screen.queryByText(/Clear the hint/)).toBeNull();
    expect((screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('DeleteConfirm — Undo hand-off', () => {
  it('passes the Reversible entry id of a single-document delete to onDeleted', async () => {
    installAtelierMock({ doc: { deleteOne: async () => ({ deletedCount: 1, auditId: 'a1' }) } });
    const onDeleted = vi.fn();

    render(
      <DeleteConfirm
        connectionId="c1"
        dbName="app"
        collection="orders"
        docs={[{ _id: '1' }]}
        onClose={() => {}}
        onDeleted={onDeleted}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith('a1', 'Document deleted'));
  });

  it('says nothing was deleted, rather than claiming a delete, when deleteOne matched nothing', async () => {
    installAtelierMock({ doc: { deleteOne: async () => ({ deletedCount: 0 }) } });
    const onDeleted = vi.fn();

    render(
      <DeleteConfirm
        connectionId="c1"
        dbName="app"
        collection="orders"
        docs={[{ _id: '1' }]}
        onClose={() => {}}
        onDeleted={onDeleted}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(onDeleted).toHaveBeenCalledWith(undefined, 'Nothing was deleted: the document was already gone'),
    );
  });

  it('passes the Reversible entry id of a delete-all-matching to onDeleted', async () => {
    const confirmDeleteMany = vi.fn(async () => ({ count: 5, confirmToken: 'tok-xyz' }));
    const deleteMany = vi.fn(async () => ({ deletedCount: 5, auditId: 'a2' }));
    installAtelierMock({ doc: { confirmDeleteMany, deleteMany } });
    const onDeleted = vi.fn();

    render(
      <DeleteConfirm
        connectionId="c1"
        dbName="app"
        collection="orders"
        docs={[]}
        filter='{"status":"pending"}'
        onClose={() => {}}
        onDeleted={onDeleted}
      />,
    );

    await waitFor(() => expect(confirmDeleteMany).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByPlaceholderText('orders'), { target: { value: 'orders' } });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith('a2', '5 documents deleted'));
  });

  it('uses the singular for a delete-all that matched exactly one document', async () => {
    const confirmDeleteMany = vi.fn(async () => ({ count: 1, confirmToken: 'tok-xyz' }));
    const deleteMany = vi.fn(async () => ({ deletedCount: 1 }));
    installAtelierMock({ doc: { confirmDeleteMany, deleteMany } });
    const onDeleted = vi.fn();

    render(
      <DeleteConfirm
        connectionId="c1"
        dbName="app"
        collection="orders"
        docs={[]}
        filter='{"status":"pending"}'
        onClose={() => {}}
        onDeleted={onDeleted}
      />,
    );

    await waitFor(() => expect(confirmDeleteMany).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByPlaceholderText('orders'), { target: { value: 'orders' } });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(undefined, '1 document deleted'));
  });
});
});

// The sample behind field suggestions is cached per collection. The dialog
// names the collection it deleted from with its own props: when it completes,
// the Focused Tab may be a different collection or none, so the caller can't.
describe('DeleteConfirm — field-suggestion sample', () => {
  const invalidate = vi.mocked(invalidateSampleSchemaCache);
  const renderSingle = (onDeleted = vi.fn(), docs: unknown[] = [{ _id: '1', sku: 'a' }]) =>
    render(
      <DeleteConfirm
        connectionId="c1"
        dbName="app"
        collection="orders"
        docs={docs}
        onClose={() => {}}
        onDeleted={onDeleted}
      />,
    );
  const renderMany = (onDeleted = vi.fn()) =>
    render(
      <DeleteConfirm
        connectionId="c1"
        dbName="app"
        collection="orders"
        docs={[]}
        filter='{"status":"pending"}'
        onClose={() => {}}
        onDeleted={onDeleted}
      />,
    );
  const confirmMany = async (confirmDeleteMany: ReturnType<typeof vi.fn>) => {
    await waitFor(() => expect(confirmDeleteMany).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByPlaceholderText('orders'), { target: { value: 'orders' } });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  };

  it('is dropped for this collection once a single-document delete lands', async () => {
    installAtelierMock({ doc: { deleteOne: vi.fn(async () => ({ deletedCount: 1 })) } });
    const onDeleted = vi.fn();
    renderSingle(onDeleted);

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(invalidate).toHaveBeenCalledExactlyOnceWith('c1', 'app', 'orders');
  });

  it('is dropped for this collection once a delete-all-matching lands', async () => {
    const confirmDeleteMany = vi.fn(async () => ({ count: 5, confirmToken: 'tok' }));
    installAtelierMock({
      doc: { confirmDeleteMany, deleteMany: vi.fn(async () => ({ deletedCount: 5, auditId: 'a2' })) },
    });
    const onDeleted = vi.fn();
    renderMany(onDeleted);

    await confirmMany(confirmDeleteMany);

    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(invalidate).toHaveBeenCalledExactlyOnceWith('c1', 'app', 'orders');
  });

  it('is dropped when a delete-all-matching fails, since deleteMany can stop part-way', async () => {
    const confirmDeleteMany = vi.fn(async () => ({ count: 5, confirmToken: 'tok' }));
    const deleteMany = vi.fn(async () => {
      throw { code: 'MONGO_OP', message: 'connection lost' };
    });
    installAtelierMock({ doc: { confirmDeleteMany, deleteMany } });
    const onDeleted = vi.fn();
    renderMany(onDeleted);

    await confirmMany(confirmDeleteMany);

    expect((await screen.findByRole('alert')).textContent).toMatch(/connection lost/);
    expect(onDeleted).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledExactlyOnceWith('c1', 'app', 'orders');
  });

  it('is kept when no delete was sent: a document with no _id', async () => {
    installAtelierMock({ doc: { deleteOne: vi.fn() } });
    renderSingle(vi.fn(), [{ sku: 'a' }]);

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await screen.findByRole('alert');
    expect(invalidate).not.toHaveBeenCalled();
  });
});
