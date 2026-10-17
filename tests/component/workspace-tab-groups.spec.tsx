import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, within, fireEvent, act } from '../helpers/render';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Workspace from '../../src/pages/Workspace';
import {
  collectionTabFixture,
  installAtelierMock,
  multiConnectionMock,
  uninstallAtelierMock,
} from '../helpers/atelierMock';
import { DEFAULT_AGGREGATION_TAB_STATE } from '@shared/defaults';
import type { WorkspaceTab } from '@shared/types';
import { notify } from '../../src/theme/notifications';

/**
 * X16.2, spec §4.4 — a tab says which Connection it belongs to.
 *
 * Every drag here is decided by *which elements the events are dispatched on*,
 * never by where a pointer is: jsdom gives a tab a zero-sized rect, so all four
 * tabs sit on the same point and a coordinate-based test would pass whatever
 * the code did. `fireEvent.dragStart(el)` / `fireEvent.drop(el)` name
 * their element, which is the only thing `TabStrip` reads.
 */

/** Two Connections, two tabs each. Staging is read-only. */
function mountTwoConnections() {
  const mock = multiConnectionMock({
    connections: [
      { id: 'c1', name: 'Prod' },
      { id: 'c2', name: 'Staging', color: '#8A4B00', readOnly: true },
    ],
    tabs: [
      { id: 'a', connectionId: 'c1', collection: 'alpha', isActive: true },
      { id: 'b', connectionId: 'c1', collection: 'bravo' },
      { id: 'x', connectionId: 'c2', collection: 'xray' },
      { id: 'y', connectionId: 'c2', collection: 'yankee' },
    ],
  });
  installAtelierMock({
    ...mock,
    // The reorder is optimistic in the renderer, so the strip is the record of
    // what happened; this only keeps the write from throwing.
    tabs: { ...mock.tabs, reorder: async () => ({ ok: true as const }) },
  });

  render(
    <MemoryRouter initialEntries={['/workspace']}>
      <Workspace />
    </MemoryRouter>,
  );
}

/**
 * The same two Connections, but *interleaved* in the stored order — Prod,
 * Staging, Prod. Opening tabs while alternating Connections does this, and so
 * does pinning any tab of a second Connection, since the strip sorts pinned
 * first. Grouped order and stored order differ here, which the contiguous
 * fixture above cannot express. Returns the `tabs:reorder` spy: what is written
 * to `position` is invisible on screen until the next launch.
 */
function mountInterleaved() {
  const reorder = vi.fn<(ids: string[]) => Promise<{ ok: true }>>(async () => ({
    ok: true,
  }));
  const mock = multiConnectionMock({
    connections: [
      { id: 'c1', name: 'Prod' },
      { id: 'c2', name: 'Staging', color: '#8A4B00', readOnly: true },
    ],
    tabs: [
      { id: 'a1', connectionId: 'c1', collection: 'alpha', isActive: true },
      { id: 'b1', connectionId: 'c2', collection: 'bravo' },
      { id: 'a2', connectionId: 'c1', collection: 'charlie' },
    ],
  });
  installAtelierMock({ ...mock, tabs: { ...mock.tabs, reorder } });

  render(
    <MemoryRouter initialEntries={['/workspace']}>
      <Workspace />
    </MemoryRouter>,
  );
  return reorder;
}

function strip() {
  return within(screen.getByRole('tablist', { name: 'Open tabs' }));
}

/** The group chips, left to right — the Connections as a person reads them. */
function chipOrder() {
  return strip()
    .getAllByRole('group')
    .map((g) => g.getAttribute('aria-label'));
}

/** The tabs, left to right, as their accessible names. */
function tabOrder() {
  return strip()
    .getAllByRole('tab')
    .map((t) => t.getAttribute('aria-label'));
}

function tab(collection: string) {
  return strip().getByRole('tab', { name: new RegExp(`^${collection} `) });
}

afterEach(() => {
  uninstallAtelierMock();
});

