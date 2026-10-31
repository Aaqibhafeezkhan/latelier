/**
 * Remembers which control had keyboard focus before the command palette
 * opened, so a dialog the palette launches can hand focus back to it.
 *
 * A dialog's own capture of `document.activeElement` lands on the palette's
 * search input, which unmounts with the palette; returning focus there is a
 * no-op and focus falls to `<body>`. The opener is tracked from `focusin`
 * rather than read at open time because by the time Mantine reports the
 * palette as open, focus may already be on the search input.
 */
let opener: HTMLElement | null = null;

const PALETTE_SELECTOR = '[data-command-palette]';

export function isInPalette(el: Element | null | undefined): boolean {
  return !!el?.closest(PALETTE_SELECTOR);
}

export function paletteOpener(): HTMLElement | null {
  return opener;
}

/** Records `el` as the opener unless it is the palette itself or `<body>`. */
export function setPaletteOpener(el: EventTarget | null): void {
  if (!(el instanceof HTMLElement) || el === document.body || isInPalette(el)) return;
  opener = el;
}

export function _resetPaletteOpenerForTests(): void {
  opener = null;
}
