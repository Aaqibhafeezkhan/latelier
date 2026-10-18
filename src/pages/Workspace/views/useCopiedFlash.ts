import React from 'react';
import { copyToClipboard } from '../../../utils/clipboard';

/**
 * Copy-to-clipboard with a 600ms "copied" badge on the key that was copied.
 * Badge, not toast — a toast per cell copy would be noise; a failed copy
 * toasts instead (`copyToClipboard` does that itself).
 */
export function useCopiedFlash<K>() {
  const [copied, setCopied] = React.useState<K | null>(null);
  const flash = React.useCallback((text: string, key: K) => {
    void copyToClipboard(text).then((ok) => {
      if (!ok) return;
      setCopied(key);
      window.setTimeout(() => {
        setCopied((prev) => (prev === key ? null : prev));
      }, 600);
    });
  }, []);
  return { copied, flash };
}