describe('the tab strip groups tabs by Connection', () => {
  it('renders one named chip per Connection, with its tabs behind it', async () => {
    mountTwoConnections();

    await waitFor(() => expect(chipOrder()).toEqual(['Prod', 'Staging (read-only)']));
    expect(tabOrder()).toEqual([
      'alpha — Prod',
      'bravo — Prod',
      'xray — Staging (read-only)',
      'yankee — Staging (read-only)',
    ]);

    // The name is the identity; the colour is the second cue, so it is on the
    // chip too — two Connections can share a palette family.
    const prod = strip().getByRole('group', { name: 'Prod' });
    expect(within(prod).getByText('Prod')).toBeTruthy();
    expect(prod.querySelector('[style*="rgb(26, 104, 53)"]')).toBeTruthy();
  });

  it('marks the read-only Connection and only that one', async () => {
    mountTwoConnections();

    const staging = await screen.findByRole('group', { name: 'Staging (read-only)' });
    // Scoped to the chip itself, not the whole group: the group also holds the
    // tabs, and each of those carries its own marker now. The chip is
    // the element the Connection's name sits in.
    const chip = within(staging).getByText('Staging').parentElement!;
    // Visible text, not colour alone, and labelled for a screen reader.
    expect(within(chip).getByText('RO')).toBeTruthy();
    expect(within(chip).getByLabelText('Read-only')).toBeTruthy();

    const prod = strip().getByRole('group', { name: 'Prod' });
    expect(within(prod).queryByText('RO')).toBeNull();
  });

  // X16 §4.4 — the chip alone is not enough. The strip scrolls, and a
  // person reads the tab they clicked, not the chip that may be off-screen; so
  // the marker is on each tab as well, in the chip's own visual language.
  it('marks every tab of a read-only Connection, not only the group chip', async () => {
    mountTwoConnections();
    await waitFor(() => expect(tabOrder()).toHaveLength(4));

    for (const collection of ['xray', 'yankee']) {
      const el = tab(collection);
      expect(within(el).getByText('RO')).toBeTruthy();
      expect(within(el).getByLabelText('Read-only')).toBeTruthy();
      // The accessible name says it too — the badge is a glyph, and `aria-label`
      // on the tab means its contents are not what a screen reader announces.
      expect(el.getAttribute('aria-label')).toBe(`${collection} — Staging (read-only)`);
    }

    // The writable Connection's tabs are untouched.
    for (const collection of ['alpha', 'bravo']) {
      const el = tab(collection);
      expect(within(el).queryByText('RO')).toBeNull();
      expect(el.getAttribute('aria-label')).toBe(`${collection} — Prod`);
    }
  });

  // Both markers, on one tab: pinned and read-only are independent facts and
  // neither may hide the other.
  it('shows the read-only marker alongside the pinned marker', async () => {
    mountTwoConnections();
    await waitFor(() => expect(tabOrder()).toHaveLength(4));

    fireEvent.contextMenu(tab('xray'));
    await userEvent.click(await screen.findByText('Pin tab'));

    await waitFor(() => expect(within(tab('xray')).getByLabelText('Pinned')).toBeTruthy());
    expect(within(tab('xray')).getByLabelText('Read-only')).toBeTruthy();
  });

  // #55 — the shared ContextMenu had no keyboard open path; TabStrip is one
  // of its two real call sites (the other is DbCollectionNavigator) and each
  // tab is already its own focusable element, so `e.currentTarget` doubles as
  // both the anchor and the focus-return target.
  describe('keyboard: opening the tab context menu (#55)', () => {
    it('Shift+F10 opens the menu for that tab', async () => {
      mountTwoConnections();
      await waitFor(() => expect(tabOrder()).toHaveLength(4));

      fireEvent.keyDown(tab('bravo'), { key: 'F10', shiftKey: true });

      expect(await screen.findByRole('menuitem', { name: 'Pin tab' })).toBeTruthy();
    });

    it('the ContextMenu key opens the same menu', async () => {
      mountTwoConnections();
      await waitFor(() => expect(tabOrder()).toHaveLength(4));

      fireEvent.keyDown(tab('bravo'), { key: 'ContextMenu' });

      expect(await screen.findByRole('menuitem', { name: 'Pin tab' })).toBeTruthy();
    });

    it('focus enters the menu on open and Escape returns it to the tab', async () => {
      mountTwoConnections();
      await waitFor(() => expect(tabOrder()).toHaveLength(4));
      const bravo = tab('bravo');

      fireEvent.keyDown(bravo, { key: 'ContextMenu' });
      await screen.findByRole('menuitem', { name: 'Pin tab' });
      await waitFor(() =>
        expect(document.activeElement?.closest('[role="menu"]')).toBeTruthy(),
      );

      fireEvent.keyDown(document.activeElement!, { key: 'Escape' });

      await waitFor(() => expect(document.activeElement).toBe(bravo));
    });

    // Close, unlike Pin/Unpin, destroys `returnFocusTo`'s own DOM node (the
    // tab element itself) once `tabs.close` resolves and the tab unmounts.
    // Focusing a detached node is a silent no-op, so the browser drops focus
    // to `<body>` — reproduced here before the fix by pointing at the strip
    // container instead.
    it('Close tab does not drop focus to the body', async () => {
      mountTwoConnections();
      await waitFor(() => expect(tabOrder()).toHaveLength(4));
      const bravo = tab('bravo');

      fireEvent.keyDown(bravo, { key: 'ContextMenu' });
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Close tab' }));

      await waitFor(() => expect(tabOrder()).toHaveLength(3));
      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement).toBe(screen.getByRole('tablist', { name: 'Open tabs' }));
    });

    // The closed tab was the last one on screen — nothing to its right to
    // (mis)focus instead, and the strip container must still be there.
    it('Close tab still lands focus somewhere sensible when it was the last tab', async () => {
      mountTwoConnections();
      await waitFor(() => expect(tabOrder()).toHaveLength(4));
      const yankee = tab('yankee');

      fireEvent.keyDown(yankee, { key: 'ContextMenu' });
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Close tab' }));

      await waitFor(() => expect(tabOrder()).toHaveLength(3));
      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement).toBe(screen.getByRole('tablist', { name: 'Open tabs' }));
    });

    // Closing the only open tab empties the strip entirely — the container
    // is the only thing left that could possibly hold focus.
    it('Close tab does not drop focus to the body when it was the only tab', async () => {
      installAtelierMock({
        ...multiConnectionMock({
          connections: [{ id: 'c1', name: 'Prod' }],
          tabs: [{ id: 'a', connectionId: 'c1', collection: 'alpha', isActive: true }],
        }),
      });
      render(
        <MemoryRouter initialEntries={['/workspace']}>
          <Workspace />
        </MemoryRouter>,
      );
      await waitFor(() => expect(tabOrder()).toHaveLength(1));
      const alpha = tab('alpha');

      fireEvent.keyDown(alpha, { key: 'ContextMenu' });
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Close tab' }));

      // `getAllByRole` throws on zero matches — the strip is genuinely empty
      // now, so this reads the tab count without that throw.
      await waitFor(() => expect(strip().queryAllByRole('tab')).toHaveLength(0));
      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement).toBe(screen.getByRole('tablist', { name: 'Open tabs' }));
    });

    // #69 — the mouse path (`onContextMenu`) used to leave `returnFocusTo`
    // unset, so a right-click-opened menu closed without restoring focus
    // anywhere. It now passes `e.currentTarget` (the tab itself), same as
    // the keyboard path above.
    it('a right-click-opened menu closes and returns focus to the tab, not <body>', async () => {
      mountTwoConnections();
      await waitFor(() => expect(tabOrder()).toHaveLength(4));
      const bravo = tab('bravo');

      fireEvent.contextMenu(bravo);
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin tab' }));

      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement).toBe(bravo);
    });
  });

  it('reorders a tab dropped on a sibling of its own Connection', async () => {
    mountTwoConnections();
    await waitFor(() => expect(tabOrder()).toHaveLength(4));

    fireEvent.dragStart(tab('bravo'));
    fireEvent.dragOver(tab('alpha'));
    fireEvent.drop(tab('alpha'));

    await waitFor(() =>
      expect(tabOrder()).toEqual([
        'bravo — Prod',
        'alpha — Prod',
        'xray — Staging (read-only)',
        'yankee — Staging (read-only)',
      ]),
    );
    // The other Connection's group did not move.
    expect(chipOrder()).toEqual(['Prod', 'Staging (read-only)']);
  });

  it('leaves the order unchanged when a tab is dropped on another Connection', async () => {
    mountTwoConnections();
    await waitFor(() => expect(tabOrder()).toHaveLength(4));

    // The first tab of the second group onto the first tab of the first: were
    // the drop permitted, `xray` would land at the head of the strip and take
    // its chip with it, so both sequences below would change.
    fireEvent.dragStart(tab('xray'));
    fireEvent.dragOver(tab('alpha'));
    fireEvent.drop(tab('alpha'));

    await waitFor(() => expect(chipOrder()).toEqual(['Prod', 'Staging (read-only)']));
    expect(tabOrder()).toEqual([
      'alpha — Prod',
      'bravo — Prod',
      'xray — Staging (read-only)',
      'yankee — Staging (read-only)',
    ]);
  });

  it('reorders inside the group without moving an interleaved Connection', async () => {
    const reorder = mountInterleaved();
    await waitFor(() => expect(tabOrder()).toHaveLength(3));

    fireEvent.dragStart(tab('alpha'));
    fireEvent.dragOver(tab('charlie'));
    fireEvent.drop(tab('charlie'));

    // What the person dragged happened...
    await waitFor(() =>
      expect(tabOrder()).toEqual([
        'charlie — Prod',
        'alpha — Prod',
        'bravo — Staging (read-only)',
      ]),
    );
    // ...and nothing else did: Staging is still the second group.
    expect(chipOrder()).toEqual(['Prod', 'Staging (read-only)']);
    // `bravo` keeps slot 1 of the stored order — it belongs to a Connection
    // nobody dragged, and its `position` must not move.
    expect(reorder.mock.calls.at(-1)?.[0]).toEqual(['a2', 'b1', 'a1']);
  });

  it('is one group, and usable, with a single Connection open', async () => {
    installAtelierMock({
      ...multiConnectionMock({
        connections: [{ id: 'c1', name: 'Prod' }],
        tabs: [
          { id: 'a', connectionId: 'c1', collection: 'alpha', isActive: true },
          { id: 'b', connectionId: 'c1', collection: 'bravo' },
        ],
      }),
    });
    render(
      <MemoryRouter initialEntries={['/workspace']}>
        <Workspace />
      </MemoryRouter>,
    );

    await waitFor(() => expect(chipOrder()).toEqual(['Prod']));

    // The keyboard contract survives grouping: exactly one tab is in the tab
    // order, and it is the focused one.
    expect(tab('alpha').getAttribute('aria-selected')).toBe('true');
    expect(strip().getAllByRole('tab').map((t) => t.getAttribute('tabindex'))).toEqual(['0', '-1']);

    await userEvent.click(tab('bravo'));

    await waitFor(() => expect(tab('bravo').getAttribute('aria-selected')).toBe('true'));
    expect(tab('alpha').getAttribute('aria-selected')).toBe('false');
    expect(strip().getAllByRole('tab').map((t) => t.getAttribute('tabindex'))).toEqual(['-1', '0']);
  });
});

