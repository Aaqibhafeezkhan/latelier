import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import { useWorkspacePanelPrefs } from '../../src/pages/Workspace/useWorkspacePanelPrefs';

/** A `matchMedia` the test can flip, as a window crossing the one-panel width would. */
function stubWindowWidth(initiallyNarrow: boolean) {
  let matches = initiallyNarrow;
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return matches;
    },
    media: query,
    addEventListener: (_: string, l: (e: MediaQueryListEvent) => void) => listeners.add(l),
    removeEventListener: (_: string, l: (e: MediaQueryListEvent) => void) => listeners.delete(l),
  }));
  return (narrow: boolean) => {
    matches = narrow;
    act(() => listeners.forEach((l) => l({ matches: narrow } as MediaQueryListEvent)));
  };
}

async function mount() {
  const hook = renderHook(() => useWorkspacePanelPrefs());
  await waitFor(() => expect(hook.result.current.prefsReady).toBe(true));
  return hook;
}

const prefsSet = vi.fn(async () => undefined);
beforeEach(() => {
  prefsSet.mockClear();
  installAtelierMock({ prefs: { get: async () => undefined, set: prefsSet } as never });
});
afterEach(() => {
  uninstallAtelierMock();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('one side panel below 1100 px', () => {
  it('asks the media query for the width just under the rule', async () => {
    const seen: string[] = [];
    stubWindowWidth(false);
    const original = window.matchMedia;
    vi.stubGlobal('matchMedia', (q: string) => {
      seen.push(q);
      return original(q);
    });
    await mount();
    expect(seen).toContain('(max-width: 1099.98px)');
  });

  it('with both stored open, the narrow window shows the navigator alone', async () => {
    stubWindowWidth(true);
    const { result } = await mount();
    expect(result.current.onePanelOnly).toBe(true);
    expect(result.current.sidebarCollapsed).toBe(false);
    expect(result.current.builderCollapsed).toBe(true);
  });

  it('opening the drawer closes the navigator, and the other way round', async () => {
    stubWindowWidth(true);
    const { result } = await mount();

    act(() => result.current.commitBuilderCollapsed(false));
    expect(result.current.builderCollapsed).toBe(false);
    expect(result.current.sidebarCollapsed).toBe(true);

    act(() => result.current.toggleSidebar());
    expect(result.current.sidebarCollapsed).toBe(false);
    expect(result.current.builderCollapsed).toBe(true);
  });

  it('closing the one open panel closes it, without opening the other', async () => {
    stubWindowWidth(true);
    const { result } = await mount();
    act(() => result.current.toggleSidebar());
    expect(result.current.sidebarCollapsed).toBe(true);
    expect(result.current.builderCollapsed).toBe(true);
  });

  it('what happens while narrow is not stored, and the wide layout comes straight back', async () => {
    const setWidth = stubWindowWidth(true);
    const { result } = await mount();
    act(() => result.current.commitBuilderCollapsed(false));
    act(() => result.current.commitBuilderCollapsed(true));
    act(() => result.current.toggleSidebar());
    expect(prefsSet).not.toHaveBeenCalledWith('ui.workspace.sidebarCollapsed', expect.anything());
    expect(prefsSet).not.toHaveBeenCalledWith('ui.workspace.builderCollapsed', expect.anything());

    setWidth(false);
    expect(result.current.onePanelOnly).toBe(false);
    expect(result.current.sidebarCollapsed).toBe(false);
    expect(result.current.builderCollapsed).toBe(false);

    // And a later narrow spell starts again from the stored layout.
    setWidth(true);
    expect(result.current.sidebarCollapsed).toBe(false);
    expect(result.current.builderCollapsed).toBe(true);
  });

  it('above the width, each panel is independent and stored, as before', async () => {
    stubWindowWidth(false);
    const { result } = await mount();
    act(() => result.current.toggleSidebar());
    expect(result.current.sidebarCollapsed).toBe(true);
    expect(result.current.builderCollapsed).toBe(false);
    expect(prefsSet).toHaveBeenCalledWith('ui.workspace.sidebarCollapsed', true);
  });
});
