import { useEffect } from 'react';
import { commandRegistry } from './registry';
import type { PaletteObject } from './types';

/**
 * Register palette objects (X07 §13.4), exactly as `useRegisterCommands`
 * registers commands: replaced by id, re-registered when `deps` change,
 * unregistered on unmount.
 */
export function useRegisterObjects(objects: PaletteObject[], deps: React.DependencyList): void {
  useEffect(() => {
    const unregister = commandRegistry.addObjects(objects);
    return unregister;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
