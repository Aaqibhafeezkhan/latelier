import { beforeEach } from 'vitest';
import { configure } from '@testing-library/react';
import { uninstallAtelierMock } from './atelierMock';
import { installJsdomTeardown } from './jsdomTeardown';

// jsdom doesn't implement ResizeObserver, and reports offsetWidth/offsetHeight
// as 0 for every element. react-window reads both to compute the visible
// window — without them it renders zero items and every assertion about list
// contents fails. Provide permissive shims sized large enough that the
// virtualizer renders the entire list (component specs never feed it long
// lists).
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  (globalThis as unknown as { ResizeObserver: typeof NoopResizeObserver }).ResizeObserver = NoopResizeObserver;
}

// jsdom doesn't implement window.matchMedia. Mantine's color-scheme provider
// reads it to detect the OS preference; without a shim every Mantine-wrapped
// render throws. Stub a permissive matcher that reports "light" so component
// tests get a deterministic color scheme.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  get() { return 1000; },
});
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  get() { return 1000; },
});

// jsdom has no layout, so `getBoundingClientRect()` returns zeros for every
// element — and every synthetic pointer event carries clientX/clientY of 0.
// `react-resizable-panels` decides whether a document-level pointer event is
// "on" a resize handle by hit-testing those coordinates against the rects of
// the group's panels and separators, so in jsdom every pointer-down in the
// document lands inside every handle: the handle focuses itself and calls
// preventDefault, and the click never reaches the element it was aimed at
//. A handle only renders once a collection tab is open, which is why
// this surfaced only when specs started mounting the Workspace in that state.
//
// Park the panel machinery's geometry far from the origin, where no synthetic
// pointer event can be inside it. Only the elements the library hit-tests get a
// rect; every other element — tabs included — keeps jsdom's zeros, so nothing
// on a drag path gains fake geometry that a coordinate-based assertion could
// mistake for layout.
const PANEL_GEOMETRY_SELECTOR = '[data-panel],[data-separator]';
const FAR_FROM_ORIGIN = 10_000;
const nativeGetBoundingClientRect = Element.prototype.getBoundingClientRect;
Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
  configurable: true,
  value: function getBoundingClientRect(this: Element): DOMRect {
    return this.matches(PANEL_GEOMETRY_SELECTOR)
      ? new DOMRect(FAR_FROM_ORIGIN, FAR_FROM_ORIGIN, 100, 100)
      : nativeGetBoundingClientRect.call(this);
  },
});

// jsdom doesn't implement Element.scrollIntoView. Spotlight calls it on each
// keystroke to keep the highlighted action visible — without a stub the call
// throws and surfaces as an unhandled rejection.
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = function noop() {};
}

// Vitest runs `afterEach` hooks in REVERSE registration order, which means
// per-file `afterEach(() => uninstallAtelierMock())` blocks fire BEFORE the
// `cleanup()` registered here from setupFiles. RTL's `cleanup()` then unmounts
// components with `window.atelier` already gone — any in-flight effect that
// touches the bridge during unmount throws and crashes the next test's setup.
//
// Two protections:
//   1. `beforeEach`: install a permissive stub so even if a prior test forgot
//      to uninstall, the bridge is in a known-safe state when the next test's
//      render runs effects.
//   2. `afterEach` is unchanged (just `cleanup()`); but per-file uninstall now
//      leaves a permissive stub instead of `undefined` (see atelierMock.ts),
//      so cleanup-time effects never crash regardless of hook ordering.
beforeEach(() => {
  uninstallAtelierMock();
});

// A timer that outlives its test is a CI-only failure with a confusing shape:
// vitest tears down the jsdom globals at the end of a worker's run, the pending
// callback fires, React's `dispatchSetState` reads `window` to pick an update
// priority, and the run fails as an unhandled rejection with every individual
// test passing. It surfaces only under load, so it reads as a flake.
//
// `installJsdomTeardown` (see tests/helpers/jsdomTeardown.ts, #110) kills the
// whole class — including `@mantine/notifications`' 4-6s auto-close timer,
// which no per-component fix can reach, and including components that don't
// exist yet. The `unit` project's jsdom-opt-in hook specs call it directly,
// since they have no setupFiles of their own.
installJsdomTeardown();

// findBy*/waitFor give up after 1 s by default. Under --coverage on a CI runner a
// cold Workspace mount alone can take longer, so the first test of a file fails
// for lack of time, not for lack of the element. Same condition as testTimeout
// in vitest.config.ts, which sets ATELIER_COVERAGE_RUN: this file runs in a
// worker whose own argv never carries `--coverage`. Plain local runs keep the
// strict default.
if (process.env.ATELIER_COVERAGE_RUN === '1') configure({ asyncUtilTimeout: 10_000 });
