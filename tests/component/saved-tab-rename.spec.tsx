// The Saved list's inline rename (W09 §8): the name becomes an input, Enter
// submits, Escape cancels, a taken name keeps the input open with a message.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '../helpers/render';
import { SavedTab } from '../../src/pages/Workspace/views/SavedTab';
import { peekSavedRename, requestSavedRename, _resetTabRequestsForTests } from '../../src/pages/Workspace/tabRequest';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { SavedQuery, SavedQuerySummary } from '@shared/types';

afterEach(() => {
  uninstallAtelierMock();
  _resetTabRequestsForTests();
  vi.restoreAllMocks();
});

const summary: SavedQuerySummary = {
  id: 'q1',
  connectionId: 'c1',
  dbName: 'shop',
  collection: 'orders',
  kind: 'find',
  name: 'Open orders',
  updatedAt: '2026-11-10T10:00:00.000Z',
};

function mount(
  update: (input: { id: string; patch: { name?: string } }) => Promise<SavedQuery>,
  list: () => Promise<SavedQuerySummary[]> = async () => [summary],
) {
  const savedUpdate = vi.fn(update);
  const savedList = vi.fn(list);
  const onRenamed = vi.fn();
  const parentKeyDown = vi.fn();
  installAtelierMock({ saved: { list: savedList as never, update: savedUpdate as never } });
  render(
    <div onKeyDown={parentKeyDown}>
      <SavedTab
      connectionId="c1"
      dbName="shop"
      collection="orders"
      tabId="t1"
      onRunHere={() => {}}
      onOpenInTab={() => {}}
      onRenamed={onRenamed}
      />
    </div>,
  );
  return { savedUpdate, savedList, onRenamed, parentKeyDown };
}

const renamed = (name: string): SavedQuery =>
  ({ ...summary, name, updatedAt: '2026-11-11T10:00:00.000Z', createdAt: summary.updatedAt, payload: {} }) as unknown as SavedQuery;
const input = () => screen.getByLabelText('New name for "Open orders"') as HTMLInputElement;

describe('SavedTab — rename', () => {
  it('turns the name into an input, and Enter stores the trimmed name', async () => {
    const { savedUpdate, onRenamed } = mount(async ({ patch }) => renamed(patch.name!));
    fireEvent.click(await screen.findByRole('button', { name: 'Rename "Open orders"' }));
    expect(input().value).toBe('Open orders');
    expect(document.activeElement).toBe(input());

    fireEvent.change(input(), { target: { value: '  Paid orders ' } });
    fireEvent.keyDown(input(), { key: 'Enter' });

    await screen.findByText('Paid orders');
    expect(savedUpdate).toHaveBeenCalledWith({ id: 'q1', patch: { name: 'Paid orders' } });
    expect(onRenamed).toHaveBeenCalledWith(summary, 'Paid orders');
    expect(screen.queryByLabelText('New name for "Open orders"')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Rename "Paid orders"' }));
  });

  it('Escape puts the name back without storing anything, and stops there', async () => {
    const { savedUpdate, parentKeyDown } = mount(async ({ patch }) => renamed(patch.name!));
    fireEvent.click(await screen.findByRole('button', { name: 'Rename "Open orders"' }));
    fireEvent.change(input(), { target: { value: 'Other' } });
    fireEvent.keyDown(input(), { key: 'Escape' });

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Rename "Open orders"' }));
    expect(savedUpdate).not.toHaveBeenCalled();
    expect(parentKeyDown).not.toHaveBeenCalled();
  });

  it('stores nothing for an unchanged or empty name', async () => {
    const { savedUpdate } = mount(async ({ patch }) => renamed(patch.name!));
    for (const value of ['Open orders', '   ']) {
      fireEvent.click(await screen.findByRole('button', { name: 'Rename "Open orders"' }));
      fireEvent.change(input(), { target: { value } });
      fireEvent.keyDown(input(), { key: 'Enter' });
      await screen.findByRole('button', { name: 'Rename "Open orders"' });
    }
    expect(savedUpdate).not.toHaveBeenCalled();
  });

  it('keeps the input open with a message when the name is taken', async () => {
    const { onRenamed } = mount(async () => {
      throw { code: 'CONFLICT', message: "saved query name 'Paid' already exists" };
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Rename "Open orders"' }));
    fireEvent.change(input(), { target: { value: 'Paid' } });
    fireEvent.keyDown(input(), { key: 'Enter' });

    await screen.findByText('“Paid” is already saved on orders.');
    expect(input().value).toBe('Paid');
    expect(input().readOnly).toBe(false);
    expect(document.activeElement).toBe(input());
    expect(onRenamed).not.toHaveBeenCalled();
  });

  it('opens the input on a rename request for its tab once the list has loaded', async () => {
    requestSavedRename('t1', 'q1');
    mount(async ({ patch }) => renamed(patch.name!));
    await waitFor(() => expect(input().value).toBe('Open orders'));
  });

  it('lists again for an entry its list lacks, and opens the input when it is there', async () => {
    const later = { ...summary, id: 'q2', name: 'Saved elsewhere' };
    let calls = 0;
    requestSavedRename('t1', 'q2');
    const { savedList } = mount(
      async ({ patch }) => renamed(patch.name!),
      async () => (++calls === 1 ? [summary] : [summary, later]),
    );
    await waitFor(() => expect((screen.getByLabelText('New name for "Saved elsewhere"') as HTMLInputElement).value).toBe('Saved elsewhere'));
    expect(savedList).toHaveBeenCalledTimes(2);
  });

  it('says so in a notice when the entry is still gone, and keeps the list', async () => {
    requestSavedRename('t1', 'gone');
    const { savedList } = mount(async ({ patch }) => renamed(patch.name!));
    await screen.findByText('That saved query no longer exists.');
    expect(savedList).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Rename "Open orders"' })).toBeTruthy();
    expect(peekSavedRename('t1')).toBeNull();
  });

  it('drops the request when the list cannot load', async () => {
    requestSavedRename('t1', 'q1');
    mount(
      async ({ patch }) => renamed(patch.name!),
      async () => {
        throw { code: 'INTERNAL', message: 'disk gone' };
      },
    );
    await screen.findByText('disk gone');
    expect(peekSavedRename('t1')).toBeNull();
  });
});