/**
 * X16 §5 — pinning moves a tab within its own group, not the group.
 *
 * Three Connections, so "group order unchanged" can fail in more than one
 * way, and the tab we pin (`delta`) belongs to Staging, which does not start
 * first — the old bug (float-to-global-index-0) only moves something when
 * the pinned tab's group isn't already at the head. `alpha`/`charlie` (Prod)
 * and `bravo`/`delta` (Staging) interleave in stored `position` order too,
 * which is what tells apart "group order from first appearance in stored
 * order" (correct) from "group order from the first tab's global position"
 * (still wrong — a pinned tab's `position` doesn't move, but grouping off
 * the pinned-sorted array picks the pinned tab as that "first" one, whose
 * raw position can sort its whole group later or earlier than it belongs).
 */
function mountThreeConnections() {
  installAtelierMock({
    ...multiConnectionMock({
      connections: [
        { id: 'c1', name: 'Prod' },
        { id: 'c2', name: 'Staging', color: '#8A4B00' },
        { id: 'c3', name: 'QA' },
      ],
      tabs: [
        { id: 'a1', connectionId: 'c1', collection: 'alpha', isActive: true },
        { id: 'b1', connectionId: 'c2', collection: 'bravo' },
        { id: 'q1', connectionId: 'c3', collection: 'quebec' },
        { id: 'a2', connectionId: 'c1', collection: 'charlie' },
        { id: 'b2', connectionId: 'c2', collection: 'delta' },
      ],
    }),
  });
  render(
    <MemoryRouter initialEntries={['/workspace']}>
      <Workspace />
    </MemoryRouter>,
  );
}

async function pin(collection: string) {
  fireEvent.contextMenu(tab(collection));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Pin tab' }));
}

async function unpin(collection: string) {
  fireEvent.contextMenu(tab(collection));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Unpin tab' }));
}

describe('pinning a tab moves it within its group, not the group', () => {
  it('floats the pinned tab to the front of its own group, leaving group order alone', async () => {
    mountThreeConnections();
    await waitFor(() => expect(tabOrder()).toHaveLength(5));

    await pin('delta');

    await waitFor(() =>
      expect(tabOrder()).toEqual([
        'alpha — Prod',
        'charlie — Prod',
        'delta — Staging',
        'bravo — Staging',
        'quebec — QA',
      ]),
    );
    // Staging stays second — pinning `delta` did not drag its group to the
    // head, and did not drag QA ahead of it either.
    expect(chipOrder()).toEqual(['Prod', 'Staging', 'QA']);
  });

  it('unpinning restores the tab to its place in its group without moving any group', async () => {
    mountThreeConnections();
    await waitFor(() => expect(tabOrder()).toHaveLength(5));

    await pin('delta');
    await waitFor(() => expect(tabOrder()).toEqual([
      'alpha — Prod',
      'charlie — Prod',
      'delta — Staging',
      'bravo — Staging',
      'quebec — QA',
    ]));

    await unpin('delta');

    await waitFor(() =>
      expect(tabOrder()).toEqual([
        'alpha — Prod',
        'charlie — Prod',
        'bravo — Staging',
        'delta — Staging',
        'quebec — QA',
      ]),
    );
    expect(chipOrder()).toEqual(['Prod', 'Staging', 'QA']);
  });

  it('keeps group order stable for a tab that is already pinned on load', async () => {
    // `tabs.list()` (real SQL: `ORDER BY pinned DESC, position ASC`) delivers
    // the pinned tab first in the array, same as the optimistic sort above —
    // this exercises the load path instead of the `setPinned` mutation path.
    installAtelierMock({
      ...multiConnectionMock({
        connections: [
          { id: 'c1', name: 'Prod' },
          { id: 'c2', name: 'Staging', color: '#8A4B00' },
          { id: 'c3', name: 'QA' },
        ],
        tabs: [
          { id: 'b2', connectionId: 'c2', collection: 'delta', pinned: true, position: 4 },
          { id: 'a1', connectionId: 'c1', collection: 'alpha', isActive: true, position: 0 },
          { id: 'b1', connectionId: 'c2', collection: 'bravo', position: 1 },
          { id: 'q1', connectionId: 'c3', collection: 'quebec', position: 2 },
          { id: 'a2', connectionId: 'c1', collection: 'charlie', position: 3 },
        ],
      }),
    });
    render(
      <MemoryRouter initialEntries={['/workspace']}>
        <Workspace />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(tabOrder()).toEqual([
        'alpha — Prod',
        'charlie — Prod',
        'delta — Staging',
        'bravo — Staging',
        'quebec — QA',
      ]),
    );
    expect(chipOrder()).toEqual(['Prod', 'Staging', 'QA']);
  });

  it('an in-group drag after pinning elsewhere does not renumber positions pinned-first', async () => {
    // An earlier fix addressed how `groupTabsByConnection` *reads* `position`; this is the
    // other end — `TabStrip`'s `handleDrop` *writing* it. Reproduce: pin a
    // Staging tab (groups stay Prod, Staging, QA), then drag-reorder
    // the two Prod tabs — a change entirely inside Prod's group. If
    // `handleDrop` still built the reordered id list off the pinned-sorted
    // `tabs` prop, every pinned tab (Staging's `delta`) would be renumbered
    // ahead of every unpinned tab (Prod's, QA's), and Staging's group would
    // jump ahead of Prod's the next time `groupTabsByConnection` reads it.
    const reorder = vi.fn<(ids: string[]) => Promise<{ ok: true }>>(async () => ({
      ok: true,
    }));
    const mock = multiConnectionMock({
      connections: [
        { id: 'c1', name: 'Prod' },
        { id: 'c2', name: 'Staging', color: '#8A4B00' },
        { id: 'c3', name: 'QA' },
      ],
      tabs: [
        { id: 'a1', connectionId: 'c1', collection: 'alpha', isActive: true },
        { id: 'b1', connectionId: 'c2', collection: 'bravo' },
        { id: 'q1', connectionId: 'c3', collection: 'quebec' },
        { id: 'a2', connectionId: 'c1', collection: 'charlie' },
        { id: 'b2', connectionId: 'c2', collection: 'delta' },
      ],
    });
    installAtelierMock({ ...mock, tabs: { ...mock.tabs, reorder } });
    render(
      <MemoryRouter initialEntries={['/workspace']}>
        <Workspace />
      </MemoryRouter>,
    );
    await waitFor(() => expect(tabOrder()).toHaveLength(5));

    // Pin `delta` (Staging) — this is what floats a pinned tab ahead of every
    // unpinned tab in the client-side `tabs` array (`setPinned`'s optimistic
    // sort), the exact array `handleDrop` used to trust.
    await pin('delta');
    await waitFor(() =>
      expect(tabOrder()).toEqual([
        'alpha — Prod',
        'charlie — Prod',
        'delta — Staging',
        'bravo — Staging',
        'quebec — QA',
      ]),
    );
    expect(chipOrder()).toEqual(['Prod', 'Staging', 'QA']);

    // Now drag-reorder within Prod only — unrelated to Staging or pinning.
    fireEvent.dragStart(tab('alpha'));
    fireEvent.dragOver(tab('charlie'));
    fireEvent.drop(tab('charlie'));

    await waitFor(() =>
      expect(tabOrder()).toEqual([
        'charlie — Prod',
        'alpha — Prod',
        // `delta` (pinned) still renders ahead of `bravo`: `reorder()` writes
        // `position` from the raw-position-ordered list `handleDrop` now
        // builds (so the *persisted* order never goes pinned-first), but then
        // re-sorts its own optimistic state pinned-first
        // before rendering, same as `setPinned` and the server's `ORDER BY
        // pinned DESC, position ASC` — so the screen doesn't flicker out of
        // pinned-first order for a group nobody dragged.
        'delta — Staging',
        'bravo — Staging',
        'quebec — QA',
      ]),
    );
    // The point of this test: group order must not change from an in-group drag.
    expect(chipOrder()).toEqual(['Prod', 'Staging', 'QA']);
    // The *written* order handed to `api.tabs.reorder` (and so the persisted
    // `position` values) is raw-position order, not pinned-first — `bravo`
    // still precedes `delta` there, both still precede `quebec` — rather
    // than being renumbered pinned-first (`delta` jumping ahead of
    // everything unpinned, which is exactly the bug this guards against).
    expect(reorder.mock.calls.at(-1)?.[0]).toEqual(['a2', 'b1', 'q1', 'a1', 'b2']);
  });
});

