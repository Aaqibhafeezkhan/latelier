import React from 'react';

/**
 * The element's own laid-out width, or null until it has one. jsdom lays nothing
 * out, so component tests read null; callers treat that as "room for everything".
 *
 * Read in a layout effect so the first paint already uses the right layout: a
 * passive effect would flash the widest one and then collapse it.
 */
export function useElementWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number | null] {
  const ref = React.useRef<T>(null);
  const [width, setWidth] = React.useState<number | null>(null);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const read = () => setWidth(el.getBoundingClientRect().width || null);
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}
