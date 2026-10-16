import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '../helpers/render';
import { ModifyViewModal } from '../../src/pages/Workspace/ModifyViewModal';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { CollectionDetails } from '@shared/ipc';

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

const VIEW: CollectionDetails = {
  name: 'recent',
  type: 'view',
  capped: false,
  options: { viewOn: 'orders', pipeline: '[{"$match":{"qty":{"$gte":{"$numberInt":"0"}}}}]' },
};

async function renderModal(modify = vi.fn(async () => ({ ok: true as const }))) {
  installAtelierMock({ meta: { collectionDetails: async () => VIEW }, collection: { modify } });
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(<ModifyViewModal connectionId="c1" dbName="shop" collection="recent" onClose={onClose} onSaved={onSaved} />);
  const pipeline = (await screen.findByLabelText('Pipeline')) as HTMLTextAreaElement;
  await waitFor(() => expect(pipeline.value).not.toBe(''));
  return { onClose, onSaved, modify, pipeline };
}

const discardPrompt = () => screen.queryByRole('dialog', { name: 'Discard changes?' });

describe('ModifyViewModal', () => {
  it('prefills the pipeline as readable JSON, not canonical wrappers', async () => {
    const { pipeline } = await renderModal();
    expect(pipeline.value).toContain('"$gte": 0');
    expect(pipeline.value).not.toContain('$numberInt');
  });

  it('Escape with an edited pipeline asks to discard it and does not close', async () => {
    const { onClose, pipeline } = await renderModal();
    fireEvent.change(pipeline, { target: { value: '[]' } });

    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(await screen.findByRole('dialog', { name: 'Discard changes?' })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Cancel with an edited source asks, and Discard closes', async () => {
    const { onClose } = await renderModal();
    fireEvent.change(screen.getByLabelText('Source collection'), { target: { value: 'archive' } });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    const prompt = await screen.findByRole('dialog', { name: 'Discard changes?' });
    fireEvent.click(within(prompt).getByRole('button', { name: 'Discard' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('Escape with nothing changed closes without asking', async () => {
    const { onClose } = await renderModal();

    fireEvent.keyDown(document.body, { key: 'Escape' });

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(discardPrompt()).toBeNull();
  });

  it('does not close while a save is in flight, so the save always lands in onSaved', async () => {
    let resolve!: () => void;
    const modify = vi.fn(() => new Promise<{ ok: true }>((r) => (resolve = () => r({ ok: true }))));
    const { onClose, onSaved, pipeline } = await renderModal(modify);
    fireEvent.change(pipeline, { target: { value: '[]' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(modify).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).not.toHaveBeenCalled();
    expect(discardPrompt()).toBeNull();
    await act(async () => resolve());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('saving the prefill unchanged sends an equivalent pipeline', async () => {
    const { modify } = await renderModal();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(modify).toHaveBeenCalledTimes(1));
    const [input] = modify.mock.calls[0] as unknown as [{ options: { viewOn: string; pipeline: string } }];
    expect(input.options.viewOn).toBe('orders');
    expect(JSON.parse(input.options.pipeline)).toEqual([{ $match: { qty: { $gte: 0 } } }]);
  });
});
