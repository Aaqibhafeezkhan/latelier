import { describe, it, expect, afterEach, vi } from 'vitest';
import { notifications } from '@mantine/notifications';
import { render, screen, fireEvent, waitFor } from '../helpers/render';
import { UpdateConfirm } from '../../src/pages/Workspace/UpdateConfirm';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import { invalidateSampleSchemaCache } from '../../src/features/fieldSuggestions/sources/sampleSchemaSource';

// Mocked at the exact module UpdateConfirm imports; the rest stays real
// because its editor reaches the suggestion sources through their barrel.
vi.mock('../../src/features/fieldSuggestions/sources/sampleSchemaSource', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/features/fieldSuggestions/sources/sampleSchemaSource')>()),
  invalidateSampleSchemaCache: vi.fn(),
}));

afterEach(() => {
  uninstallAtelierMock();
  notifications.clean();
  vi.restoreAllMocks();
  vi.mocked(invalidateSampleSchemaCache).mockClear();
});

const reviewBtn = () => screen.getByRole('button', { name: /Review|Counting…/ }) as HTMLButtonElement;
const updateBtn = () => screen.queryByRole('button', { name: /Update|Updating…/ }) as HTMLButtonElement | null;
const updateJsonInput = () => screen.getByLabelText('Update document') as HTMLTextAreaElement;