/**
 * X16 §4.4 / W01 — cycling the Focused Tab with `⌘⌥→` / `⌘⌥←`.
 *
 * The chord is mod+Alt+Arrow, not bare Alt: `Workspace`'s listener returns
 * early unless ⌘ or Ctrl is held, so a bare-Alt press reaches nothing.
 *
 * Every case below runs on the *interleaved* fixture, where the stored order
 * `alpha(c1), bravo(c2), charlie(c1)` renders as `alpha, charlie | bravo`. A
 * contiguous fixture cannot tell the two orders apart, so it would pass with
 * the cycling pointed back at the raw global array.
 */
describe('tab cycling follows the strip, not the stored order', () => {
  const cycle = (key: 'ArrowRight' | 'ArrowLeft') =>
    fireEvent.keyDown(window, { key, altKey: true, metaKey: true });

  /** Focus a tab the way a person would, and wait for the strip to say so. */
  async function focus(collection: string) {
    await userEvent.click(tab(collection));
    await waitFor(() =>
      expect(tab(collection).getAttribute('aria-selected')).toBe('true'),
    );
  }

  function focusedTab() {
    return strip()
      .getAllByRole('tab')
      .find((t) => t.getAttribute('aria-selected') === 'true')
      ?.getAttribute('aria-label');
  }

  it('moves to the tab visually to the right, not the next stored one', async () => {
    mountInterleaved();
    await waitFor(() =>
      expect(tabOrder()).toEqual([
        'alpha — Prod',
        'charlie — Prod',
        'bravo — Staging (read-only)',
      ]),
    );

    // Stored, the tab after `alpha` is `bravo` — on screen it is `charlie`.
    cycle('ArrowRight');

    await waitFor(() => expect(focusedTab()).toBe('charlie — Prod'));
    // Roving tabindex: still exactly one tab in the tab order, and it
    // is the newly focused one — in the grouped DOM, not just a flat strip.
    expect(strip().getAllByRole('tab').map((t) => t.getAttribute('tabindex'))).toEqual([
      '-1',
      '0',
      '-1',
    ]);
  });

  it('crosses the group boundary in the direction the user sees', async () => {
    mountInterleaved();
    await waitFor(() => expect(tabOrder()).toHaveLength(3));
    await focus('charlie');

    // `charlie` is last in its group and last in the stored order; the tab to
    // its right belongs to the next group, so ⌘⌥→ leaves Prod for Staging.
    cycle('ArrowRight');

    await waitFor(() => expect(focusedTab()).toBe('bravo — Staging (read-only)'));
  });

  it('wraps at the ends of the rendered strip, not the stored array', async () => {
    mountInterleaved();
    await waitFor(() => expect(tabOrder()).toHaveLength(3));
    await focus('bravo');

    // `bravo` is the rightmost tab on screen but the middle of the stored
    // order, so wrapping is what proves which array is being walked.
    cycle('ArrowRight');
    await waitFor(() => expect(focusedTab()).toBe('alpha — Prod'));

    // And the leftmost wraps back to the rightmost.
    cycle('ArrowLeft');
    await waitFor(() => expect(focusedTab()).toBe('bravo — Staging (read-only)'));
  });

  it('jumps to the Nth tab on screen, not the Nth stored', async () => {
    mountInterleaved();
    await waitFor(() => expect(tabOrder()).toHaveLength(3));

    // `⌘1` cannot tell the two orders apart — the first stored tab is always
    // the first rendered one. `⌘2` can: stored it is `bravo`, on screen it is
    // `charlie`.
    fireEvent.keyDown(window, { key: '2', metaKey: true });

    await waitFor(() => expect(focusedTab()).toBe('charlie — Prod'));
  });

  it('moves to the tab visually to the left', async () => {
    mountInterleaved();
    await waitFor(() => expect(tabOrder()).toHaveLength(3));
    await focus('bravo');

    // Stored, the tab before `bravo` is `alpha`; on screen it is `charlie`.
    cycle('ArrowLeft');

    await waitFor(() => expect(focusedTab()).toBe('charlie — Prod'));
  });
});

