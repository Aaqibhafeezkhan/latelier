import React from 'react';
import { api, getErrorMessage, isIpcError } from '../../api/atelier';
import { ejsonParse, ejsonStringify } from '../../utils/ejson';
import { type ReferenceFrame } from '../../features/references/ReferenceDrawer';
import { isSameReferenceTarget, makeFrameId } from '../../features/references/display';
import type {
  CollectionTabState,
  PersistedReferenceFrame,
  ReferenceResolveResult,
  ReferenceRule,
  WorkspaceTab,
} from '@shared/types';
import { logToMain } from '../../utils/rendererLog';

export interface ReferenceDrawerState {
  refStack: ReferenceFrame[];
  setRefStack: React.Dispatch<React.SetStateAction<ReferenceFrame[]>>;
  refDrawerPinned: boolean;
  setRefDrawerPinned: React.Dispatch<React.SetStateAction<boolean>>;
  refEditorOpen: boolean;
  setRefEditorOpen: React.Dispatch<React.SetStateAction<boolean>>;
  refHover: {
    rule: ReferenceRule;
    anchorRect: DOMRect;
    result: ReferenceResolveResult | null;
    loading: boolean;
    error: string | null;
  } | null;
  handleRefHover: (rule: ReferenceRule, value: unknown, rect: DOMRect) => Promise<void>;
  handleRefHoverLeave: () => void;
  handleRefOpen: (rule: ReferenceRule, field: string, value: unknown) => void;
}

export function useReferenceDrawer(
  activeTabId: string | null,
  allTabs: WorkspaceTab[],
  patchCollectionState: (id: string, patch: Partial<CollectionTabState>) => void,
  activeCollectionId: string | null,
): ReferenceDrawerState {
  const [refStack, setRefStack] = React.useState<ReferenceFrame[]>([]);
  const [refDrawerPinned, setRefDrawerPinned] = React.useState(false);
  const [refEditorOpen, setRefEditorOpen] = React.useState(false);
  const [refHover, setRefHover] = React.useState<ReferenceDrawerState['refHover']>(null);

  const hoverReqIdRef = React.useRef(0);
  // Tab-scoped resolve cache so repeated hovers on the same chip don't
  // re-hit IPC. Cleared when the Focused Tab changes.
  const resolveCacheRef = React.useRef<Map<string, ReferenceResolveResult>>(new Map());
  // Suppresses the persist effect immediately after a tab-restore so we
  // don't write the same data straight back to the tab we just read.
  const skipNextPersistRef = React.useRef(false);

  // On tab switch: restore the new Focused Tab's persisted drawer stack
  // (unless the drawer is pinned, in which case it survives the switch
  // unchanged). Always invalidate the per-tab resolve cache so a stale
  // target doc never leaks across collections.
  const activeTabIdRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (activeTabIdRef.current === activeTabId) return;
    activeTabIdRef.current = activeTabId;
    resolveCacheRef.current.clear();
    setRefHover(null);
    if (refDrawerPinned) return;
    const tab = allTabs.find((t) => t.id === activeTabId);
    const persisted =
      tab?.kind === 'collection' ? tab.state.referenceDrawer?.stack ?? [] : [];
    skipNextPersistRef.current = true;
    // Defensive parse: a corrupt frame (schema drift, partial-write crash,
    // manual SQLite edit) would otherwise throw and abort the entire restore,
    // dropping every other frame too. Filter the broken ones instead.
    const restored: ReferenceFrame[] = [];
    for (const p of persisted) {
      try {
        restored.push({
          id: p.id,
          rule: p.rule,
          value: ejsonParse(p.valueEjson),
          label: p.label,
        });
      } catch {
        // Skip: the frame is unrecoverable, but the rest of the stack is fine.
        // The parse error is left out of the line, because it can quote the
        // stored value; the rule id is enough to find the frame.
        logToMain('warn', `restoring a reference frame failed: stored value is not valid EJSON (rule ${p.rule.id})`, 'component');
      }
    }
    setRefStack(restored);
  }, [activeTabId, allTabs, refDrawerPinned]);

  // Persist the current stack to the active collection tab's state_json so
  // the drawer survives a tab round-trip. Skipped while pinned (pin keeps
  // the drawer in-memory only) and right after a restore.
  //
  // `activeCollectionIdRef` and `patchCollectionStateRef` carry the latest
  // values without re-running the effect on every tab-state mutation —
  // the effect fires only on push/pop/close or pin toggle, exactly the
  // moments worth persisting. The refs guarantee we read the *current*
  // active collection id, so a concurrent tab switch can't race us into
  // writing the previous tab's stack to the new one.
  const activeCollectionIdRef = React.useRef(activeCollectionId);
  const patchCollectionStateRef = React.useRef(patchCollectionState);
  React.useEffect(() => {
    activeCollectionIdRef.current = activeCollectionId;
    patchCollectionStateRef.current = patchCollectionState;
  });
  React.useEffect(() => {
    if (skipNextPersistRef.current) {
      skipNextPersistRef.current = false;
      return;
    }
    if (refDrawerPinned) return;
    const targetId = activeCollectionIdRef.current;
    if (!targetId) return;
    const persisted: PersistedReferenceFrame[] = refStack.map((f) => ({
      id: f.id,
      rule: f.rule,
      valueEjson: ejsonStringify(f.value),
      label: f.label,
    }));
    patchCollectionStateRef.current(targetId, {
      referenceDrawer: { stack: persisted },
    });
  }, [refStack, refDrawerPinned]);

  const handleRefHover = React.useCallback(
    async (rule: ReferenceRule, value: unknown, rect: DOMRect) => {
      const reqId = ++hoverReqIdRef.current;
      const valueEjson = ejsonStringify(value);
      const cacheKey = `${rule.id}:${valueEjson}`;
      const cached = resolveCacheRef.current.get(cacheKey);
      if (cached) {
        setRefHover({ rule, anchorRect: rect, result: cached, loading: false, error: null });
        return;
      }
      setRefHover({ rule, anchorRect: rect, result: null, loading: true, error: null });
      try {
        const result = await api.refs.resolve({ ruleId: rule.id, valueEjson });
        if (reqId !== hoverReqIdRef.current) return;
        resolveCacheRef.current.set(cacheKey, result);
        setRefHover((prev) =>
          prev ? { ...prev, result, loading: false, error: null } : prev,
        );
      } catch (err) {
        if (reqId !== hoverReqIdRef.current) return;
        setRefHover((prev) =>
          prev
            ? {
                ...prev,
                loading: false,
                error: isIpcError(err)
                  ? err.message
                  : getErrorMessage(err, 'Failed to resolve'),
              }
            : prev,
        );
      }
    },
    [],
  );

  const handleRefHoverLeave = React.useCallback(() => {
    hoverReqIdRef.current++;
    setRefHover(null);
  }, []);

  const handleRefOpen = React.useCallback(
    (rule: ReferenceRule, field: string, value: unknown) => {
      setRefHover(null);
      setRefStack((prev) => {
        if (isSameReferenceTarget(prev[prev.length - 1], rule, value)) return prev;
        return [{ id: makeFrameId(rule), rule, value, label: field }];
      });
    },
    [],
  );

  return {
    refStack,
    setRefStack,
    refDrawerPinned,
    setRefDrawerPinned,
    refEditorOpen,
    setRefEditorOpen,
    refHover,
    handleRefHover,
    handleRefHoverLeave,
    handleRefOpen,
  };
}
