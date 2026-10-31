import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, fireEvent, waitFor, within, act } from '../helpers/render';
import { WriteStageConfirm } from '../../src/pages/Workspace/Aggregation/AggregationTab';
import { SavePipelineModal } from '../../src/pages/Workspace/Aggregation/SavePipelineModal';
import { SaveAsCollectionModal } from '../../src/pages/Workspace/Aggregation/SaveAsCollectionModal';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import { invalidateSampleSchemaCache } from '../../src/features/fieldSuggestions/sources/sampleSchemaSource';
import { invalidateSchemaEnumCache } from '../../src/features/fieldSuggestions/sources/schemaEnumSource';

// Spied so each write path can be checked for dropping the cached enum suggestions.
vi.mock('../../src/features/fieldSuggestions/sources/schemaEnumSource', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/features/fieldSuggestions/sources/schemaEnumSource')>()),
  invalidateSchemaEnumCache: vi.fn(),
}));

// Mocked at the exact module SaveAsCollectionModal imports; the rest stays
// real because AggregationTab reaches the suggestion sources through their
// barrel.
vi.mock('../../src/features/fieldSuggestions/sources/sampleSchemaSource', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/features/fieldSuggestions/sources/sampleSchemaSource')>()),
  invalidateSampleSchemaCache: vi.fn(),
}));

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
  vi.mocked(invalidateSampleSchemaCache).mockClear();
  vi.mocked(invalidateSchemaEnumCache).mockClear();
});

/**
 * X15 T6 — the dialog shells for the three aggregation overlays that
 * had **no tests at all** before this ticket.
 *
 * `WriteStageConfirm`, `SavePipelineModal` and `SaveAsCollectionModal` were
 * never rendered by any spec: `aggregation-tab.spec.tsx` covers the inline
 * `$out` warning strip rather than the confirm dialog, and the `output-panel`
 * specs stub `onSaveAsCollection` without ever opening the modal. That made
 * them cheap to change and dangerous to change unverified, so this file is
 * written from scratch rather than adapted.
 *
 * It covers what the Mantine migration owns — the a11y set the hand-rolled
 * overlays never had, and the unsaved-changes guard on the two that hold typed
 * input — plus the submit path of those two, added later: the `<form>` that
 * makes Enter work and the `canSubmit`/type-to-confirm gates that hold both
 * paths back. The mutation targets are named in place.
 *
 * The `role="dialog"`-on-the-backdrop assertions are the specific pre-existing
 * bug: all three put the role on the `position: fixed` scrim, so assistive
 * tech announced the scrim and never the panel.
 */

/** The overlay carries no role by design, so it has no accessible handle. */
const overlayOf = () =>
  document.body.querySelector('.mantine-Modal-overlay') as HTMLElement;

const discardPrompt = () => screen.queryByRole('dialog', { name: 'Discard changes?' });

/** Let a click's async handler settle so a *negative* assertion means something. */
const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

/**
 * A `vi.fn()` whose promise stays pending until `resolve` is called —
 * shared by the `SavePipelineModal`/`SaveAsCollectionModal` double-submit
 * guard tests below (#91), so a second submit fired while the first is
 * still in flight has something to actually be "in flight" against.
 */
function deferredCall<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  const spy = vi.fn(() => promise);
  return { spy, resolve };
}

// ─── WriteStageConfirm ──────────────────────────────────────────────────

