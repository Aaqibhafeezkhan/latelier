import React from 'react';

const FIELD = 'input:not([disabled]):not([readonly]), textarea:not([disabled]):not([readonly]), select:not([disabled])';

/**
 * Opens a dialog on its first real field instead of its Close button. Pass
 * the returned callback as the `ref` of the dialog's body.
 *
 * Mantine's focus trap moves focus after mount to `[data-autofocus]`, else to
 * the first tabbable element, which is the header's Close. Marking the field
 * covers a dialog whose fields are there at mount. A dialog that fills in
 * after a load (`ready` turning true later) has already had its focus put on
 * Close by then, so this also moves focus itself, but only while it is still
 * on Close or `<body>`, so a field the person has already clicked into is
 * never pulled away.
 */
export function useOpenFocus(ready = true): (el: HTMLElement | null) => void {
  // State rather than a ref object: a dialog's body mounts in a portal after
  // the component that renders it has already run its first effects, so the
  // effect has to follow the element arriving.
  const [el, setEl] = React.useState<HTMLElement | null>(null);
  React.useEffect(() => {
    if (!ready || !el) return;
    const field = el.querySelector<HTMLElement>(FIELD);
    if (!field) return;
    field.setAttribute('data-autofocus', 'true');
    const active = document.activeElement;
    if (!active || active === document.body || active.closest('.mantine-Modal-close, .mantine-CloseButton-root')) {
      field.focus();
    }
  }, [el, ready]);
  return setEl;
}