/**
 * X16 §5 — a tab whose Connection is absent from the list.
 *
 * The list loads asynchronously today, and Dormant Connections makes
 * that window deliberate rather than transient. One strip holds all three
 * cases at once, because each one only proves anything against the others: a
 * fixture where every tab resolves cannot fail the unresolved case, and a
 * fixture with one Connection cannot show that the *other* groups keep their
 * real names.
 */
describe('an unresolved Connection is labelled as a state, not a name', () => {
  function mountWithUnresolved() {
    installAtelierMock({
      ...multiConnectionMock({
        connections: [
          { id: 'c1', name: 'Prod' },
          // Dormant: in the list, no live client. Its name is real.
          { id: 'c2', name: 'Staging', status: 'disconnected' },
          // Note there is no `c9` — `ghost` below belongs to nothing yet.
        ],
        tabs: [
          { id: 'a', connectionId: 'c1', collection: 'alpha', isActive: true },
          { id: 's', connectionId: 'c2', collection: 'sierra' },
          { id: 'g', connectionId: 'c9', collection: 'ghost' },
        ],
      }),
    });
    render(
      <MemoryRouter initialEntries={['/workspace']}>
        <Workspace />
      </MemoryRouter>,
    );
  }

  it('names the resolved and Dormant Connections, and only states the unresolved one', async () => {
    mountWithUnresolved();

    await waitFor(() =>
      expect(chipOrder()).toEqual(['Prod', 'Staging', '(unresolved connection)']),
    );
    // The chip is the visible text too, not just the accessible name.
    const ghost = strip().getByRole('group', { name: '(unresolved connection)' });
    expect(within(ghost).getByText('(unresolved connection)')).toBeTruthy();
    // Nothing anywhere in the strip reads as a Connection called "Connection".
    expect(strip().queryByRole('group', { name: 'Connection' })).toBeNull();
    expect(strip().queryByText('Connection')).toBeNull();
  });

  it('carries the same wording into every tab of that group', async () => {
    mountWithUnresolved();

    // The tab's accessible name interpolates the group's name, so the literal
    // fallback would have told a screen-reader user "ghost — Connection".
    await waitFor(() =>
      expect(tabOrder()).toEqual([
        'alpha — Prod',
        'sierra — Staging',
        'ghost — (unresolved connection)',
      ]),
    );
  });
});

/**
 * X16.5, spec §4.7 — a Dormant Connection's tabs render visibly muted
 * but stay clickable, and clicking one is the wake gesture: it connects that
 * Connection. `styleOf` reads the inline style the same way
 * `navigator-accordion.spec.tsx`'s `spineOf` does — this is a rendering
 * decision, not a class name to snapshot.
 */
describe('a Dormant Connection\'s tabs are muted but clickable, and waking one connects it', () => {
  function mountWithDormant(connect = vi.fn(async (id: string) => ({ id, status: 'connecting' as const }))) {
    installAtelierMock({
      ...multiConnectionMock({
        connections: [
          { id: 'c1', name: 'Prod' },
          { id: 'c2', name: 'Staging', status: 'disconnected' },
        ],
        tabs: [
          { id: 'a', connectionId: 'c1', collection: 'alpha', isActive: true },
          { id: 's', connectionId: 'c2', collection: 'sierra' },
        ],
      }),
      mongo: { connect },
    });
    render(
      <MemoryRouter initialEntries={['/workspace']}>
        <Workspace />
      </MemoryRouter>,
    );
    return connect;
  }

  const styleOf = (el: HTMLElement) => el.getAttribute('style') ?? '';

  it('renders the Dormant tab visibly muted relative to a Connected one', async () => {
    mountWithDormant();
    await waitFor(() => expect(tabOrder()).toHaveLength(2));

    // `sierra` (Staging, Dormant) reads dimmer than `alpha` (Prod, connected
    // and active) — a lowered opacity on the Dormant tab and not on the
    // other one is exactly the "muted, not disabled" signal the AC asks for.
    expect(styleOf(tab('sierra'))).toContain('opacity: 0.6');
    expect(styleOf(tab('alpha'))).not.toContain('opacity: 0.6');
  });

  it('stays clickable: clicking the Dormant tab still activates it', async () => {
    mountWithDormant();
    await waitFor(() => expect(tabOrder()).toHaveLength(2));

    await userEvent.click(tab('sierra'));

    await waitFor(() => expect(tab('sierra').getAttribute('aria-selected')).toBe('true'));
    expect(tab('alpha').getAttribute('aria-selected')).toBe('false');
  });

  it('clicking a Dormant tab connects its Connection', async () => {
    const connect = mountWithDormant();
    await waitFor(() => expect(tabOrder()).toHaveLength(2));

    await userEvent.click(tab('sierra'));

    await waitFor(() => expect(connect).toHaveBeenCalledWith('c2'));
  });

  it('clicking an already-connected tab does not call connect again', async () => {
    const connect = mountWithDormant();
    await waitFor(() => expect(tabOrder()).toHaveLength(2));
    // `alpha` is already the Focused Tab on the already-connected `c1`.
    connect.mockClear();

    await userEvent.click(tab('alpha'));

    expect(connect).not.toHaveBeenCalled();
  });
});

/**
 * Dormant is one of four runtime states X16 §5 names (Open, Dormant,
 * Connecting, Failed), and only Dormant earns the muted treatment (§6, and the
 * AC "A tab of a Dormant Connection renders muted"). Connecting and Failed
 * also have no live client, so the broad `isKnownNotConnected` was true for
 * them too and muted all three identically.
 *
 * All four states sit in one strip on purpose: muting is only ever visible
 * *relative* to another tab, and a fixture holding one state cannot show that
 * the others render differently. `data-dormant` is the assertion rather than
 * the opacity, because 0.6 is also the drag opacity (TabStrip.tsx) — the
 * attribute is the purpose-built signal, and e2e already keys off it.
 */
describe('only a genuinely Dormant Connection gets the muted treatment', () => {
  function mountFourStates() {
    installAtelierMock({
      ...multiConnectionMock({
        connections: [
          { id: 'c1', name: 'Prod' },
          { id: 'c2', name: 'Staging', status: 'disconnected' },
          { id: 'c3', name: 'Canary', status: 'connecting' },
          { id: 'c4', name: 'Legacy', status: 'error' },
        ],
        tabs: [
          { id: 'a', connectionId: 'c1', collection: 'alpha', isActive: true },
          { id: 's', connectionId: 'c2', collection: 'sierra' },
          { id: 'c', connectionId: 'c3', collection: 'charlie' },
          { id: 'l', connectionId: 'c4', collection: 'lima' },
        ],
      }),
    });
    render(
      <MemoryRouter initialEntries={['/workspace']}>
        <Workspace />
      </MemoryRouter>,
    );
  }

  const muted = (collection: string) => tab(collection).hasAttribute('data-dormant');

  it('mutes the Dormant tab and leaves the Connected one alone', async () => {
    mountFourStates();
    await waitFor(() => expect(tabOrder()).toHaveLength(4));

    expect(muted('sierra')).toBe(true);
    expect(muted('alpha')).toBe(false);
  });

  it('does not mute a tab whose Connection is still connecting', async () => {
    mountFourStates();
    await waitFor(() => expect(tabOrder()).toHaveLength(4));

    // Connecting shows progress on its own navigator root; muting it here
    // would make it indistinguishable from Dormant in the strip.
    expect(muted('charlie')).toBe(false);
  });

  it('does not mute a tab whose Connection failed to connect', async () => {
    mountFourStates();
    await waitFor(() => expect(tabOrder()).toHaveLength(4));

    // Failed shows the error and a Retry on its root — also not Dormant.
    expect(muted('lima')).toBe(false);
  });
});

