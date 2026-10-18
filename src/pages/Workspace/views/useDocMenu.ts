import React from 'react';
import { useMenuFocus } from '../../../hooks/useMenuFocus';

export interface DocMenuState {
  x: number;
  y: number;
  doc: unknown;
  returnFocusTo?: HTMLElement | null;
  focusMenuOnOpen?: boolean;
}

/**
 * Open state, dismiss and focus wiring for a per-document "More actions"
 * popup. Tree and JSON render it with `DocActionsPopup`; Table renders its
 * own cell menu from it and passes the clicked cell's `field`/`value`/
 * `hasValue` as `extra`, which is spread into the state.
 */
export function useDocMenu<E extends object = object>() {
  const [docMenu, setDocMenu] = React.useState<(DocMenuState & Partial<E>) | null>(null);
  const docMenuRef = React.useRef<HTMLDivElement | null>(null);
  const openDocMenu = React.useCallback(
    (
      doc: unknown,
      anchor: { x: number; y: number },
      focus?: { returnFocusTo?: HTMLElement | null; focusMenuOnOpen?: boolean },
      extra?: E,
    ) => {
      const base: Partial<E> = extra ?? {};
      setDocMenu({
        ...base,
        ...anchor,
        doc,
        returnFocusTo: focus?.returnFocusTo,
        focusMenuOnOpen: focus?.focusMenuOnOpen,
      });
    },
    [],
  );
  const closeDocMenu = React.useCallback(() => setDocMenu(null), []);
  useMenuFocus(docMenuRef, docMenu, closeDocMenu);
  return { docMenu, docMenuRef, openDocMenu, closeDocMenu };
}