describe('UpdateConfirm', () => {
  it('Update is unavailable until Review resolves and the collection name is typed', async () => {
    const confirmUpdateMany = vi.fn(async () => ({ count: 5, confirmToken: 'tok-1' }));
    installAtelierMock({ doc: { confirmUpdateMany } });

    render(
      <UpdateConfirm
        connectionId="c1"
        dbName="app"
        collection="orders"
        filter='{"status":"pending"}'
        onClose={() => undefined}
        onUpdated={() => undefined}
      />,
    );

    // No Update button before Review has ever run.
    expect(updateBtn()).toBeNull();

    fireEvent.change(updateJsonInput(), { target: { value: '{"$set":{"status":"active"}}' } });
    fireEvent.click(reviewBtn());

    await waitFor(() => expect(confirmUpdateMany).toHaveBeenCalledTimes(1));
    expect(confirmUpdateMany).toHaveBeenCalledWith({
      connectionId: 'c1',
      dbName: 'app',
      collection: 'orders',
      filterJson: '{"status":"pending"}',
      updateJson: '{"$set":{"status":"active"}}',
    });
    await waitFor(() => expect(screen.getByText(/5 matching document/)).toBeTruthy());
    expect(updateBtn()!.disabled).toBe(true);

    fireEvent.change(screen.getByPlaceholderText('orders'), { target: { value: 'orders' } });
    expect(updateBtn()!.disabled).toBe(false);
  });

  it('editing the update body after Review clears the review and hides Update again', async () => {
    const confirmUpdateMany = vi.fn(async () => ({ count: 5, confirmToken: 'tok-1' }));
    installAtelierMock({ doc: { confirmUpdateMany } });

    render(
      <UpdateConfirm
        connectionId="c1"
        dbName="app"
        collection="orders"
        filter='{"status":"pending"}'
        onClose={() => undefined}
        onUpdated={() => undefined}
      />,
    );

    fireEvent.change(updateJsonInput(), { target: { value: '{"$set":{"status":"active"}}' } });
    fireEvent.click(reviewBtn());
    await waitFor(() => expect(updateBtn()).not.toBeNull());
    fireEvent.change(screen.getByPlaceholderText('orders'), { target: { value: 'orders' } });
    expect(updateBtn()!.disabled).toBe(false);

    // Edit the buffer — the reviewed token described a different update.
    fireEvent.change(updateJsonInput(), { target: { value: '{"$set":{"status":"other"}}' } });

    expect(updateBtn()).toBeNull();
  });

  // A Review response used to arm Update with whatever text `submitted`
  // closed over, even when the buffer had since been edited while the count
  // was still in flight. The dialog's own promise (`This cannot be undone`)
  // that a stale token can never authorize a different update only holds if
  // a response describing a body the user is no longer looking at is dropped
  // rather than accepted.
  it('editing the body while Review is in flight drops the stale response instead of arming Update', async () => {
    let resolveConfirm!: (v: { count: number; confirmToken: string }) => void;
    const confirmUpdateMany = vi.fn(
      () => new Promise<{ count: number; confirmToken: string }>((r) => (resolveConfirm = r)),
    );
    installAtelierMock({ doc: { confirmUpdateMany } });

    render(
      <UpdateConfirm
        connectionId="c1"
        dbName="app"
        collection="orders"
        filter='{"status":"pending"}'
        onClose={() => undefined}
        onUpdated={() => undefined}
      />,
    );

    fireEvent.change(updateJsonInput(), { target: { value: '{"$set":{"status":"active"}}' } });
    fireEvent.click(reviewBtn());
    await waitFor(() => expect(confirmUpdateMany).toHaveBeenCalledTimes(1));

    // Edit the buffer while the count request for the OLD body is still
    // in flight.
    fireEvent.change(updateJsonInput(), { target: { value: '{"$set":{"status":"edited-mid-flight"}}' } });

    // The now-late response describes the body the user has since moved
    // away from.
    resolveConfirm({ count: 5, confirmToken: 'tok-1' });

    // `reviewing` clears (the Review button's label returns), but the count
    // for the stale body must never appear and Update must never render.
    await waitFor(() => expect(reviewBtn().textContent).toBe('Review'));
    expect(screen.queryByText(/5 matching document/)).toBeNull();
    expect(updateBtn()).toBeNull();
  });

  it('editing the filter/target this dialog is scoped to while Review is in flight also drops the stale response', async () => {
    let resolveConfirm!: (v: { count: number; confirmToken: string }) => void;
    const confirmUpdateMany = vi.fn(
      () => new Promise<{ count: number; confirmToken: string }>((r) => (resolveConfirm = r)),
    );
    installAtelierMock({ doc: { confirmUpdateMany } });

    const { rerender } = render(
      <UpdateConfirm
        connectionId="c1"
        dbName="app"
        collection="orders"
        filter='{"status":"pending"}'
        onClose={() => undefined}
        onUpdated={() => undefined}
      />,
    );

    fireEvent.change(updateJsonInput(), { target: { value: '{"$set":{"status":"active"}}' } });
    fireEvent.click(reviewBtn());
    await waitFor(() => expect(confirmUpdateMany).toHaveBeenCalledTimes(1));

    // The tab's current filter changes underneath the dialog while the count
    // for the OLD filter is still in flight (DialogStack re-derives `filter`
    // from `currentFilterJson` on every render of the active tab's state).
    rerender(
      <UpdateConfirm
        connectionId="c1"
        dbName="app"
        collection="orders"
        filter='{"status":"shipped"}'
        onClose={() => undefined}
        onUpdated={() => undefined}
      />,
    );

    resolveConfirm({ count: 5, confirmToken: 'tok-1' });

    await waitFor(() => expect(reviewBtn().textContent).toBe('Review'));
    expect(screen.queryByText(/5 matching document/)).toBeNull();
    expect(updateBtn()).toBeNull();
  });

  it('sends updateMany with the exact updateJson and confirmToken the Review call returned, and hands the auditId to onUpdated', async () => {
    const confirmUpdateMany = vi.fn(async () => ({ count: 2, confirmToken: 'tok-xyz' }));
    const updateMany = vi.fn(async () => ({ matchedCount: 2, modifiedCount: 2, auditId: 'a1' }));
    installAtelierMock({ doc: { confirmUpdateMany, updateMany } });

    const onClose = vi.fn();
    const onUpdated = vi.fn();

    render(
      <UpdateConfirm
        connectionId="c1"
        dbName="app"
        collection="orders"
        filter='{"status":"pending"}'
        onClose={onClose}
        onUpdated={onUpdated}
      />,
    );

    fireEvent.change(updateJsonInput(), { target: { value: '{"$set":{"status":"active"}}' } });
    fireEvent.click(reviewBtn());
    await waitFor(() => expect(updateBtn()).not.toBeNull());
    fireEvent.change(screen.getByPlaceholderText('orders'), { target: { value: 'orders' } });
    fireEvent.click(updateBtn()!);

    await waitFor(() => expect(updateMany).toHaveBeenCalledTimes(1));
    expect(updateMany).toHaveBeenCalledWith({
      connectionId: 'c1',
      dbName: 'app',
      collection: 'orders',
      filterJson: '{"status":"pending"}',
      updateJson: '{"$set":{"status":"active"}}',
      confirmToken: 'tok-xyz',
    });
    expect(onUpdated).toHaveBeenCalledWith('a1', '2 matched, 2 modified');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('states the undo fact once Review resolves — within the limit, then above it', async () => {
    const confirmUpdateMany = vi.fn(async () => ({ count: 999, confirmToken: 'tok-1' }));
    installAtelierMock({ doc: { confirmUpdateMany } });

    render(
      <UpdateConfirm
        connectionId="c1"
        dbName="app"
        collection="orders"
        filter='{"status":"pending"}'
        onClose={() => undefined}
        onUpdated={() => undefined}
      />,
    );

    // No claim before Review has run — the count isn't known yet.
    expect(screen.queryByText(/undo limit/)).toBeNull();

    fireEvent.change(updateJsonInput(), { target: { value: '{"$set":{"status":"active"}}' } });
    fireEvent.click(reviewBtn());

    await waitFor(() => expect(screen.getByText(/within the 1,000-document undo limit/i)).toBeTruthy());
    expect(screen.queryByText(/cannot be undone/)).toBeNull();
  });

  it('states the update is beyond the undo limit at 1001 matches', async () => {
    const confirmUpdateMany = vi.fn(async () => ({ count: 1001, confirmToken: 'tok-1' }));
    installAtelierMock({ doc: { confirmUpdateMany } });

    render(
      <UpdateConfirm
        connectionId="c1"
        dbName="app"
        collection="orders"
        filter='{"status":"pending"}'
        onClose={() => undefined}
        onUpdated={() => undefined}
      />,
    );

    fireEvent.change(updateJsonInput(), { target: { value: '{"$set":{"status":"active"}}' } });
    fireEvent.click(reviewBtn());

    await waitFor(() => expect(screen.getByText(/cannot be undone/)).toBeTruthy());
  });

  it('disables Review outright when readOnly is true and shows the read-only alert', () => {
    const confirmUpdateMany = vi.fn();
    installAtelierMock({ doc: { confirmUpdateMany } });

    render(
      <UpdateConfirm
        connectionId="c1"
        dbName="app"
        collection="orders"
        filter='{"status":"pending"}'
        readOnly
        onClose={() => undefined}
        onUpdated={() => undefined}
      />,
    );

    fireEvent.change(updateJsonInput(), { target: { value: '{"$set":{"status":"active"}}' } });
    expect(reviewBtn().disabled).toBe(true);
    fireEvent.click(reviewBtn());
    expect(confirmUpdateMany).not.toHaveBeenCalled();
    expect(screen.getByText('This connection is read-only. Updating is disabled.')).toBeTruthy();
  });

  // W14 §9 — `updateMany` sends only the filter, so with a collation on the
  // tab it would update a different set than the one on screen.
  it('disables Review and says why when the tab has a collation', () => {
    const confirmUpdateMany = vi.fn();
    installAtelierMock({ doc: { confirmUpdateMany } });

    render(
      <UpdateConfirm
        connectionId="c1"
        dbName="app"
        collection="orders"
        filter='{"name":"a"}'
        collation='{"locale":"en","strength":2}'
        onClose={() => undefined}
        onUpdated={() => undefined}
      />,
    );

    fireEvent.change(updateJsonInput(), { target: { value: '{"$set":{"status":"active"}}' } });
    expect(reviewBtn().disabled).toBe(true);
    fireEvent.click(reviewBtn());
    expect(confirmUpdateMany).not.toHaveBeenCalled();
    expect(
      screen.getByText('Clear the collation to update by filter: it would change which documents match.'),
    ).toBeTruthy();
  });

  it('a blank collation leaves Review available', () => {
    installAtelierMock({ doc: { confirmUpdateMany: vi.fn() } });
    render(
      <UpdateConfirm
        connectionId="c1"
        dbName="app"
        collection="orders"
        filter='{"name":"a"}'
        collation=" "
        onClose={() => undefined}
        onUpdated={() => undefined}
      />,
    );
    fireEvent.change(updateJsonInput(), { target: { value: '{"$set":{"status":"active"}}' } });
    expect(reviewBtn().disabled).toBe(false);
    expect(screen.queryByText(/Clear the collation/)).toBeNull();
  });

  // W14 §9 — a hint can name a sparse index, so the documents on screen can
  // be fewer than the filter matches, and `updateMany` sends only the filter.
  it('disables Review and says why when the tab has a hint; a blank hint does not', () => {
    const confirmUpdateMany = vi.fn();
    installAtelierMock({ doc: { confirmUpdateMany } });
    const { unmount } = render(
      <UpdateConfirm
        connectionId="c1"
        dbName="app"
        collection="orders"
        filter='{"name":"a"}'
        hint='{"name":1}'
        onClose={() => undefined}
        onUpdated={() => undefined}
      />,
    );
    fireEvent.change(updateJsonInput(), { target: { value: '{"$set":{"status":"active"}}' } });
    expect(reviewBtn().disabled).toBe(true);
    fireEvent.click(reviewBtn());
    expect(confirmUpdateMany).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        'Clear the hint to update by filter: a hinted sparse index can show fewer documents than the filter matches.',
      ),
    ).toBeTruthy();
    unmount();

    render(
      <UpdateConfirm
        connectionId="c1"
        dbName="app"
        collection="orders"
        filter='{"name":"a"}'
        hint=" "
        onClose={() => undefined}
        onUpdated={() => undefined}
      />,
    );
    fireEvent.change(updateJsonInput(), { target: { value: '{"$set":{"status":"active"}}' } });
    expect(reviewBtn().disabled).toBe(false);
    expect(screen.queryByText(/Clear the hint/)).toBeNull();
  });

  it('a VALIDATION refusal from confirmUpdateMany surfaces via the alert, with no Update button', async () => {
    installAtelierMock({
      doc: {
        confirmUpdateMany: async () => {
          throw new Error('updateJson must be an update-operator document');
        },
      },
    });

    render(
      <UpdateConfirm
        connectionId="c1"
        dbName="app"
        collection="orders"
        filter='{"status":"pending"}'
        onClose={() => undefined}
        onUpdated={() => undefined}
      />,
    );

    fireEvent.change(updateJsonInput(), { target: { value: '{"status":"active"}' } });
    fireEvent.click(reviewBtn());

    await waitFor(() => expect(screen.getByText('updateJson must be an update-operator document')).toBeTruthy());
    expect(updateBtn()).toBeNull();
  });
});