describe('the tab context menu closes in bulk and reveals a tab in the sidebar', () => {
  type TabSpec = Parameters<typeof multiConnectionMock>[0]['tabs'];

  const collInfo = (name: string) => ({
    name,
    type: 'collection' as const,
    documentCount: 0,
    sizeBytes: 0,
    indexCount: 0,
    capped: false,
  });
  type Lister = (a: { connectionId: string; dbName: string }) => Promise<ReturnType<typeof collInfo>[]>;

  function mountTabs(
    tabs: TabSpec,
    opts: { dbs?: string[]; listCollections?: Lister } = {},
  ) {
    const mock = multiConnectionMock({
      connections: [
        { id: 'c1', name: 'Prod' },
        { id: 'c2', name: 'Staging', color: '#8A4B00' },
      ],
      tabs,
    });
    const close = vi.fn(mock.tabs!.close!);
    installAtelierMock({
      ...mock,
      tabs: { ...mock.tabs, close, reorder: async () => ({ ok: true as const }) },
      meta: {
        listDatabases: async () =>
          (opts.dbs ?? ['db']).map((name) => ({ name, sizeOnDisk: 1, empty: false })),
        listCollections: (opts.listCollections ??
          (async () => ['alpha', 'bravo', 'charlie'].map(collInfo))) as never,
      },
    });
    render(
      <MemoryRouter initialEntries={['/workspace']}>
        <Workspace />
      </MemoryRouter>,
    );
    return { close };
  }

  const closedIds = (close: ReturnType<typeof vi.fn>) =>
    close.mock.calls.map(([id]) => id as string).sort((a, b) => a.localeCompare(b));

  /** Mantine renders a disabled item as a disabled button, without aria-disabled. */
  function isDisabled(name: string): boolean {
    const el = screen.getByRole('menuitem', { name });
    return el.hasAttribute('disabled') || el.hasAttribute('data-disabled');
  }

  it('offers Close others, Close to the right and Reveal in sidebar beside Pin and Close', async () => {
    mountTwoConnections();
    await waitFor(() => expect(tabOrder()).toHaveLength(4));

    fireEvent.contextMenu(tab('bravo'));

    const names = (await screen.findAllByRole('menuitem')).map((m) => m.textContent);
    expect(names).toEqual([
      'Pin tab',
      'Close tab',
      'Close others',
      'Close to the right',
      'Reveal in sidebar',
    ]);
  });

  it('offers no Reveal in sidebar for a script tab, which has no navigator row', async () => {
    const mock = multiConnectionMock({
      connections: [{ id: 'c1', name: 'Prod' }],
      tabs: [{ id: 'a', connectionId: 'c1', collection: 'alpha', isActive: true }],
    });
    const script: WorkspaceTab = {
      id: 's1',
      kind: 'script' as const,
      connectionId: 'c1',
      dbName: '',
      collection: '',
      position: 1,
      isActive: false,
      openedAt: '2026-07-26T12:00:00.000Z',
      pinned: false,
      state: { title: 'Script', source: '1', dbName: 'db' },
    };
    const rows = await mock.tabs!.list!();
    installAtelierMock({ ...mock, tabs: { ...mock.tabs, list: async () => [...rows, script] } });
    render(
      <MemoryRouter initialEntries={['/workspace']}>
        <Workspace />
      </MemoryRouter>,
    );
    await waitFor(() => expect(tabOrder()).toHaveLength(2));

    fireEvent.contextMenu(strip().getByRole('tab', { name: /^Script / }));

    await screen.findByRole('menuitem', { name: 'Close others' });
    expect(screen.queryByRole('menuitem', { name: 'Reveal in sidebar' })).toBeNull();
  });

  it('Close others closes every other unpinned tab, keeping the target and pinned tabs', async () => {
    const { close } = mountTabs([
      { id: 'a', connectionId: 'c1', collection: 'alpha', isActive: true },
      { id: 'b', connectionId: 'c1', collection: 'bravo' },
      { id: 'x', connectionId: 'c2', collection: 'xray', pinned: true },
      { id: 'y', connectionId: 'c2', collection: 'yankee' },
    ]);
    await waitFor(() => expect(tabOrder()).toHaveLength(4));

    fireEvent.contextMenu(tab('bravo'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Close others' }));

    await waitFor(() => expect(closedIds(close)).toEqual(['a', 'y']));
    await waitFor(() => expect(tabOrder()).toHaveLength(2));
  });

  it('Close to the right follows the strip’s grouped order, not the stored order', async () => {
    // Stored: alpha(Prod), bravo(Staging), charlie(Prod). On screen the Prod
    // group comes first: alpha, charlie | bravo. Right of charlie on screen is
    // bravo; right of charlie in the stored order is nothing.
    const { close } = mountTabs([
      { id: 'a1', connectionId: 'c1', collection: 'alpha', isActive: true },
      { id: 'b1', connectionId: 'c2', collection: 'bravo' },
      { id: 'a2', connectionId: 'c1', collection: 'charlie' },
    ]);
    await waitFor(() => expect(tabOrder()).toHaveLength(3));

    fireEvent.contextMenu(tab('charlie'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Close to the right' }));

    await waitFor(() => expect(closedIds(close)).toEqual(['b1']));
  });

  it('disables Close to the right on the last tab on screen, and Close others when nothing else is closable', async () => {
    mountTabs([
      { id: 'a1', connectionId: 'c1', collection: 'alpha', isActive: true, pinned: true },
      { id: 'b1', connectionId: 'c2', collection: 'bravo' },
      { id: 'a2', connectionId: 'c1', collection: 'charlie' },
    ]);
    await waitFor(() => expect(tabOrder()).toHaveLength(3));

    // bravo is last on screen though not last in the stored order.
    fireEvent.contextMenu(tab('bravo'));
    await screen.findByRole('menuitem', { name: 'Close to the right' });
    expect(isDisabled('Close to the right')).toBe(true);
    expect(isDisabled('Close others')).toBe(false);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });

    // charlie: the only other closable tab is bravo (alpha is pinned).
    fireEvent.contextMenu(tab('charlie'));
    await screen.findByRole('menuitem', { name: 'Close others' });
    expect(isDisabled('Close to the right')).toBe(false);
  });

  it('leaves the tabs of a collapsed group alone: they are not on screen', async () => {
    const { close } = mountTabs([
      { id: 'a', connectionId: 'c1', collection: 'alpha', isActive: true },
      { id: 'b', connectionId: 'c1', collection: 'bravo' },
      { id: 'x', connectionId: 'c2', collection: 'xray' },
    ]);
    await waitFor(() => expect(tabOrder()).toHaveLength(3));
    const staging = strip().getByRole('group', { name: 'Staging' });
    fireEvent.click(within(staging).getByRole('button', { name: 'Collapse group' }));
    await waitFor(() => expect(tabOrder()).toHaveLength(2));

    fireEvent.contextMenu(tab('alpha'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Close to the right' }));
    await waitFor(() => expect(tabOrder()).toHaveLength(1));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(closedIds(close)).toEqual(['b']);

    fireEvent.contextMenu(tab('alpha'));
    await screen.findByRole('menuitem', { name: 'Close others' });
    expect(isDisabled('Close others')).toBe(true);
    expect(isDisabled('Close to the right')).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });

    fireEvent.click(within(staging).getByRole('button', { name: 'Expand group' }));
    expect(await strip().findByRole('tab', { name: /^xray / })).toBeTruthy();
  });

  it('Close others on a background tab hands the focus to that tab, not a closed one', async () => {
    const { close } = mountTabs([
      { id: 'a', connectionId: 'c1', collection: 'alpha', isActive: true },
      { id: 'b', connectionId: 'c1', collection: 'bravo' },
      { id: 'c', connectionId: 'c1', collection: 'charlie' },
    ]);
    await waitFor(() => expect(tabOrder()).toHaveLength(3));

    fireEvent.contextMenu(tab('bravo'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Close others' }));

    await waitFor(() => expect(closedIds(close)).toEqual(['a', 'c']));
    await waitFor(() => expect(tabOrder()).toHaveLength(1));
    expect(tab('bravo').getAttribute('aria-selected')).toBe('true');
  });

  it('a tab that fails to close is reported, and the rest still close', async () => {
    const { close } = mountTabs([
      { id: 'a', connectionId: 'c1', collection: 'alpha', isActive: true },
      { id: 'b', connectionId: 'c1', collection: 'bravo' },
      { id: 'c', connectionId: 'c1', collection: 'charlie' },
      { id: 'd', connectionId: 'c1', collection: 'delta' },
    ]);
    const realClose = close.getMockImplementation()!;
    close.mockImplementation(async (id: string) => {
      if (id === 'c') throw new Error('database is locked');
      return realClose(id);
    });
    const notifyError = vi.spyOn(notify, 'error');
    try {
      await waitFor(() => expect(tabOrder()).toHaveLength(4));

      fireEvent.contextMenu(tab('alpha'));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Close others' }));

      await waitFor(() => expect(closedIds(close)).toEqual(['b', 'c', 'd']));
      await waitFor(() =>
        expect(notifyError).toHaveBeenCalledWith('1 tab could not be closed: database is locked'),
      );
      await waitFor(() => expect(tabOrder()).toHaveLength(2));
      expect(strip().getByRole('tab', { name: /^charlie / })).toBeTruthy();
    } finally {
      notifyError.mockRestore();
    }
  });

  it('disables Close others when every other tab is pinned', async () => {
    mountTabs([
      { id: 'a', connectionId: 'c1', collection: 'alpha', isActive: true, pinned: true },
      { id: 'b', connectionId: 'c1', collection: 'bravo' },
    ]);
    await waitFor(() => expect(tabOrder()).toHaveLength(2));

    fireEvent.contextMenu(tab('bravo'));
    await screen.findByRole('menuitem', { name: 'Close others' });
    expect(isDisabled('Close others')).toBe(true);
  });

  it('asks once before closing tabs with unsaved pipelines, and Cancel closes nothing', async () => {
    const dirty = {
      ...collectionTabFixture().state,
      aggregation: { ...DEFAULT_AGGREGATION_TAB_STATE, dirty: true },
    };
    const { close } = mountTabs([
      { id: 'a', connectionId: 'c1', collection: 'alpha', isActive: true },
      { id: 'b', connectionId: 'c1', collection: 'bravo', state: dirty },
      { id: 'c', connectionId: 'c1', collection: 'charlie', state: dirty },
    ]);
    await waitFor(() => expect(tabOrder()).toHaveLength(3));

    fireEvent.contextMenu(tab('alpha'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Close to the right' }));

    const dialogs = await screen.findAllByRole('dialog');
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]!.textContent).toMatch(/2 tabs/);
    fireEvent.click(within(dialogs[0]!).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(close).not.toHaveBeenCalled();
    expect(tabOrder()).toHaveLength(3);
  });

  it('closes them all once the unsaved-pipeline prompt is confirmed', async () => {
    const dirty = {
      ...collectionTabFixture().state,
      aggregation: { ...DEFAULT_AGGREGATION_TAB_STATE, dirty: true },
    };
    const { close } = mountTabs([
      { id: 'a', connectionId: 'c1', collection: 'alpha', isActive: true },
      { id: 'b', connectionId: 'c1', collection: 'bravo', state: dirty },
      { id: 'c', connectionId: 'c1', collection: 'charlie' },
    ]);
    await waitFor(() => expect(tabOrder()).toHaveLength(3));

    fireEvent.contextMenu(tab('alpha'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Close others' }));
    fireEvent.click(await screen.findByRole('button', { name: /Discard and close/ }));

    await waitFor(() => expect(closedIds(close)).toEqual(['b', 'c']));
  });

  it('Reveal in sidebar opens a collapsed sidebar, activates the tab and focuses its row', async () => {
    mountTabs([
      { id: 'a', connectionId: 'c1', collection: 'alpha', isActive: true },
      { id: 'b', connectionId: 'c1', collection: 'bravo' },
    ]);
    await waitFor(() => expect(tabOrder()).toHaveLength(2));
    await screen.findByTestId('nav-coll-db-alpha');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse navigator' }));
    await waitFor(() => expect(screen.queryByRole('tree')).toBeNull());

    fireEvent.contextMenu(tab('bravo'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Reveal in sidebar' }));

    await waitFor(() => expect(tab('bravo').getAttribute('aria-selected')).toBe('true'));
    const row = await screen.findByTestId('nav-coll-db-bravo');
    await waitFor(() =>
      expect(screen.getByRole('tree').getAttribute('aria-activedescendant')).toBe(row.id),
    );
  });

  it('does not replay an old reveal when the navigator is reopened later', async () => {
    mountTabs([
      { id: 'a', connectionId: 'c1', collection: 'alpha', isActive: true },
      { id: 'b', connectionId: 'c1', collection: 'bravo' },
    ]);
    // Generous waits: this walk mounts the navigator twice, slow under a loaded run.
    await screen.findByTestId('nav-coll-db-alpha', {}, { timeout: 4000 });
    fireEvent.contextMenu(tab('bravo'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Reveal in sidebar' }));
    const tree = () => screen.getByRole('tree');
    await waitFor(() =>
      expect(tree().getAttribute('aria-activedescendant')).toBe(
        screen.getByTestId('nav-coll-db-bravo').id,
      ),
    );

    fireEvent.click(tab('alpha'));
    await waitFor(() => expect(tab('alpha').getAttribute('aria-selected')).toBe('true'));
    fireEvent.click(screen.getByRole('button', { name: 'Collapse navigator' }));
    await waitFor(() => expect(screen.queryByRole('tree')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Open navigator' }));

    const alphaRow = await screen.findByTestId('nav-coll-db-alpha', {}, { timeout: 4000 });
    await waitFor(() => expect(tree().getAttribute('aria-activedescendant')).toBe(alphaRow.id));
    // And it stays there once every queued focus move has run.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(tree().getAttribute('aria-activedescendant')).toBe(alphaRow.id);
  });

  const activeDescendant = () => screen.getByRole('tree').getAttribute('aria-activedescendant');

  it('Reveal in sidebar clears the navigator’s filter so the row can show', async () => {
    mountTabs([
      { id: 'a', connectionId: 'c1', collection: 'alpha', isActive: true },
      { id: 'b', connectionId: 'c1', collection: 'bravo' },
    ]);
    await screen.findByTestId('nav-coll-db-alpha');
    fireEvent.change(screen.getByLabelText('Filter collections'), { target: { value: 'alp' } });
    await waitFor(() => expect(screen.queryByTestId('nav-coll-db-bravo')).toBeNull());

    fireEvent.contextMenu(tab('bravo'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Reveal in sidebar' }));

    const bravo = await screen.findByTestId('nav-coll-db-bravo');
    expect((screen.getByLabelText('Filter collections') as HTMLInputElement).value).toBe('');
    await waitFor(() => expect(activeDescendant()).toBe(bravo.id));
  });

  it('Reveal in sidebar waits for a database whose collections are still loading', async () => {
    let release: (names: string[]) => void = () => {};
    const slow = new Promise<string[]>((r) => {
      release = r;
    });
    mountTabs(
      [
        { id: 'a', connectionId: 'c1', collection: 'alpha', isActive: true },
        { id: 'b', connectionId: 'c1', dbName: 'other', collection: 'zulu' },
      ],
      {
        dbs: ['db', 'other'],
        listCollections: async ({ dbName }) =>
          (dbName === 'other' ? await slow : ['alpha']).map(collInfo),
      },
    );
    await screen.findByTestId('nav-coll-db-alpha');

    fireEvent.contextMenu(tab('zulu'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Reveal in sidebar' }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    release(['zulu']);

    const zulu = await screen.findByTestId('nav-coll-other-zulu');
    await waitFor(() => expect(activeDescendant()).toBe(zulu.id));
  });

  it('Reveal in sidebar re-lists a stale database and lands on a collection created since', async () => {
    let names = ['alpha'];
    mountTabs(
      [
        { id: 'a', connectionId: 'c1', collection: 'alpha', isActive: true },
        { id: 'f', connectionId: 'c1', collection: 'fresh' },
      ],
      { listCollections: async () => names.map(collInfo) },
    );
    await screen.findByTestId('nav-coll-db-alpha');
    names = ['alpha', 'fresh'];

    fireEvent.contextMenu(tab('fresh'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Reveal in sidebar' }));

    const fresh = await screen.findByTestId('nav-coll-db-fresh');
    await waitFor(() => expect(activeDescendant()).toBe(fresh.id));
  });

  it('drops a reveal whose database failed to list its collections', async () => {
    let fail = true;
    mountTabs(
      [
        { id: 'a', connectionId: 'c1', collection: 'alpha', isActive: true },
        { id: 'b', connectionId: 'c1', dbName: 'other', collection: 'zulu' },
      ],
      {
        dbs: ['db', 'other'],
        listCollections: async ({ dbName }) => {
          if (dbName !== 'other') return ['alpha'].map(collInfo);
          if (fail) throw new Error('listCollections failed');
          return ['zulu'].map(collInfo);
        },
      },
    );
    await screen.findByTestId('nav-coll-db-alpha');

    fireEvent.contextMenu(tab('zulu'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Reveal in sidebar' }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    // Collapse and re-expand the database once it lists again.
    fail = false;
    fireEvent.click(screen.getByTestId('nav-db-other'));
    fireEvent.click(screen.getByTestId('nav-db-other'));
    const zulu = await screen.findByTestId('nav-coll-other-zulu');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(activeDescendant()).toBe(screen.getByTestId('nav-db-other').id);
    expect(activeDescendant()).not.toBe(zulu.id);
  });

  it('drops a reveal whose collection is gone, so it never fires later', async () => {
    let names = ['alpha', 'bravo'];
    mountTabs(
      [
        { id: 'a', connectionId: 'c1', collection: 'alpha', isActive: true },
        { id: 'g', connectionId: 'c1', collection: 'ghost' },
      ],
      { listCollections: async () => names.map(collInfo) },
    );
    await screen.findByTestId('nav-coll-db-alpha');

    fireEvent.contextMenu(tab('ghost'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Reveal in sidebar' }));
    await waitFor(() => expect(tab('ghost').getAttribute('aria-selected')).toBe('true'));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    // The user moves on; later the collection appears after all.
    fireEvent.click(tab('alpha'));
    const alpha = screen.getByTestId('nav-coll-db-alpha');
    await waitFor(() => expect(activeDescendant()).toBe(alpha.id));
    names = ['alpha', 'bravo', 'ghost'];
    fireEvent.contextMenu(screen.getByTestId('nav-db-db'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Refresh collections' }));
    const ghost = await screen.findByTestId('nav-coll-db-ghost');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    // Right-clicking the database row focuses it; the stale reveal must not
    // pull the focus onto the collection that has just appeared.
    expect(activeDescendant()).toBe(screen.getByTestId('nav-db-db').id);
    expect(activeDescendant()).not.toBe(ghost.id);
  });

  it('Reveal in sidebar moves the navigator’s focus to the row with the sidebar already open', async () => {
    mountTabs([
      { id: 'a', connectionId: 'c1', collection: 'alpha', isActive: true },
      { id: 'b', connectionId: 'c1', collection: 'bravo' },
    ]);
    await screen.findByTestId('nav-coll-db-alpha');
    // Park the navigator's own focus on another row first (alpha → bravo → charlie).
    const tree = screen.getByRole('tree');
    await waitFor(() =>
      expect(tree.getAttribute('aria-activedescendant')).toBe(
        screen.getByTestId('nav-coll-db-alpha').id,
      ),
    );
    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    fireEvent.keyDown(tree, { key: 'ArrowDown' });
    const charlie = screen.getByTestId('nav-coll-db-charlie');
    await waitFor(() =>
      expect(screen.getByRole('tree').getAttribute('aria-activedescendant')).toBe(charlie.id),
    );

    fireEvent.contextMenu(tab('bravo'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Reveal in sidebar' }));

    const bravo = screen.getByTestId('nav-coll-db-bravo');
    await waitFor(() =>
      expect(screen.getByRole('tree').getAttribute('aria-activedescendant')).toBe(bravo.id),
    );
  });
});
