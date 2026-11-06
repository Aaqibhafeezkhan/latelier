import type { NavigatorTreeState } from './navigatorTreeReducer';
import { ownGet } from '../../utils/ownProperty';

/**
 * Whether the navigator's listing says this namespace is a view. A namespace the
 * listing has not reached yet reads as not a view: writes stay offered and the
 * server is the judge, rather than hiding them on a guess.
 */
export function isViewCollection(
  tree: NavigatorTreeState,
  connectionId: string,
  dbName: string,
  collection: string,
): boolean {
  const colls = ownGet(ownGet(tree.caches, connectionId)?.colls ?? {}, dbName);
  return colls?.find((c) => c.name === collection)?.type === 'view';
}
