import * as React from 'react';
import { commandRegistry } from './registry';
import type { Command } from './types';

/** Live view of every registered command, for the palette and the shortcuts sheet. */
export function useRegistrySnapshot(): Command[] {
  const subscribe = React.useCallback((cb: () => void) => commandRegistry.subscribe(cb), []);
  const getSnapshot = React.useCallback(() => commandRegistry.list(), []);
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