describe('WriteStageConfirm — dialog shell (X15 T6)', () => {
  const dialog = () => screen.getByRole('dialog', { name: 'Confirm write' });

  function renderConfirm(onCancel = vi.fn(), onProceed = vi.fn()) {
    render(<WriteStageConfirm op="$out" target="shop.rollup" onCancel={onCancel} onProceed={onProceed} />);
    return { onCancel, onProceed };
  }

  it('puts role="dialog" on the panel — the element holding the copy, not the backdrop', () => {
    renderConfirm();
    // MUTATION TARGET — put `role="dialog"` back on the scrim (as the
    // hand-rolled version had it) and this goes red: the overlay stops being
    // role-less, and `getByRole('dialog')` no longer resolves to the panel
    // that actually holds the confirmation copy.
    expect(dialog().textContent).toContain('shop.rollup');
    expect(overlayOf()).not.toBeNull();
    expect(overlayOf().getAttribute('role')).toBeNull();
  });

  it('names the dialog "Confirm write" and gives the close control an aria-label', () => {
    renderConfirm();
    // `getByRole('dialog', { name: … })` already proves the accessible name;
    // the ✕ did not exist at all before the migration.
    expect(within(dialog()).getByRole('button', { name: 'Close' })).toBeTruthy();
  });

  it('moves focus into the panel on open', async () => {
    renderConfirm();
    await waitFor(() => expect(dialog().contains(document.activeElement)).toBe(true));
  });

  it('Escape cancels — the hand-rolled overlay ignored Escape entirely', async () => {
    const { onCancel, onProceed } = renderConfirm();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
    expect(onProceed).not.toHaveBeenCalled();
    // Nothing typed here, so there is nothing to guard and nothing to prompt.
    expect(discardPrompt()).toBeNull();
  });

  it('Proceed still runs the write after the move into Mantine', () => {
    // The only affirmative path through this dialog, and it had no coverage at
    // all before this ticket — the button moved out of a hand-rolled panel and
    // into `Modal`'s children, so it is worth one assertion that it survived.
    const { onProceed, onCancel } = renderConfirm();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Proceed' }));
    expect(onProceed).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('returns focus to the trigger when it closes', async () => {
    const onProceed = vi.fn();
    function Harness() {
      const [open, setOpen] = React.useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Run</button>
          {open && (
            <WriteStageConfirm
              op="$out"
              target="shop.rollup"
              onCancel={() => setOpen(false)}
              onProceed={onProceed}
            />
          )}
        </>
      );
    }
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Run' });
    await user.click(trigger);
    await waitFor(() => expect(dialog().contains(document.activeElement)).toBe(true));

    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Confirm write' })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  /**
   * No backdrop test here, deliberately. This dialog holds no typed input, so
   * it keeps Mantine's default `closeOnClickOutside` — which makes the
   * ticket's `closeOnClickOutside` mutation **equivalent** for this overlay.
   * A test asserting an inert backdrop would just be asserting a prop this
   * dialog does not and should not set.
   */
});

// ─── SavePipelineModal ──────────────────────────────────────────────────

describe('SavePipelineModal — dialog shell + guard (X15 T6)', () => {
  const modal = () => screen.getByRole('dialog', { name: 'Save pipeline' });
  const nameInput = () => screen.getByLabelText(/Name/) as HTMLInputElement;
  const descriptionInput = () => screen.getByLabelText(/Description/) as HTMLTextAreaElement;

  function renderModal(opts: { onClose?: () => void; initialName?: string } = {}) {
    const onClose = opts.onClose ?? vi.fn();
    // `created` records every `saved.create` payload — the submit tests
    // assert the button path and the Enter path produce the *same* call.
    const created: unknown[] = [];
    installAtelierMock({
      saved: {
        create: (async (input: unknown) => {
          created.push(input);
          return input;
        }) as never,
      },
    });
    render(
      <SavePipelineModal
        connectionId="c1"
        dbName="shop"
        collection="orders"
        stages={[{ id: 1, op: '$match', body: '{}', enabled: true }]}
        initialName={opts.initialName}
        onClose={onClose}
        onSaved={() => undefined}
      />,
    );
    return { onClose, created };
  }

  it('puts role="dialog" on the panel — the element holding the fields, not the backdrop', () => {
    renderModal();
    // MUTATION TARGET — restoring `role="dialog"` on the scrim reds this.
    expect(within(modal()).getByLabelText(/Name/)).toBeTruthy();
    expect(overlayOf()).not.toBeNull();
    expect(overlayOf().getAttribute('role')).toBeNull();
  });

  it('names the dialog "Save pipeline" and gives the close control an aria-label', () => {
    renderModal();
    expect(within(modal()).getByRole('button', { name: 'Close' })).toBeTruthy();
  });

  it('moves focus into the panel on open', async () => {
    renderModal();
    await waitFor(() => expect(modal().contains(document.activeElement)).toBe(true));
  });

  it('returns focus to the trigger when the modal closes', async () => {
    installAtelierMock({});
    function Harness() {
      const [open, setOpen] = React.useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Save pipeline</button>
          {open && (
            <SavePipelineModal
              connectionId="c1"
              dbName="shop"
              collection="orders"
              stages={[]}
              onClose={() => setOpen(false)}
              onSaved={() => undefined}
            />
          )}
        </>
      );
    }
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Save pipeline' });
    await user.click(trigger);
    await waitFor(() => expect(modal().contains(document.activeElement)).toBe(true));

    fireEvent.keyDown(document.body, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Save pipeline' })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('Escape closes a clean modal without prompting', async () => {
    const { onClose } = renderModal();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(discardPrompt()).toBeNull();
  });

  /**
   * X15 §2 — dirty is "differs from initial", not "was touched". This modal
   * opens pre-filled with the saved pipeline's name, so the naive
   * `name !== ''` check (correct for `SaveModal`, which always opens empty)
   * would mark it dirty on mount and prompt on every clean Cancel.
   *
   * MUTATION TARGET — change the guard to compare against `''` and this one
   * goes red while the empty-modal test above stays green.
   */
  it('a pre-filled name is not dirty — closing an untouched saved pipeline does not prompt', async () => {
    const { onClose } = renderModal({ initialName: 'monthly totals' });
    fireEvent.click(within(modal()).getByRole('button', { name: 'Cancel' }));
    await settle();
    expect(discardPrompt()).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  /**
   * MUTATION TARGET — delete `closeOnClickOutside={false}` from
   * `SavePipelineModal` and the last assertion must go red: the backdrop
   * starts routing through `requestClose` and raises a prompt the user never
   * asked for. The other two assertions stay green under that mutation, which
   * is exactly why "no prompt" has to be asserted rather than "text survived".
   *
   * Do not "fix" this test into expecting a prompt. An inert backdrop is the
   * point — see spec §3 on why the prompting variant makes this a no-op.
   */
  it('a backdrop click with a typed name is inert — no close, no prompt, text intact', async () => {
    const { onClose } = renderModal();
    fireEvent.change(nameInput(), { target: { value: 'Half-typed name' } });

    fireEvent.click(overlayOf());
    await settle();

    expect(nameInput().value).toBe('Half-typed name');
    expect(onClose).not.toHaveBeenCalled();
    expect(discardPrompt()).toBeNull();
  });

  it('Escape with a typed name prompts, and Cancel leaves the text intact', async () => {
    const { onClose } = renderModal();
    fireEvent.change(nameInput(), { target: { value: 'Top skus' } });

    fireEvent.keyDown(document.body, { key: 'Escape' });

    const prompt = await screen.findByRole('dialog', { name: 'Discard changes?' });
    fireEvent.click(within(prompt).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(discardPrompt()).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
    expect(nameInput().value).toBe('Top skus');
  });

  it('Escape with a typed name closes once Discard is confirmed', async () => {
    const { onClose } = renderModal();
    fireEvent.change(nameInput(), { target: { value: 'Top skus' } });

    fireEvent.keyDown(document.body, { key: 'Escape' });

    const prompt = await screen.findByRole('dialog', { name: 'Discard changes?' });
    fireEvent.click(within(prompt).getByRole('button', { name: 'Discard' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('a description alone is dirty too', async () => {
    const { onClose } = renderModal({ initialName: 'monthly totals' });
    fireEvent.change(descriptionInput(), { target: { value: 'a note' } });

    fireEvent.click(within(modal()).getByRole('button', { name: 'Cancel' }));

    await screen.findByRole('dialog', { name: 'Discard changes?' });
    expect(onClose).not.toHaveBeenCalled();
  });

  /**
   * the submit path itself, which had no coverage at all before this
   * ticket, plus the `<form>` that `SaveModal` was given and this sibling
   * never got.
   */
  describe('submit', () => {
    const saveButton = () => within(modal()).getByRole('button', { name: 'Save' });

    it('the Save button saves the pipeline', async () => {
      const { created } = renderModal();
      fireEvent.change(nameInput(), { target: { value: 'Top skus' } });
      fireEvent.change(descriptionInput(), { target: { value: 'a note' } });

      fireEvent.click(saveButton());

      await waitFor(() => expect(created.length).toBe(1));
      expect(created[0]).toMatchObject({
        connectionId: 'c1',
        dbName: 'shop',
        collection: 'orders',
        kind: 'aggregation',
        name: 'Top skus',
        payload: { kind: 'aggregation', description: 'a note' },
      });
    });

    /**
     * MUTATION TARGET — neuter the `<form onSubmit>` in `SavePipelineModal`
     * (drop the `void submit()`) and this goes red: the fields become bare
     * siblings again and Enter does nothing, which is the submit-path defect verbatim.
     *
     * It has to be the *name field* rather than the description: the textarea
     * calls `submit()` from its own keydown handler and would survive a
     * neutered `onSubmit`.
     */
    it('Enter in the name field runs the same save as clicking Save', async () => {
      const user = userEvent.setup();
      const { created } = renderModal();

      await user.type(descriptionInput(), 'a note');
      await user.type(nameInput(), 'Top skus{Enter}');

      await waitFor(() => expect(created.length).toBe(1));
      expect(created[0]).toMatchObject({
        connectionId: 'c1',
        dbName: 'shop',
        collection: 'orders',
        kind: 'aggregation',
        name: 'Top skus',
        payload: { kind: 'aggregation', description: 'a note' },
      });
    });

    it('Enter in the description field submits as well', async () => {
      const user = userEvent.setup();
      const { created } = renderModal();

      await user.type(nameInput(), 'Top skus');
      await user.type(descriptionInput(), 'a note{Enter}');

      await waitFor(() => expect(created.length).toBe(1));
      expect(created[0]).toMatchObject({ payload: { description: 'a note' } });
    });

    it('Shift+Enter in the description newlines instead of submitting', async () => {
      const user = userEvent.setup();
      const { created } = renderModal();

      await user.type(nameInput(), 'Top skus');
      await user.type(descriptionInput(), 'line one{Shift>}{Enter}{/Shift}line two');

      expect(created.length).toBe(0);
      expect(descriptionInput().value).toBe('line one\nline two');
    });

    /**
     * MUTATION TARGET — break `canSubmit` (force it `true`) and this goes red.
     * The description route is what makes the mutation unambiguous: it reaches
     * `submit`'s own `if (!canSubmit) return`, so the gate is tested rather
     * than the disabled button incidentally suppressing implicit submission.
     */
    it('Enter with an empty name newlines instead of submitting', async () => {
      const user = userEvent.setup();
      const { created } = renderModal();

      expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
      await user.type(descriptionInput(), 'orphan note{Enter}');

      await settle();
      expect(created.length).toBe(0);
      // MUTATION TARGET — hoist `e.preventDefault()` back above the
      // `!canSubmit` guard and this line goes red while the one above stays
      // green: the keystroke is neither a save nor a newline, so a user
      // drafting a multi-line note before naming the pipeline simply cannot
      // get a line break.
      expect(descriptionInput().value).toBe('orphan note\n');
    });

    /**
     * MUTATION TARGET — drop the `isComposing` guard and this goes red. An IME
     * commit is a keydown with `key === 'Enter'`; treating it as submit saves
     * the pipeline with a half-composed description, which is a CJK-only data
     * bug no other test in this file can see.
     */
    it('Enter that commits an IME candidate does not submit', async () => {
      const user = userEvent.setup();
      const { created } = renderModal();

      await user.type(nameInput(), 'Top skus');
      await user.type(descriptionInput(), 'nihon');
      fireEvent.keyDown(descriptionInput(), { key: 'Enter', isComposing: true });

      await settle();
      expect(created.length).toBe(0);
    });

    /**
     * #91 — the Save button is a native `type="submit"` button, and no
     * longer goes real-`disabled` while `saving` (only
     * `data-disabled`/`aria-disabled`). Its own attribute can no longer be
     * what stops a second click or a second implicit form submit from
     * firing a second `saved.create` — `submit`'s own `canSubmit` check
     * (which still folds in `!saving`) has to do that job now.
     */
    it('a second submit while a save is in flight makes only one saved.create call', async () => {
      const { spy: create, resolve } = deferredCall<unknown>();
      installAtelierMock({ saved: { create: create as never } });
      render(
        <SavePipelineModal
          connectionId="c1"
          dbName="shop"
          collection="orders"
          stages={[{ id: 1, op: '$match', body: '{}', enabled: true }]}
          onClose={vi.fn()}
          onSaved={() => undefined}
        />,
      );
      fireEvent.change(nameInput(), { target: { value: 'Top skus' } });

      // Captured once: the button's accessible name changes to "Saving…"
      // after the first click, so a second `saveButton()` call (an exact
      // name match) would throw "unable to find element" instead of
      // re-resolving to the same node.
      const button = saveButton();
      fireEvent.click(button);
      fireEvent.click(button);

      expect(create).toHaveBeenCalledTimes(1);
      resolve({});
    });

    it('renders a failed save as a red alert, not the warning colour', async () => {
      installAtelierMock({
        saved: {
          create: (async () => {
            throw { code: 'INTERNAL', message: 'disk full' };
          }) as never,
        },
      });
      render(
        <SavePipelineModal
          connectionId="c1"
          dbName="shop"
          collection="orders"
          stages={[{ id: 1, op: '$match', body: '{}', enabled: true }]}
          onClose={vi.fn()}
          onSaved={() => undefined}
        />,
      );
      fireEvent.change(nameInput(), { target: { value: 'Top skus' } });
      fireEvent.click(saveButton());

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toBe('disk full');
      expect(alert.getAttribute('style')).toContain('color: var(--atelier-red)');
    });
  });
});

// ─── SaveAsCollectionModal ──────────────────────────────────────────────

describe('SaveAsCollectionModal — dialog shell + guard (X15 T6)', () => {
  const modal = () => screen.getByRole('dialog', { name: 'Save results to collection' });
  const targetDbInput = () => screen.getByLabelText(/Target database/) as HTMLInputElement;
  const targetCollInput = () => screen.getByLabelText(/Target collection/) as HTMLInputElement;

  function renderModal(onClose: () => void = vi.fn()) {
    // `written` records every `agg.runAndSave` payload — the submit tests
    // assert the button path and the Enter path produce the same call.
    const written: unknown[] = [];
    installAtelierMock({
      agg: {
        runAndSave: (async (input: unknown) => {
          written.push(input);
          return { writtenCount: 1 };
        }) as never,
      },
    });
    render(
      <SaveAsCollectionModal
        connectionId="c1"
        dbName="shop"
        collection="orders"
        stages={[{ id: 1, op: '$match', body: '{}', enabled: true }]}
        onClose={onClose}
        onWritten={() => undefined}
      />,
    );
    return { onClose, written };
  }

  it('puts role="dialog" on the panel — the element holding the fields, not the backdrop', () => {
    renderModal();
    // MUTATION TARGET — restoring `role="dialog"` on the scrim reds this.
    expect(within(modal()).getByLabelText(/Target collection/)).toBeTruthy();
    expect(overlayOf()).not.toBeNull();
    expect(overlayOf().getAttribute('role')).toBeNull();
  });

  it('names the dialog "Save results to collection" and gives the close control an aria-label', () => {
    renderModal();
    expect(within(modal()).getByRole('button', { name: 'Close' })).toBeTruthy();
  });

  it('moves focus into the panel on open', async () => {
    renderModal();
    await waitFor(() => expect(modal().contains(document.activeElement)).toBe(true));
  });

  it('returns focus to the trigger when the modal closes', async () => {
    installAtelierMock({});
    function Harness() {
      const [open, setOpen] = React.useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Save to collection</button>
          {open && (
            <SaveAsCollectionModal
              connectionId="c1"
              dbName="shop"
              collection="orders"
              stages={[]}
              onClose={() => setOpen(false)}
              onWritten={() => undefined}
            />
          )}
        </>
      );
    }
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Save to collection' });
    await user.click(trigger);
    await waitFor(() => expect(modal().contains(document.activeElement)).toBe(true));

    fireEvent.keyDown(document.body, { key: 'Escape' });

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Save results to collection' })).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  /**
   * The clean-close case is not trivial here: `targetDb` opens pre-filled with
   * the source database name, so a `targetDb !== ''` dirty check would prompt
   * on an untouched modal.
   *
   * MUTATION TARGET — change the guard to compare `targetDb` against `''` and
   * both of these go red.
   */
  it('Escape on an untouched modal closes without prompting, despite the pre-filled database', async () => {
    const { onClose } = renderModal();
    expect(targetDbInput().value).toBe('shop');

    fireEvent.keyDown(document.body, { key: 'Escape' });

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(discardPrompt()).toBeNull();
  });

  it('closing an untouched modal from Cancel does not prompt', async () => {
    const { onClose } = renderModal();
    fireEvent.click(within(modal()).getByRole('button', { name: 'Cancel' }));
    await settle();
    expect(discardPrompt()).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  /**
   * MUTATION TARGET — delete `closeOnClickOutside={false}` from
   * `SaveAsCollectionModal` and the last assertion goes red. Same shape and
   * same reasoning as the `SavePipelineModal` case above.
   */
  it('a backdrop click with a typed target is inert — no close, no prompt, text intact', async () => {
    const { onClose } = renderModal();
    fireEvent.change(targetCollInput(), { target: { value: 'monthlyByAccount' } });

    fireEvent.click(overlayOf());
    await settle();

    expect(targetCollInput().value).toBe('monthlyByAccount');
    expect(onClose).not.toHaveBeenCalled();
    expect(discardPrompt()).toBeNull();
  });

  it('Escape with a typed target prompts, and Cancel leaves the text intact', async () => {
    const { onClose } = renderModal();
    fireEvent.change(targetCollInput(), { target: { value: 'monthlyByAccount' } });

    fireEvent.keyDown(document.body, { key: 'Escape' });

    const prompt = await screen.findByRole('dialog', { name: 'Discard changes?' });
    fireEvent.click(within(prompt).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(discardPrompt()).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
    expect(targetCollInput().value).toBe('monthlyByAccount');
  });

  it('Escape with a typed target closes once Discard is confirmed', async () => {
    const { onClose } = renderModal();
    fireEvent.change(targetCollInput(), { target: { value: 'monthlyByAccount' } });

    fireEvent.keyDown(document.body, { key: 'Escape' });

    const prompt = await screen.findByRole('dialog', { name: 'Discard changes?' });
    fireEvent.click(within(prompt).getByRole('button', { name: 'Discard' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  /**
   * X15 §2 — dirtiness spans every buffer the dialog owns, not the visible
   * one. Switching to `$merge` reveals two more selects and is itself a choice
   * the user would have to redo, so it counts.
   */
  it('switching the write mode counts as dirty', async () => {
    const { onClose } = renderModal();
    fireEvent.change(within(modal()).getByLabelText('Mode'), { target: { value: '$merge' } });

    fireEvent.click(within(modal()).getByRole('button', { name: 'Cancel' }));

    await screen.findByRole('dialog', { name: 'Discard changes?' });
    expect(onClose).not.toHaveBeenCalled();
  });

  /**
   * the submit path itself, which had no coverage at all before this
   * ticket. This dialog has no textarea, so the Shift+Enter criterion is
   * vacuous here; it is covered on `SavePipelineModal`'s description instead.
   */
  describe('submit', () => {
    // The label is a dynamic fragment (`Type <span>{targetColl}</span> to
    // confirm`), so it has to be matched loosely.
    const confirmInput = () => screen.getByLabelText(/to confirm/i) as HTMLInputElement;
    const confirmButton = () =>
      within(modal()).getByRole('button', { name: 'Confirm $out' }) as HTMLButtonElement;

    const expectedCall = {
      connectionId: 'c1',
      dbName: 'shop',
      collection: 'orders',
      allowWrite: true,
      target: { dbName: 'shop', collection: 'monthlyByAccount', mode: '$out' },
    };

    it('the Confirm button runs the write once the target is typed back', async () => {
      const { written } = renderModal();
      fireEvent.change(targetCollInput(), { target: { value: 'monthlyByAccount' } });
      fireEvent.change(confirmInput(), { target: { value: 'monthlyByAccount' } });

      fireEvent.click(confirmButton());

      await waitFor(() => expect(written.length).toBe(1));
      expect(written[0]).toMatchObject(expectedCall);
    });

    /**
     * MUTATION TARGET — drop `mode` or `mergeCounts` from the `onWritten` call
     * and this goes red: the toast can no longer tell a `$merge` from an
     * `$out`, and falls back to reporting nothing about the target's size.
     */
    it('hands the write mode and the merge counts to onWritten', async () => {
      installAtelierMock({
        agg: { runAndSave: (async () => ({ mergeCounts: { before: 2, after: 5 } })) as never },
      });
      const onWritten = vi.fn();
      render(
        <SaveAsCollectionModal
          connectionId="c1"
          dbName="shop"
          collection="orders"
          stages={[{ id: 1, op: '$match', body: '{}', enabled: true }]}
          onClose={vi.fn()}
          onWritten={onWritten}
        />,
      );
      fireEvent.change(within(modal()).getByLabelText('Mode'), { target: { value: '$merge' } });
      fireEvent.change(targetCollInput(), { target: { value: 'monthlyByAccount' } });
      fireEvent.change(confirmInput(), { target: { value: 'monthlyByAccount' } });

      fireEvent.click(within(modal()).getByRole('button', { name: 'Confirm $merge' }));

      await waitFor(() => expect(onWritten).toHaveBeenCalledTimes(1));
      expect(onWritten).toHaveBeenCalledWith({
        dbName: 'shop',
        collection: 'monthlyByAccount',
        mode: '$merge',
        mergeCounts: { before: 2, after: 5 },
      });
    });

    /**
     * MUTATION TARGET — neuter the `<form onSubmit>` in
     * `SaveAsCollectionModal` (drop the `void submit()`) and this goes red:
     * the fields become bare siblings again and Enter does nothing.
     */
    it('Enter in the target-collection field runs the same write as the button', async () => {
      const user = userEvent.setup();
      const { written } = renderModal();
      fireEvent.change(confirmInput(), { target: { value: 'monthlyByAccount' } });

      await user.type(targetCollInput(), 'monthlyByAccount{Enter}');

      await waitFor(() => expect(written.length).toBe(1));
      expect(written[0]).toMatchObject(expectedCall);
    });

    /**
     * The write replaces or merges into the *target* collection, which can
     * be in another database than the source; a sample of it taken earlier
     * would otherwise keep describing the old documents for the TTL.
     */
    it('drops the target collection\'s field-suggestion sample, not the source\'s', async () => {
      const { written } = renderModal();
      fireEvent.change(targetDbInput(), { target: { value: 'reports' } });
      fireEvent.change(targetCollInput(), { target: { value: 'monthlyByAccount' } });
      fireEvent.change(confirmInput(), { target: { value: 'monthlyByAccount' } });

      fireEvent.click(confirmButton());

      await waitFor(() => expect(written.length).toBe(1));
      await waitFor(() =>
        expect(invalidateSampleSchemaCache).toHaveBeenCalledExactlyOnceWith('c1', 'reports', 'monthlyByAccount'),
      );
      expect(invalidateSchemaEnumCache).toHaveBeenCalledExactlyOnceWith('c1', 'reports', 'monthlyByAccount');
    });

    it('drops it as well when the write fails, since a $merge may have written part-way', async () => {
      installAtelierMock({
        agg: {
          runAndSave: (async () => {
            throw { code: 'INTERNAL', message: 'merge failed' };
          }) as never,
        },
      });
      render(
        <SaveAsCollectionModal
          connectionId="c1"
          dbName="shop"
          collection="orders"
          stages={[{ id: 1, op: '$match', body: '{}', enabled: true }]}
          onClose={vi.fn()}
          onWritten={() => undefined}
        />,
      );
      fireEvent.change(targetCollInput(), { target: { value: 'monthlyByAccount' } });
      fireEvent.change(confirmInput(), { target: { value: 'monthlyByAccount' } });

      fireEvent.click(confirmButton());

      await screen.findByText(/merge failed/);
      expect(invalidateSampleSchemaCache).toHaveBeenCalledExactlyOnceWith('c1', 'shop', 'monthlyByAccount');
      expect(invalidateSchemaEnumCache).toHaveBeenCalledExactlyOnceWith('c1', 'shop', 'monthlyByAccount');
    });

    it('leaves the sample alone when the submit is blocked by a mismatched confirmation', async () => {
      const user = userEvent.setup();
      const { written } = renderModal();
      fireEvent.change(targetCollInput(), { target: { value: 'monthlyByAccount' } });
      fireEvent.change(confirmInput(), { target: { value: 'monthlyByAccounr' } });

      expect(confirmButton().disabled).toBe(true);
      await user.type(confirmInput(), '{Enter}');

      await settle();
      expect(written.length).toBe(0);
      expect(invalidateSampleSchemaCache).not.toHaveBeenCalled();
      expect(invalidateSchemaEnumCache).not.toHaveBeenCalled();
    });

    /**
     * MUTATION TARGET — break the `confirmText.trim() === targetColl.trim()`
     * comparison in `canSubmit` and both assertions go red: the type-to-confirm
     * gate stops holding, so a typo in the confirmation would drop a
     * collection the user never named.
     */
    it('a mismatched confirmation does not submit, from either path', async () => {
      const user = userEvent.setup();
      const { written } = renderModal();
      fireEvent.change(targetCollInput(), { target: { value: 'monthlyByAccount' } });
      fireEvent.change(confirmInput(), { target: { value: 'monthlyByAccounr' } });

      expect(confirmButton().disabled).toBe(true);
      fireEvent.click(confirmButton());
      await user.type(confirmInput(), '{Enter}');

      await settle();
      expect(written.length).toBe(0);
    });

    /**
     * MUTATION TARGET — drop `setConfirmText('')` from the target-database
     * `onChange` and this goes red. The form made Enter submit from every
     * field, so a user who arms the dialog, scrolls back up to correct the
     * destination database, and hits Enter out of form habit would run `$out`
     * against a database they never confirmed.
     */
    it('changing the target database retracts the confirmation', async () => {
      const user = userEvent.setup();
      const { written } = renderModal();
      fireEvent.change(targetCollInput(), { target: { value: 'monthlyByAccount' } });
      fireEvent.change(confirmInput(), { target: { value: 'monthlyByAccount' } });
      expect(confirmButton().disabled).toBe(false);

      await user.type(targetDbInput(), '-archive{Enter}');

      await settle();
      expect(written.length).toBe(0);
      expect(confirmInput().value).toBe('');
      expect(confirmButton().disabled).toBe(true);
    });

    /**
     * MUTATION TARGET — drop `setConfirmText('')` from the Mode `onChange` and
     * this goes red. Mode decides what the write DOES, so a confirmation given
     * while the banner read "documents with matching _id will be modified"
     * must not survive a switch to `$out`, which replaces every document.
     */
    it('changing the mode retracts the confirmation', async () => {
      const { written } = renderModal();
      fireEvent.change(within(modal()).getByLabelText('Mode'), { target: { value: '$merge' } });
      fireEvent.change(targetCollInput(), { target: { value: 'monthlyByAccount' } });
      fireEvent.change(confirmInput(), { target: { value: 'monthlyByAccount' } });
      expect(
        (within(modal()).getByRole('button', { name: 'Confirm $merge' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);

      fireEvent.change(within(modal()).getByLabelText('Mode'), { target: { value: '$out' } });

      expect(confirmInput().value).toBe('');
      expect(confirmButton().disabled).toBe(true);
      fireEvent.click(confirmButton());

      await settle();
      expect(written.length).toBe(0);
    });

    /**
     * MUTATION TARGET — drop `targetDb.trim().length > 0` from `canSubmit` and
     * this goes red: the write leaves for the main process with `dbName: ''`
     * and comes back as a raw `VALIDATION:` string from the agg handler's
     * `NonEmpty`, instead of the dialog simply staying disarmed.
     */
    it('an empty target database does not submit', async () => {
      const user = userEvent.setup();
      const { written } = renderModal();
      fireEvent.change(targetDbInput(), { target: { value: '' } });
      fireEvent.change(targetCollInput(), { target: { value: 'monthlyByAccount' } });
      fireEvent.change(confirmInput(), { target: { value: 'monthlyByAccount' } });

      expect(confirmButton().disabled).toBe(true);
      await user.type(targetCollInput(), '{Enter}');

      await settle();
      expect(written.length).toBe(0);
    });

    /**
     * MUTATION TARGET — drop `type="button"` from Cancel and this goes red.
     * Inside a form an untyped button defaults to submit, so on the one dialog
     * that drops a collection, Cancel would run the write it was clicked to
     * avoid. An earlier check measured that the attribute does not carry *Enter*; this is
     * the click consequence, which is a different (and destructive) claim.
     */
    it('Cancel does not write, even with the confirmation fully typed', async () => {
      const { written, onClose } = renderModal();
      fireEvent.change(targetCollInput(), { target: { value: 'monthlyByAccount' } });
      fireEvent.change(confirmInput(), { target: { value: 'monthlyByAccount' } });
      expect(confirmButton().disabled).toBe(false);

      fireEvent.click(within(modal()).getByRole('button', { name: 'Cancel' }));

      // Dirty, so this prompts rather than closing — but either way it must
      // not have written.
      await screen.findByRole('dialog', { name: 'Discard changes?' });
      expect(written.length).toBe(0);
      expect(onClose).not.toHaveBeenCalled();
    });

    /**
     * MUTATION TARGET — force `canSubmit` true and this goes red: an empty
     * target would be written to.
     */
    it('Enter with an empty target collection does not submit', async () => {
      const user = userEvent.setup();
      const { written } = renderModal();

      expect(confirmButton().disabled).toBe(true);
      await user.type(targetDbInput(), '{Enter}');

      await settle();
      expect(written.length).toBe(0);
    });

    /**
     * #91 — the Confirm button is a native `type="submit"` button, and no
     * longer goes real-`disabled` while `saving` (only
     * `data-disabled`/`aria-disabled`). Its own attribute can no longer be
     * what stops a second click from firing a second `agg.runAndSave` —
     * `submit`'s own `canSubmit` check (which still folds in `!saving`) has
     * to do that job now.
     */
    it('a second submit while a write is in flight makes only one agg.runAndSave call', async () => {
      const { spy: runAndSave, resolve } = deferredCall<{ writtenCount: number }>();
      installAtelierMock({ agg: { runAndSave: runAndSave as never } });
      render(
        <SaveAsCollectionModal
          connectionId="c1"
          dbName="shop"
          collection="orders"
          stages={[{ id: 1, op: '$match', body: '{}', enabled: true }]}
          onClose={vi.fn()}
          onWritten={() => undefined}
        />,
      );
      fireEvent.change(targetCollInput(), { target: { value: 'monthlyByAccount' } });
      fireEvent.change(confirmInput(), { target: { value: 'monthlyByAccount' } });

      // Captured once: the button's accessible name changes to "Writing…"
      // after the first click, so a second `confirmButton()` call (an exact
      // name match) would throw "unable to find element" instead of
      // re-resolving to the same node.
      const button = confirmButton();
      fireEvent.click(button);
      fireEvent.click(button);

      expect(runAndSave).toHaveBeenCalledTimes(1);
      resolve({ writtenCount: 1 });
    });
  });
});
