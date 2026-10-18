import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '../helpers/render';
import { MemoryRouter } from 'react-router-dom';
import Workspace from '../../src/pages/Workspace';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { CollectionTabState, WorkspaceTab } from '@shared/types';
import type { IpcApi } from '@shared/ipc';

/**
 * W15 §5 / §4.4 / §12 case 6 — the advanced row's four fields each
 * have a programmatic accessible name, and `skip` states its reason to
 * someone who is not holding a mouse.
 *
 * Before this, the labels were plain `<div>`s and the inputs carried a
 * `data-testid` and a placeholder: a screen reader announced three unnamed
 * text fields and one unresponsive number. The names come from
 * `aria-labelledby` pointing at those same label cells, so these assertions
 * fail if the wiring is dropped *or* if the visible text and the announced
 * name ever diverge.
 */

const now = '2026-08-06T12:00:00.000Z';

// A sort is seeded so the advanced row auto-opens (`hasAdvanced`) — the row
// is not in the DOM at all while collapsed.
function makeState(limit = '25'): CollectionTabState {
  return {
    view: 'Tree',
    builder: { projection: [], sort: '{"name":1}', limit },
    queryRaw: '{}',
    page: 2,
    pageSize: 50,
    activeBuilderTab: 'Builder',
    lastRun: { documents: [], durationMs: 0, ranAt: now },
  };
}

function makeTab(state: CollectionTabState): WorkspaceTab {
  return {
    id: 't1',
    kind: 'collection',
    connectionId: 'c1',
    dbName: 'mydb',
    collection: 'users',
    position: 0,
    isActive: true,
    openedAt: now,
    pinned: false,
    state,
  };
}

const CONNECTION = {
  id: 'c1',
  name: 'Local',
  color: '#1A6835',
  host: 'localhost',
  port: 27017,
  connectionType: 'standard' as const,
  readOnly: false,
  status: 'connected' as const,
};

function mount(limit?: string) {
  const state = makeState(limit);
  installAtelierMock({
    tabs: {
      list: async () => [makeTab(state)],
      setActive: async (id) => ({ id }),
      update: (async () => makeTab(state)) as unknown as IpcApi['tabs']['update'],
    },
    conn: { list: async () => [CONNECTION] },
    prefs: {
      get: async () => null,
      set: async (_key: string, value: unknown) => value,
    } as unknown as IpcApi['prefs'],
    query: {
      find: vi.fn(async () => ({ documents: [], durationMs: 3, hasMore: false })),
      count: async () => ({ count: 0 }),
    },
  });

  return render(
    <MemoryRouter initialEntries={['/workspace']}>
      <Workspace />
    </MemoryRouter>,
  );
}

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

describe('W15 §5 — the advanced row announces which field you are on', () => {
  it('names sort off its visible label cell', async () => {
    mount();
    await screen.findByTestId('query-bar-sort');

    // Lowercase: the cells render lowercase text and uppercase it in CSS,
    // and an accessible name is the text, not the rendering.
    expect(screen.getByLabelText('sort')).toBe(screen.getByTestId('query-bar-sort'));
  });

  // The projection moved out of this row into the Fields control (W14 §4),
  // and keeps an accessible name there.
  it('names the projection input in the Fields control', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /^fields/i }));
    expect(await screen.findByLabelText('Projection')).toBe(screen.getByTestId('fields-projection'));
  });

  it('names limit and skip too', async () => {
    mount();
    await screen.findByTestId('query-bar-limit');

    expect(screen.getByLabelText('limit')).toBe(screen.getByTestId('query-bar-limit'));
    expect(screen.getByLabelText('skip')).toBe(screen.getByTestId('query-bar-skip'));
  });
});

describe('W15 §4.4 — skip explains itself without a mouse', () => {
  it('is focusable and describes why it cannot be typed into', async () => {
    mount();
    const skip = await screen.findByTestId('query-bar-skip');

    // A `<span>` — what this was — takes neither focus nor an accessible
    // name, so the explanation reached hover and nothing else.
    expect(skip.tagName).toBe('INPUT');
    expect((skip as HTMLInputElement).readOnly).toBe(true);
    skip.focus();
    expect(document.activeElement).toBe(skip);

    const describedBy = skip.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const help = document.getElementById(describedBy!);
    expect(help?.textContent).toMatch(/page selector below the results/);
  });

  it('shows the page-derived skip value', async () => {
    mount();
    // page 2 × pageSize 50.
    expect(await screen.findByDisplayValue('100')).toBeTruthy();
  });
});

/** The text an assistive technology would read for an element's `aria-describedby`. */
function describedText(el: HTMLElement): string {
  const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
  return ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
}

describe('W15 §4.2 — limit says it caps the total across all pages', () => {
  it('describes itself to a screen reader', async () => {
    mount();
    const limit = await screen.findByTestId('query-bar-limit');

    expect(describedText(limit)).toMatch(/across all pages/i);
  });

  it('keeps the explanation next to the error when the limit is junk', async () => {
    mount('-3');
    const limit = await screen.findByTestId('query-bar-limit');

    const ids = limit.getAttribute('aria-describedby')?.split(/\s+/);
    expect(ids).toContain('query-bar-limit-help');
    expect(ids).toContain('query-bar-limit-error');
    expect(describedText(limit)).toMatch(/not a positive number/);
    expect(describedText(limit)).toMatch(/across all pages/i);
  });

  it('shows the explanation as a tooltip when keyboard focus lands on it', async () => {
    mount();
    const limit = await screen.findByTestId('query-bar-limit');

    fireEvent.focus(limit);

    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toMatch(/across all pages/i);
  });
});

describe('W15 §5 — the disclosure trigger carries the focus-ring class', () => {
  it('opts into the :focus-visible rule defined in index.css', async () => {
    mount();
    // The tab strip's Tab Group headers are expandable buttons too.
    const expanded = await screen.findAllByRole('button', { expanded: true });
    const trigger = expanded.find((b) => !b.closest('[role="tablist"]'))!;
    // jsdom does not apply the app stylesheet, so this only proves the hook
    // is present. The other two thirds live where they can be checked:
    // `tests/unit/focus-ring-rule.spec.ts` asserts `index.css` still defines
    // an outline for whatever class this element names, and
    // `tests/e2e/w15-advanced-row-sort-limit.e2e.ts` keyboard-focuses it
    // under Chromium and reads the computed outline back. `:focus-visible`
    // cannot be evaluated here at all.
    expect(trigger.className.split(/\s+/)).toContain('focus-ring');
  });
});