// The sample behind field suggestions and the Update drawer's type warning is
// cached per collection. The dialog names the collection it updated with its
// own props: when it completes, the Focused Tab may be a different collection
// or none, so the caller can't.
describe('UpdateConfirm — field-suggestion sample', () => {
  const invalidate = vi.mocked(invalidateSampleSchemaCache);

  function mount(updateMany: ReturnType<typeof vi.fn>) {
    installAtelierMock({
      doc: { confirmUpdateMany: vi.fn(async () => ({ count: 2, confirmToken: 'tok' })), updateMany: updateMany as never },
    });
    const onUpdated = vi.fn();
    render(
      <UpdateConfirm
        connectionId="c1"
        dbName="app"
        collection="orders"
        filter='{"status":"pending"}'
        onClose={() => undefined}
        onUpdated={onUpdated}
      />,
    );
    return { onUpdated };
  }
  const review = async () => {
    fireEvent.change(updateJsonInput(), { target: { value: '{"$set":{"status":"active"}}' } });
    fireEvent.click(reviewBtn());
    await waitFor(() => expect(updateBtn()).not.toBeNull());
    fireEvent.change(screen.getByPlaceholderText('orders'), { target: { value: 'orders' } });
  };

  it('is dropped for this collection once the update lands', async () => {
    const { onUpdated } = mount(vi.fn(async () => ({ matchedCount: 2, modifiedCount: 2, auditId: 'a1' })));
    await review();

    fireEvent.click(updateBtn()!);

    await waitFor(() => expect(onUpdated).toHaveBeenCalledTimes(1));
    expect(invalidate).toHaveBeenCalledExactlyOnceWith('c1', 'app', 'orders');
  });

  // updateMany is not atomic across documents: a failure can leave the
  // earlier ones modified, so a rejected update drops the sample too.
  it('is dropped when the update fails, since earlier documents may already be modified', async () => {
    const { onUpdated } = mount(
      vi.fn(async () => {
        throw { code: 'MONGO_OP', message: 'Cannot apply $inc to a value of non-numeric type' };
      }),
    );
    await review();

    fireEvent.click(updateBtn()!);

    expect((await screen.findByRole('alert')).textContent).toMatch(/non-numeric/);
    expect(onUpdated).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledExactlyOnceWith('c1', 'app', 'orders');
  });

  it('is kept while the update is only being reviewed', async () => {
    mount(vi.fn());

    await review();

    expect(invalidate).not.toHaveBeenCalled();
  });
});
