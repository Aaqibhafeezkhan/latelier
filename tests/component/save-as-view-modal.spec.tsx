import { describe, it, expect, afterEach, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { act, render, screen, fireEvent, waitFor } from '../helpers/render';
import { SaveAsViewModal } from '../../src/pages/Workspace/Aggregation/SaveAsViewModal';
import { stagesToPipelineJson } from '../../src/pages/Workspace/Aggregation/pipeline';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { CollectionCreateInput, Stage } from '@shared/types';

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

const STAGES: Stage[] = [
  { id: 1, op: '$match', body: '{"status": "open"}', enabled: true },
  { id: 2, op: '$limit', body: '10', enabled: false },
];

function renderModal(
  stages: Stage[] = STAGES,
  create = vi.fn(async (input: { collection: string }) => ({ name: input.collection })),
) {
  installAtelierMock({ collection: { create } });
  const onClose = vi.fn();
  const onCreated = vi.fn();
  render(
    <SaveAsViewModal
      connectionId="c1"
      dbName="shop"
      collection="orders"
      stages={stages}
      onClose={onClose}
      onCreated={onCreated}
    />,
  );
  return { create, onClose, onCreated };
}

describe('SaveAsViewModal', () => {
  it('creates a view on the source collection, in the same database, from the enabled stages', async () => {
    const { create, onCreated, onClose } = renderModal();

    await userEvent.type(screen.getByLabelText('View name'), 'open_orders');
    fireEvent.click(screen.getByRole('button', { name: 'Create view' }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        connectionId: 'c1',
        dbName: 'shop',
        collection: 'open_orders',
        options: { viewOn: 'orders', pipeline: stagesToPipelineJson(STAGES) },
      }),
    );
    expect(onCreated).toHaveBeenCalledWith('open_orders');
    expect(onClose).toHaveBeenCalled();
  });

  it('refuses an enabled write stage inline, without a call', async () => {
    const { create } = renderModal([...STAGES, { id: 3, op: '$out', body: '"elsewhere"', enabled: true }]);

    await userEvent.type(screen.getByLabelText('View name'), 'v');
    fireEvent.click(screen.getByRole('button', { name: 'Create view' }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/\$out/);
    expect(create).not.toHaveBeenCalled();
  });

  it('ignores a disabled write stage', async () => {
    const { create } = renderModal([...STAGES, { id: 3, op: '$merge', body: '{"into":"x"}', enabled: false }]);

    await userEvent.type(screen.getByLabelText('View name'), 'v');
    fireEvent.click(screen.getByRole('button', { name: 'Create view' }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  });

  it('shows a stage that does not parse inline, without a call', async () => {
    const { create } = renderModal([{ id: 4, op: '$match', body: '{ broken', enabled: true }]);

    await userEvent.type(screen.getByLabelText('View name'), 'v');
    fireEvent.click(screen.getByRole('button', { name: 'Create view' }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/stage 1 \(\$match\): invalid EJSON — /);
    expect(create).not.toHaveBeenCalled();
  });

  it('shows the server refusal inline and stays open', async () => {
    const create = vi.fn(async () => {
      throw { code: 'CONFLICT', message: 'collection "v" already exists' };
    });
    installAtelierMock({ collection: { create } });
    const onClose = vi.fn();
    render(
      <SaveAsViewModal connectionId="c1" dbName="shop" collection="orders" stages={STAGES} onClose={onClose} onCreated={vi.fn()} />,
    );

    await userEvent.type(screen.getByLabelText('View name'), 'v');
    fireEvent.click(screen.getByRole('button', { name: 'Create view' }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/already exists/);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Escape with a typed name asks to discard it', async () => {
    const { onClose } = renderModal();

    await userEvent.type(screen.getByLabelText('View name'), 'half');
    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(await screen.findByRole('dialog', { name: 'Discard changes?' })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Escape on an untouched dialog closes it without asking', async () => {
    const { onClose } = renderModal();

    fireEvent.keyDown(document.body, { key: 'Escape' });

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(screen.queryByRole('dialog', { name: 'Discard changes?' })).toBeNull();
  });

  // A dismissal mid-create would let the user reopen the dialog and type a new
  // name, and the first create's completion would then close that one.
  it('does not close or ask while the view is being created', async () => {
    let resolve!: () => void;
    const create = vi.fn(() => new Promise<{ name: string }>((r) => (resolve = () => r({ name: 'open_orders' }))));
    const { onClose, onCreated } = renderModal(STAGES, create);
    await userEvent.type(screen.getByLabelText('View name'), 'open_orders');

    fireEvent.click(screen.getByRole('button', { name: 'Create view' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => {});
    expect(screen.queryByRole('dialog', { name: 'Discard changes?' })).toBeNull();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await act(async () => {});
    expect(screen.queryByRole('dialog', { name: 'Discard changes?' })).toBeNull();

    expect(onClose).not.toHaveBeenCalled();
    await act(async () => resolve());
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('open_orders'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  describe('duplicating a view (pipelineJson + initialName)', () => {
    const PIPELINE = '[{"$match":{"_id":{"$oid":"64b64c0b4d3e7a0001a1b2c3"}}},{"$out":"kept_verbatim"}]';
    function renderDuplicate(create: (input: { collection: string }) => Promise<{ name: string }>) {
      installAtelierMock({ collection: { create } });
      const onClose = vi.fn();
      const onCreated = vi.fn();
      render(
        <SaveAsViewModal
          connectionId="c1"
          dbName="shop"
          collection="orders"
          pipelineJson={PIPELINE}
          initialName="open_orders_copy"
          title="Duplicate view"
          onClose={onClose}
          onCreated={onCreated}
        />,
      );
      return { onClose, onCreated };
    }

    it('prefills the name and creates with the source and pipeline verbatim', async () => {
      const create = vi.fn(async (input: { collection: string }) => ({ name: input.collection }));
      const { onCreated } = renderDuplicate(create);

      expect((screen.getByLabelText('View name') as HTMLInputElement).value).toBe('open_orders_copy');
      expect(screen.getByText('Duplicate view')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Create view' }));

      await waitFor(() =>
        expect(create).toHaveBeenCalledWith({
          connectionId: 'c1',
          dbName: 'shop',
          collection: 'open_orders_copy',
          options: { viewOn: 'orders', pipeline: PIPELINE },
        }),
      );
      expect(onCreated).toHaveBeenCalledWith('open_orders_copy');
    });

    it('sends the source view\'s collation with the create, and none when it has none', async () => {
      const COLLATION = '{"locale":"fr","strength":{"$numberInt":"2"}}';
      for (const collation of [COLLATION, undefined]) {
        const create = vi.fn(async (input: CollectionCreateInput) => ({ name: input.collection }));
        installAtelierMock({ collection: { create } });
        const { unmount } = render(
          <SaveAsViewModal
            connectionId="c1"
            dbName="shop"
            collection="orders"
            pipelineJson={PIPELINE}
            initialName="v_copy"
            collation={collation}
            onClose={vi.fn()}
            onCreated={vi.fn()}
          />,
        );
        fireEvent.click(screen.getByRole('button', { name: 'Create view' }));
        await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
        const options = create.mock.calls[0]![0].options as Record<string, unknown>;
        expect(options).toEqual({ viewOn: 'orders', pipeline: PIPELINE, ...(collation ? { collation } : {}) });
        expect('collation' in options).toBe(collation !== undefined);
        unmount();
        uninstallAtelierMock();
      }
    });

    it('shows a name conflict inline and stays open', async () => {
      const create = vi.fn(async (): Promise<{ name: string }> => {
        throw { code: 'CONFLICT', message: 'a collection \'shop.open_orders_copy\' already exists' };
      });
      const { onClose } = renderDuplicate(create);

      fireEvent.click(screen.getByRole('button', { name: 'Create view' }));

      expect((await screen.findByRole('alert')).textContent).toMatch(/already exists/);
      expect(onClose).not.toHaveBeenCalled();
    });

    it('Escape on the untouched prefill closes without asking', async () => {
      const { onClose } = renderDuplicate(vi.fn(async (input: { collection: string }) => ({ name: input.collection })));

      fireEvent.keyDown(document.body, { key: 'Escape' });

      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(screen.queryByRole('dialog', { name: 'Discard changes?' })).toBeNull();
    });

    it('Escape after editing the prefill asks to discard', async () => {
      const { onClose } = renderDuplicate(vi.fn(async (input: { collection: string }) => ({ name: input.collection })));

      await userEvent.type(screen.getByLabelText('View name'), 'x');
      fireEvent.keyDown(document.body, { key: 'Escape' });

      expect(await screen.findByRole('dialog', { name: 'Discard changes?' })).toBeTruthy();
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  it('throws when given neither stages nor pipelineJson', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      render(<SaveAsViewModal connectionId="c1" dbName="shop" collection="orders" onClose={vi.fn()} onCreated={vi.fn()} />),
    ).toThrow(/stages or pipelineJson/);
  });
});
