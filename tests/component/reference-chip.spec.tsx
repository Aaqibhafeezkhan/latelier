import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '../helpers/render';
import type { ReferenceRule } from '@shared/types';
import { ReferenceChip } from '../../src/features/references/ReferenceChip';
import { ReferenceDrawer, type ReferenceFrame } from '../../src/features/references/ReferenceDrawer';
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
  projection: ['name', 'email'],
  displayTemplate: '{name}',
  enabled: true,
  createdAt: '2026-04-24T00:00:00.000Z',
  updatedAt: '2026-04-24T00:00:00.000Z',
};

describe('ReferenceChip', () => {
  beforeEach(() => {
    installAtelierMock();
  });
  afterEach(() => {
    uninstallAtelierMock();
    vi.useRealTimers();
  });

  it('fires onClick with the anchor rect on click', () => {
    const onClick = vi.fn();
    render(
      withTheme(
        <ReferenceChip
          rule={RULE}
          onHover={() => {}}
          onLeave={() => {}}
          onClick={onClick}
        />,
      ),
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledOnce();
    expect(onClick.mock.calls[0]![0]).toHaveProperty('bottom');
  });

  it('fires onHover after the hover delay', async () => {
    vi.useFakeTimers();
    const onHover = vi.fn();
    render(
      withTheme(
        <ReferenceChip
          rule={RULE}
          onHover={onHover}
          onLeave={() => {}}
          onClick={() => {}}
        />,
      ),
    );
    fireEvent.mouseEnter(screen.getByRole('button'));
    vi.advanceTimersByTime(250);
    expect(onHover).toHaveBeenCalledOnce();
  });
});

describe('ReferenceDrawer', () => {
  beforeEach(() => {
    installAtelierMock({
      refs: {
        resolve: async () => ({
          ruleId: RULE.id,
          found: true,
          documents: [
            {
              _id: { $oid: 'abc' },
              name: 'Ada',
              email: 'ada@example.com',
            },
          ],
          durationMs: 1,
        }),
        list: async () => [],
      },
    });
  });
  afterEach(() => {
    uninstallAtelierMock();
  });

  it('renders the resolved target document and breadcrumb label', async () => {
    const frame: ReferenceFrame = {
      id: 'frame-1',
      rule: RULE,
      value: { $oid: 'abc' },
      label: 'contact_id',
    };
    render(
      withTheme(
        <ReferenceDrawer
          stack={[frame]}
          pinned={false}
          width={380}
          onPush={() => {}}
          onPop={() => {}}
          onClose={() => {}}
          onTogglePin={() => {}}
        />,
      ),
    );
    // Breadcrumb shows the label
    expect(await screen.findByText('contact_id')).toBeTruthy();
    // Title uses the display template
    await waitFor(() => expect(screen.getByText('Ada')).toBeTruthy());
    // Fields render
    expect(screen.getByText('name')).toBeTruthy();
    expect(screen.getByText('email')).toBeTruthy();
  });

  it('fires onClose when the close button is pressed', async () => {
    const frame: ReferenceFrame = {
      id: 'frame-2',
      rule: RULE,
      value: { $oid: 'abc' },
      label: 'contact_id',
    };
    const onClose = vi.fn();
    render(
      withTheme(
        <ReferenceDrawer
          stack={[frame]}
          pinned={false}
          width={380}
          onPush={() => {}}
          onPop={() => {}}
          onClose={onClose}
          onTogglePin={() => {}}
        />,
      ),
    );
    fireEvent.click(screen.getByLabelText('Close reference drawer'));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('ReferenceDrawer (multi-doc array source)', () => {
  beforeEach(() => {
    installAtelierMock({
      refs: {
        resolve: async () => ({
          ruleId: RULE.id,
          found: true,
          documents: [
            { _id: { $oid: 'a' }, name: 'Ada' },
            { _id: { $oid: 'b' }, name: 'Babbage' },
            { _id: { $oid: 'c' }, name: 'Curie' },
          ],
          durationMs: 2,
        }),
        list: async () => [],
      },
    });
  });
  afterEach(() => {
    uninstallAtelierMock();
  });

  it('renders a list view and pushes a child frame on pick', async () => {
    const onPush = vi.fn();
    const frame: ReferenceFrame = {
      id: 'frame-multi',
      rule: RULE,
      value: [{ $oid: 'a' }, { $oid: 'b' }, { $oid: 'c' }],
      label: 'item_ids',
    };
    render(
      withTheme(
        <ReferenceDrawer
          stack={[frame]}
          pinned={false}
          width={380}
          onPush={onPush}
          onPop={() => {}}
          onClose={() => {}}
          onTogglePin={() => {}}
        />,
      ),
    );
    // Title summarizes the count.
    await waitFor(() =>
      expect(screen.getByText(/3 matches in contacts/i)).toBeTruthy(),
    );
    // All three rows render via the displayTemplate.
    expect(screen.getByText('Ada')).toBeTruthy();
    expect(screen.getByText('Babbage')).toBeTruthy();
    expect(screen.getByText('Curie')).toBeTruthy();
    // Picking a row pushes a child frame keyed by that doc's _id.
    fireEvent.click(screen.getByText('Babbage'));
    expect(onPush).toHaveBeenCalledOnce();
    const pushed = onPush.mock.calls[0]![0] as ReferenceFrame;
    expect(pushed.value).toEqual({ $oid: 'b' });
    expect(pushed.label).toBe('Babbage');
  });

  it('opens a picked row without resolving again, whatever the shape of targetField', async () => {
    const resolve = vi.fn(async () => ({
      ruleId: RULE.id,
      found: true,
      documents: [
        { _id: { $oid: 'a' }, name: 'Ada' },
        { _id: { $oid: 'b' }, name: 'Babbage' },
      ],
      durationMs: 2,
    }));
    installAtelierMock({ refs: { resolve: resolve as never, list: async () => [] } });
    const rule: ReferenceRule = { ...RULE, targetField: 'n.k' };
    const first: ReferenceFrame = { id: 'frame-list', rule, value: [1, 2], label: 'item_ids' };
    function Stack() {
      const [stack, setStack] = React.useState([first]);
      return (
        <ReferenceDrawer
          stack={stack}
          pinned={false}
          width={380}
          onPush={(frame) => setStack((s) => [...s, frame])}
          onPop={() => {}}
          onClose={() => {}}
          onTogglePin={() => {}}
        />
      );
    }
    render(<Stack />);

    fireEvent.click(await screen.findByText('Babbage'));

    await waitFor(() => expect(screen.queryByText(/2 matches in contacts/i)).toBeNull());
    expect(screen.getAllByText(/Babbage/).length).toBeGreaterThan(0);
    expect(screen.queryByText('Ada')).toBeNull();
    expect(resolve).toHaveBeenCalledOnce();
  });
});
