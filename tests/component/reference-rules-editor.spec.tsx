import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '../helpers/render';
import type { ReferenceRule } from '@shared/types';
import { ReferenceRulesEditor } from '../../src/features/references/ReferenceRulesEditor';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';

function withTheme(ui: React.ReactElement) {
  return ui;
}

const RULE: ReferenceRule = {
  id: 'rule-1',
  connectionId: 'conn-1',
  sourceDb: 'shop',
  sourceCollection: 'orders',
  sourceField: 'contact_id',
  targetDb: 'shop',
  targetCollection: 'contacts',
  targetField: '_id',
  projection: [],
  enabled: true,
  createdAt: '2026-04-24T00:00:00.000Z',
  updatedAt: '2026-04-24T00:00:00.000Z',
};

describe('ReferenceRulesEditor — delete confirm', () => {
  let listSpy: ReturnType<typeof vi.fn>;
  let deleteSpy: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<void>>>;

  beforeEach(() => {
    listSpy = vi.fn(async () => [RULE]);
    deleteSpy = vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined);
    installAtelierMock({
      refs: {
        list: listSpy as never,
        delete: deleteSpy as never,
      } as never,
    });
  });

  afterEach(() => {
    uninstallAtelierMock();
  });

  it('does not delete on the first click — surfaces an inline confirm row', async () => {
    render(
      withTheme(
        <ReferenceRulesEditor
          connectionId="conn-1"
          dbName="shop"
          collection="orders"
          onClose={() => {}}
        />,
      ),
    );

    const deleteBtn = await screen.findByLabelText('Delete rule');
    fireEvent.click(deleteBtn);

    // Inline confirm appears, IPC has not been called.
    expect(await screen.findByLabelText('Confirm delete')).toBeTruthy();
    expect(screen.getByLabelText('Cancel delete')).toBeTruthy();
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('Cancel returns to the original delete affordance without calling IPC', async () => {
    render(
      withTheme(
        <ReferenceRulesEditor
          connectionId="conn-1"
          dbName="shop"
          collection="orders"
          onClose={() => {}}
        />,
      ),
    );

    fireEvent.click(await screen.findByLabelText('Delete rule'));
    fireEvent.click(await screen.findByLabelText('Cancel delete'));

    // Original trash button is back.
    expect(await screen.findByLabelText('Delete rule')).toBeTruthy();
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('only the second click (Confirm delete) calls api.refs.delete', async () => {
    const onChanged = vi.fn();
    render(
      withTheme(
        <ReferenceRulesEditor
          connectionId="conn-1"
          dbName="shop"
          collection="orders"
          onClose={() => {}}
          onChanged={onChanged}
        />,
      ),
    );

    fireEvent.click(await screen.findByLabelText('Delete rule'));
    fireEvent.click(await screen.findByLabelText('Confirm delete'));

    await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith({ id: 'rule-1' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  /**
   * #91 — Confirm delete is a native `<button>` that no longer goes
   * real-`disabled` while deleting (only `data-disabled`/`aria-disabled` —
   * a focused button that goes real `disabled` gets blurred to `<body>` by
   * Chromium, with nothing to restore it on a failure). `handleDelete`'s own
   * `deletingId` guard has to stop a second click from firing a second
   * `api.refs.delete` now.
   */
  it('a second click on Confirm delete while a delete is in flight calls api.refs.delete once', async () => {
    let resolveDelete!: () => void;
    deleteSpy.mockImplementation(() => new Promise<void>((r) => (resolveDelete = r)));

    render(
      withTheme(
        <ReferenceRulesEditor
          connectionId="conn-1"
          dbName="shop"
          collection="orders"
          onClose={() => {}}
        />,
      ),
    );

    fireEvent.click(await screen.findByLabelText('Delete rule'));
    const confirmBtn = await screen.findByLabelText('Confirm delete');
    fireEvent.click(confirmBtn);
    fireEvent.click(confirmBtn);

    expect(deleteSpy).toHaveBeenCalledTimes(1);
    resolveDelete();
  });
});
