import React from 'react';
import { ActionIcon, Button, Tooltip, UnstyledButton } from '@mantine/core';
import { themeVars } from '../../../theme/themeVars';
import { I } from '../../../icons';
import type { Stage, StageOp } from '@shared/types';
import { ejsonStringifyReadable } from '../../../utils/ejson';
import { HighlightedJson } from '../views/JsonView';
import { docKey } from '../../../utils/displayValue';
import { copyToClipboard } from '../../../utils/clipboard';
import { formatShortcut } from '../../../commands/shortcutLabel';
import { isMacRenderer } from '../../../utils/platform';
import { useShellSyntaxField } from '../useShellSyntaxField';
import {
  KNOWN_STAGE_OPS,
  OP_COLOR,
  STAGE_OP_INFO,
  formatBody,
  isKnownOp,
  isWriteStage,
  stageSummary,
  validateStageBody,
} from './pipeline';
import type { SuggestionContext } from '../../../features/fieldSuggestions/types';
import { ScriptEditor } from '../../../components/ScriptEditor';
import { stageBodyCompletionSource } from '../../../components/scriptEditor/stageBodyCompletions';
import {
  brightenBadgeForDark,
  findOperatorDocs,
} from '../../../features/fieldSuggestions/operators';
import { OperatorDocPanel } from '../../../features/fieldSuggestions/OperatorDocPanel';
import { OperatorTooltip } from '../../../features/fieldSuggestions/OperatorTooltip';
import {
  OPERATOR_PANEL_SIZE,
  placeFloatingPanel,
} from '../../../features/fieldSuggestions/placement';

interface AccordionProps {
  stages: Stage[];
  activeId: number | null;
  collection: string;
  sourceCount: number | null;
  outputCount: number | null;
  stageCounts: Record<number, number>;
  stageSamples: Record<number, unknown[]>;
  staleStageIds: ReadonlySet<number>;
  previewLoading: ReadonlySet<number>;
  darkMode: boolean;
  suggestionContext: SuggestionContext | null;
  onAdd: (op: StageOp | string, afterIndex?: number) => void;
  onToggleActive: (id: number) => void;
  onToggleEnabled: (id: number) => void;
  onChangeOp: (id: number, op: StageOp | string) => void;
  onBodyChange: (id: number, body: string) => void;
  onMoveUp: (index: number) => void;
  onMoveDown: (index: number) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onRemove: (id: number) => void;
  onDuplicate: (id: number) => void;
  onRunToStage: (id: number) => void;
  onRefreshPreview: (id: number) => void;
}

function opColor(op: string, dark: boolean) {
  return brightenBadgeForDark(
    OP_COLOR[op] ?? { bg: 'rgba(100,100,100,0.15)', text: '#888' },
    dark,
  );
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

// ─── StageOpPicker ──────────────────────────────────────────────────────────

/**
 * Searchable operator picker shared by the add-stage pill and the stage-row
 * op control (T2.1). Owns its own open/search/keyboard-nav state; the caller
 * only supplies the trigger (render prop) and the `onPick` callback.
 */
interface StageOpPickerProps {
  onPick: (op: StageOp | string) => void;
  renderTrigger: (open: boolean, toggle: () => void) => React.ReactNode;
  /** Horizontal anchor for the dropdown relative to the trigger. */
  align?: 'center' | 'left';
}

function StageOpPicker({ onPick, renderTrigger, align = 'center' }: StageOpPickerProps) {
  const T = themeVars;
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [focusIdx, setFocusIdx] = React.useState(0);
  const [customMode, setCustomMode] = React.useState(false);
  const [customName, setCustomName] = React.useState('');
  const inputRef = React.useRef<HTMLInputElement>(null);
  const customInputRef = React.useRef<HTMLInputElement>(null);
  const dropdownRef = React.useRef<HTMLDivElement>(null);
  const [panelPos, setPanelPos] = React.useState<{ top: number; left: number } | null>(null);
  const close = () => {
    setOpen(false);
    setQuery('');
    setCustomMode(false);
    setCustomName('');
  };

  const toggle = () => {
    if (open) close();
    else setOpen(true);
  };

  const q = query.trim().toLowerCase();
  const filtered = KNOWN_STAGE_OPS.filter((op) => {
    if (!q) return true;
    const info = STAGE_OP_INFO[op];
    const name = op.toLowerCase();
    // Let bare typing ("sort") match a `$`-prefixed op ("$sort").
    const nameMatch = name.includes(q) || (!q.startsWith('$') && name.slice(1).startsWith(q));
    return nameMatch || (info?.desc.toLowerCase().includes(q) ?? false);
  });

  React.useEffect(() => {
    if (open && !customMode) {
      const t = setTimeout(() => inputRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }
  }, [open, customMode]);

  React.useEffect(() => {
    if (customMode) {
      const t = setTimeout(() => customInputRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }
  }, [customMode]);

  // Clamp focus to the filtered list length at render time so keyboard
  // navigation never points past the last visible row after the search
  // narrows the list.
  const focusEffective = Math.min(focusIdx, Math.max(0, filtered.length - 1));

  // Measure the dropdown rect once open and compute the side-panel position.
  React.useEffect(() => {
    if (!open || customMode || filtered.length === 0) return;
    const box = dropdownRef.current?.getBoundingClientRect();
    if (!box) return;
    const p = placeFloatingPanel(
      { top: box.top, left: box.left, width: box.width, height: box.height },
      OPERATOR_PANEL_SIZE,
      'right',
    );
    setPanelPos((prev) =>
      prev && prev.top === p.top && prev.left === p.left
        ? prev
        : { top: p.top, left: p.left },
    );
  }, [open, customMode, filtered.length]);

  const focusedOp = filtered[focusEffective];
  const focusedDoc = focusedOp ? findOperatorDocs(focusedOp, 'stage') : null;

  const pick = (op: StageOp | string) => {
    onPick(op);
    close();
  };

  // Strip every leading `$` before re-adding exactly one, so `$$foo` (or
  // `$$$`) normalizes the same as `foo` does — a single leading `$`, or
  // empty if that's all the input was.
  const cleanCustomName = customName.trim().replace(/^\$+/, '');

  const submitCustom = () => {
    if (!cleanCustomName) return;
    pick(`$${cleanCustomName}`);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusIdx(Math.min(filtered.length - 1, focusEffective + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusIdx(Math.max(0, focusEffective - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const op = filtered[focusEffective];
      if (op) pick(op);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  const onCustomKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitCustom();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setCustomMode(false);
    }
  };

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      {renderTrigger(open, toggle)}
      {open && (
        <div
          ref={dropdownRef}
          style={{
            position: 'absolute',
            top: '100%',
            ...(align === 'center'
              ? { left: '50%', transform: 'translateX(-50%)' }
              : { left: 0 }),
            zIndex: 200,
            background: T.surface,
            border: `1px solid ${T.border}`,
            borderRadius: T.r,
            boxShadow: T.shadowLg,
            width: 300,
            marginTop: 4,
            overflow: 'hidden',
          }}
        >
          {!customMode && (
            <>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 10px',
                  borderBottom: `1px solid ${T.border}`,
                }}
              >
                <span style={{ color: T.textGhost, display: 'flex' }}>{I.search}</span>
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={onKeyDown}
                  placeholder="Search stages…"
                  aria-label="Search stages"
                  style={{
                    flex: 1,
                    background: 'none',
                    border: 'none',
                    outline: 'none',
                    fontSize: 12,
                    color: T.text,
                  }}
                />
              </div>
              <div role="listbox" tabIndex={0} style={{ maxHeight: 280, overflowY: 'auto' }}>
                {filtered.length === 0 && (
                  <div style={{ padding: '10px', fontSize: 11, color: T.textMuted, textAlign: 'center' }}>
                    No stages match “{query}”
                  </div>
                )}
                {filtered.map((op, idx) => {
                  const info = STAGE_OP_INFO[op];
                  const c = OP_COLOR[op] ?? { bg: 'rgba(100,100,100,0.15)', text: '#888' };
                  const active = idx === focusEffective;
                  return (
                    <div
                      key={op}
                      role="option"
                      aria-selected={active}
                      tabIndex={-1}
                      onMouseEnter={() => setFocusIdx(idx)}
                      onClick={() => pick(op)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '8px 12px',
                        cursor: 'pointer',
                        background: active ? T.accentSoft : 'transparent',
                      }}
                    >
                      <span
                        style={{
                          fontFamily: 'JetBrains Mono, monospace',
                          fontSize: 12,
                          fontWeight: 600,
                          padding: '2px 6px',
                          borderRadius: T.rx,
                          background: c.bg,
                          color: c.text,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {op}
                      </span>
                      <span style={{ fontSize: 11.5, color: T.textMuted }}>{info?.desc ?? ''}</span>
                    </div>
                  );
                })}
              </div>
              <div style={{ borderTop: `1px solid ${T.border}` }}>
                <UnstyledButton
                  onClick={() => setCustomMode(true)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    width: '100%',
                    padding: '8px 12px',
                    fontSize: 11.5,
                    color: T.textMuted,
                  }}
                >
                  {I.plus} Other / custom stage…
                </UnstyledButton>
              </div>
            </>
          )}
          {customMode && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 10 }}>
              <div style={{ fontSize: 11, color: T.textMuted }}>
                Custom stage operator (e.g. <code>myStage</code>)
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  ref={customInputRef}
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  onKeyDown={onCustomKeyDown}
                  placeholder="myStage"
                  aria-label="Custom stage operator"
                  style={{
                    flex: 1,
                    background: T.bg,
                    border: `1px solid ${T.border}`,
                    borderRadius: T.rs,
                    outline: 'none',
                    fontSize: 12,
                    color: T.text,
                    padding: '4px 8px',
                  }}
                />
                <Button
                  variant="light"
                  size="compact-xs"
                  fz={11}
                  onClick={submitCustom}
                  aria-label="Add custom stage"
                  disabled={!cleanCustomName}
                >
                  Add
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
      {open && !customMode && panelPos && focusedDoc?.description && (
        <div
          // A positioning box, nothing more: the note, its label and the id
          // `aria-describedby` points at all live on OperatorDocPanel's own
          // root. `presentation` says that honestly and is not inherited, so
          // the note and its link stay exposed. The mousedown is swallowed so
          // it never reaches an outer click-outside listener — without it,
          // clicking the panel's "Learn more" link closes the picker first.
          role="presentation"
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            top: panelPos.top,
            left: panelPos.left,
            zIndex: 201,
          }}
        >
          <OperatorDocPanel op={focusedDoc} variant="side" />
        </div>
      )}
      {open && (
        <div
          // A click-catcher, not a control. `role="button"` here would have
          // announced a full-screen button to every screen-reader user and,
          // because `button` is on jsx-a11y's tabbable list, traded S6848 for
          // S6852 unless it also took a tab stop covering the whole viewport.
          // `aria-hidden` is the truth: Escape from the search input is the
          // keyboard path, so nothing is lost by hiding a mouse-only overlay.
          aria-hidden="true"
          style={{ position: 'fixed', inset: 0, zIndex: 199 }}
          onClick={(e) => {
            e.stopPropagation();
            close();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              if (e.key === ' ') e.preventDefault();
              e.stopPropagation();
              close();
            }
          }}
        />
      )}
    </div>
  );
}

// ─── AddStagePill ──────────────────────────────────────────────────────────

function AddStagePill({ onAdd }: { onAdd: (op: StageOp | string) => void }) {
  const T = themeVars;
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: '6px 0' }}>
      <StageOpPicker
        onPick={onAdd}
        align="center"
        renderTrigger={(_open, toggle) => (
          <Button
            variant="default"
            size="compact-xs"
            radius="xl"
            c={T.textMuted}
            onClick={toggle}
            leftSection={I.plus}
            style={{ borderStyle: 'dashed' }}
          >
            Add stage
          </Button>
        )}
      />
    </div>
  );
}

// ─── Stage row ────────────────────────────────────────────────────────────

interface StageRowProps {
  stage: Stage;
  index: number;
  total: number;
  active: boolean;
  darkMode: boolean;
  count: number | undefined;
  stale: boolean;
  previewLoading: boolean;
  sample: unknown[];
  suggestionContext: SuggestionContext | null;
  onToggleActive: () => void;
  onToggleEnabled: () => void;
  onChangeOp: (op: StageOp | string) => void;
  onBodyChange: (body: string) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
  onDuplicate: () => void;
  onRunToStage: () => void;
  onRefreshPreview: () => void;
  dragging: boolean;
  dragOver: boolean;
  onGripDragStart: () => void;
  onGripDragEnd: () => void;
  onRowDragOver: () => void;
  onRowDrop: () => void;
}

function StageRow({
  stage,
  index,
  total,
  active,
  darkMode,
  count,
  stale,
  previewLoading,
  sample,
  suggestionContext,
  onToggleActive,
  onToggleEnabled,
  onChangeOp,
  onBodyChange,
  onMoveUp,
  onMoveDown,
  onRemove,
  onDuplicate,
  onRunToStage,
  onRefreshPreview,
  dragging,
  dragOver,
  onGripDragStart,
  onGripDragEnd,
  onRowDragOver,
  onRowDrop,
}: StageRowProps) {
  const T = themeVars;
  const c = opColor(stage.op, darkMode);
  const [localBody, setLocalBody] = React.useState(stage.body);
  const [bodyErr, setBodyErr] = React.useState<string | null>(null);
  const [previewCollapsedKeys, setPreviewCollapsedKeys] = React.useState<Set<string>>(() => new Set());
  const togglePreviewCollapse = React.useCallback((key: string) => {
    setPreviewCollapsedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const dirtyRef = React.useRef(false);
  const idleTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Read via getter closures (mirrors ScriptEditor's own `getCollections`
  // ref pattern) so the completion source stays fresh across an in-place op
  // change or connection swap without rebuilding the CodeMirror view.
  const suggestionContextRef = React.useRef(suggestionContext);
  React.useEffect(() => {
    suggestionContextRef.current = suggestionContext;
  }, [suggestionContext]);
  const stageOpRef = React.useRef(stage.op);
  React.useEffect(() => {
    stageOpRef.current = stage.op;
  }, [stage.op]);
  // A factory, not the built source itself: `ScriptEditor` calls this once
  // inside its own mount effect (mirroring where it builds `mongoCompletions`
  // from `getCollections`/`getFieldContext`) — reading `*Ref.current` can
  // only happen in an effect/event handler, never synchronously in render.
  const buildCompletionSource = () =>
    stageBodyCompletionSource({
      getContext: () => suggestionContextRef.current,
      getStageOp: () => stageOpRef.current,
    });

  // Sync external updates only when we're not mid-edit (cleared on blur —
  // see `onEditorBlur` below).
  React.useEffect(() => {
    if (!dirtyRef.current) {
      setLocalBody(stage.body);
    }
  }, [stage.body]);

  React.useEffect(() => {
    return () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, []);

  // Takes an explicit `body` (rather than closing over `localBody`) so the
  // debounced call in `onChange` below validates the text that was actually
  // typed, not whatever `localBody` was at the time the timer was scheduled
  // (a `setTimeout` closure keeps referencing the function it captured at
  // schedule time even after `localBody` state has since moved on).
  const validate = React.useCallback(
    (body: string) => {
      const err = validateStageBody({ ...stage, body });
      setBodyErr(err);
    },
    [stage],
  );

  // X14 §4 — the conversion point, in the box the user typed in. Shell Syntax
  // becomes Canonical EJSON on blur, so `stage.body` (and everything reading it:
  // Run, Explain, the per-stage preview, a saved pipeline) never holds a dialect
  // the main process's `ejsonParse` would refuse. The seam's `commit` writes the
  // repair back into both the local draft and the parent, same as the old
  // `repairOnCommit` glue did; `validate` then judges the text the repair
  // produced, not the pre-repair state a patch has not landed yet.
  const bodyField = useShellSyntaxField({
    value: localBody,
    commit: (repaired) => {
      setLocalBody(repaired);
      onBodyChange(repaired);
    },
  });

  const onChange = (val: string) => {
    setLocalBody(val);
    dirtyRef.current = true;
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => {
      validate(val);
    }, 400);
    onBodyChange(val);
  };

  const onEditorBlur = () => {
    dirtyRef.current = false;
    if (idleTimer.current) clearTimeout(idleTimer.current);
    const { text } = bodyField.commitNow();
    validate(text);
  };

  // Format commits the pretty-printed text, not the repaired text, so it takes
  // `repairNow` — repair only, no auto-commit — rather than `onBlur`/`commitNow`.
  // Without the repair `formatBody`'s `JSON.parse` fails on Shell Syntax and
  // returns the body untouched — a button that now passes validation and then
  // does nothing.
  const onFormat = () => {
    const err = validateStageBody({ ...stage, body: localBody });
    if (err) return;
    const { text } = bodyField.repairNow();
    const pretty = formatBody(text);
    setLocalBody(pretty);
    onBodyChange(pretty);
  };

  const onCopy = () => {
    void copyToClipboard(localBody, 'Stage copied to the clipboard.');
  };

  const summary = React.useMemo(() => stageSummary({ ...stage, body: localBody }), [stage, localBody]);
  const writeWarn = isWriteStage(stage.op) && stage.enabled;

  return (
    <div
      data-testid={`stage-row-${stage.id}`}
      onDragOver={(e) => {
        e.preventDefault();
        onRowDragOver();
      }}
      onDrop={(e) => {
        e.preventDefault();
        onRowDrop();
      }}
      style={{
        border: `1px solid ${dragOver ? T.accent : active ? T.accentBorder : T.border}`,
        borderRadius: T.r,
        background: T.surface,
        boxShadow: dragOver
          ? `inset 0 1px 0 0 ${T.accentBorder}`
          : active
          ? `0 0 0 1px ${T.accentBorder}`
          : 'none',
        overflow: 'hidden',
        opacity: (stage.enabled ? 1 : 0.5) * (dragging ? 0.6 : 1),
      }}
    >
      {writeWarn && (
        <div
          role="alert"
          style={{
            padding: '4px 10px',
            fontSize: 11,
            color: T.red,
            background: 'rgba(180,60,60,0.08)',
            borderBottom: `1px solid ${T.border}`,
          }}
        >
          ⚠ This stage writes to MongoDB. Runs outside Explain will modify data.
        </div>
      )}
      <div
        // `group`, deliberately not `button` — see the same choice on
        // JsonView's DocCard for the full reasoning. Short version: `button`
        // is "children presentational" and this row holds the op picker, the
        // ON/OFF switch and the move / duplicate / delete buttons, which such
        // a role may not contain. `group` is not children presentational, so
        // they stay exposed, and it still satisfies S6848 — that rule wants a
        // role, not specifically an interactive one.
        //
        // The keyboard path is the summary-text button below, which is a leaf.
        role="group"
        aria-label={`Stage ${index + 1}${stage.op ? `: ${stage.op}` : ''}`}
        onClick={onToggleActive}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 10px',
          cursor: 'pointer',
          background: active ? T.accentSoft : 'transparent',
        }}
      >
        <span
          // Mouse-only by nature: HTML5 drag has no keyboard equivalent, and
          // the Move up / Move down buttons in this same row are the keyboard
          // path. So it is hidden from assistive tech rather than dressed up
          // as a button — an `aria-label` on a span with no role is ignored
          // anyway. The click handler exists only to stop a stray click on the
          // handle bubbling to the header row and toggling the stage.
          aria-hidden="true"
          data-testid={`stage-drag-handle-${stage.id}`}
          draggable
          onClick={(e) => e.stopPropagation()}
          title="Drag to reorder"
          onDragStart={(e) => {
            // Firefox refuses to initiate an HTML5 drag unless dataTransfer
            // has data set during `dragstart`; the value itself is unused.
            e.dataTransfer?.setData('text/plain', '');
            onGripDragStart();
          }}
          onDragEnd={onGripDragEnd}
          style={{ color: T.textGhost, display: 'flex', cursor: 'grab' }}
        >
          {I.drag}
        </span>
        <span
          style={{ fontSize: 10, color: T.textGhost, width: 14, textAlign: 'center', flexShrink: 0 }}
        >
          {index + 1}
        </span>
        <StageOpPicker
          onPick={onChangeOp}
          align="left"
          renderTrigger={(_open, toggle) => (
            <OperatorTooltip name={stage.op} prefClass="stage" placement="right">
              <UnstyledButton
                onClick={(e) => {
                  e.stopPropagation();
                  toggle();
                }}
                aria-label={`Change operator for stage ${index + 1} (currently ${stage.op})`}
                style={{
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 11.5,
                  fontWeight: 700,
                  padding: '2px 7px',
                  borderRadius: T.rx,
                  background: c.bg,
                  color: c.text,
                  flexShrink: 0,
                }}
              >
                {stage.op}
              </UnstyledButton>
            </OperatorTooltip>
          )}
        />
        {!isKnownOp(stage.op) && (
          <span
            title="Unknown operator — server will decide"
            style={{
              fontSize: 9,
              color: T.warn,
              background: 'rgba(200,160,0,0.1)',
              padding: '1px 5px',
              borderRadius: T.rx,
            }}
          >
            Unknown op
          </span>
        )}
        {/* The accessible leaf for expand/collapse (S6852 — see the row div's
            comment above): only the summary text becomes a real <button>,
            same shape as the sortable column header in TableView.tsx. */}
        <UnstyledButton
          type="button"
          data-stage-summary={stage.id}
          aria-expanded={active}
          onClick={(e) => {
            e.stopPropagation();
            onToggleActive();
          }}
          style={{
            font: 'inherit',
            fontSize: 11.5,
            color: bodyErr ? T.red : T.textMuted,
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {bodyErr ? '(invalid)' : summary}
        </UnstyledButton>
        {typeof count === 'number' && (
          <span
            style={{
              fontSize: 10,
              color: T.textGhost,
              background: T.surfaceRaised,
              border: `1px solid ${T.border}`,
              borderRadius: T.rx,
              padding: '1px 5px',
              flexShrink: 0,
              fontVariantNumeric: 'tabular-nums',
            }}
            title={stale ? 'Stale (edited since last run)' : undefined}
          >
            {fmt(count)}
            {stale ? ' ⚠' : ''}
          </span>
        )}
        <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
          <Tooltip label={stage.enabled ? 'Disable' : 'Enable'} withArrow>
            <Button
              variant={stage.enabled ? 'light' : 'default'}
              size="compact-xs"
              h={18}
              px={5}
              fz={9}
              fw={700}
              c={stage.enabled ? undefined : T.textGhost}
              onClick={(e) => {
                e.stopPropagation();
                onToggleEnabled();
              }}
              aria-label={stage.enabled ? 'Disable stage' : 'Enable stage'}
            >
              {stage.enabled ? 'ON' : 'OFF'}
            </Button>
          </Tooltip>
          <Tooltip label="Move up" withArrow>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                onMoveUp();
              }}
              disabled={index === 0}
              aria-label="Move stage up"
            >
              {I.chevU}
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Move down" withArrow>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                onMoveDown();
              }}
              disabled={index === total - 1}
              aria-label="Move stage down"
            >
              {I.chevD}
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Duplicate" withArrow>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                onDuplicate();
              }}
              aria-label="Duplicate stage"
            >
              {I.copy}
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Delete" withArrow>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
              aria-label="Delete stage"
            >
              {I.trash}
            </ActionIcon>
          </Tooltip>
          <span style={{ display: 'flex', color: T.textGhost }}>
            {active ? I.chevU : I.chevD}
          </span>
        </div>
      </div>

      {active && (
        <div style={{ display: 'flex', borderTop: `1px solid ${T.border}` }}>
          <div style={{ flex: 1, padding: 10, display: 'flex', flexDirection: 'column' }}>
            <div
              style={{
                border: `1px solid ${bodyErr ? T.red : T.border}`,
                borderRadius: T.rs,
                overflow: 'hidden',
              }}
            >
              <ScriptEditor
                value={localBody}
                onChange={onChange}
                onBlur={onEditorBlur}
                onRunAlt={previewLoading ? undefined : onRunToStage}
                completionSource={buildCompletionSource}
                connectionId={suggestionContext?.connectionId}
                dbName={suggestionContext?.dbName}
                height={240}
                testId={`stage-body-editor-${stage.id}`}
                ariaLabel={`Body of stage ${stage.op}`}
              />
            </div>
            {bodyErr && (
              <div
                role="alert"
                style={{ marginTop: 6, fontSize: 11, color: T.red }}
              >
                {bodyErr}
              </div>
            )}
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <Tooltip label="Copy body" withArrow>
                <Button variant="default" size="compact-xs" fz={11} c={T.textMuted} onClick={onCopy}>
                  Copy
                </Button>
              </Tooltip>
              <Tooltip label="Pretty-print" withArrow>
                <Button variant="default" size="compact-xs" fz={11} c={T.textMuted} onClick={onFormat}>
                  Format
                </Button>
              </Tooltip>
              <Tooltip label={`Run up to this stage (${formatShortcut('⇧⌘↵', isMacRenderer())})`} withArrow>
                <Button
                  variant="light"
                  size="compact-xs"
                  fz={11}
                  onClick={onRunToStage}
                  disabled={previewLoading}
                >
                  Run to here
                </Button>
              </Tooltip>
              <div style={{ flex: 1 }} />
            </div>
          </div>
          <div
            style={{
              width: 280,
              borderLeft: `1px solid ${T.border}`,
              display: 'flex',
              flexDirection: 'column',
              flexShrink: 0,
            }}
          >
            <div
              style={{
                padding: '6px 10px',
                borderBottom: `1px solid ${T.border}`,
                fontSize: 11,
                color: T.textMuted,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                Stage preview {typeof count === 'number' && `· ${fmt(count)} docs`}
                {stale && <span title="Stage edited after last run"> · ⚠ stale</span>}
              </span>
              <Tooltip label="Refresh preview" withArrow>
                <Button
                  variant="default"
                  size="compact-xs"
                  h={18}
                  px={6}
                  fz={10}
                  c={previewLoading ? undefined : T.textMuted}
                  onClick={onRefreshPreview}
                  disabled={previewLoading}
                >
                  Refresh
                </Button>
              </Tooltip>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
              {!stage.enabled ? (
                <div style={{ fontSize: 11, color: T.textMuted, padding: 8 }}>
                  Stage is disabled.
                </div>
              ) : sample.length === 0 ? (
                <div style={{ fontSize: 11, color: T.textMuted, padding: 8 }}>
                  {previewLoading ? 'Running preview…' : 'Run to see output.'}
                </div>
              ) : (
                sample.slice(0, 5).map((doc, i) => (
                  <div
                    key={i}
                    style={{
                      marginBottom: 6,
                      padding: '6px 8px',
                      background: T.surfaceRaised,
                      borderRadius: T.rs,
                      border: `1px solid ${T.border}`,
                    }}
                  >
                    <HighlightedJson
                      json={safeStringify(doc)}
                      docKey={docKey(doc, i)}
                      collapsedKeys={previewCollapsedKeys}
                      onToggle={togglePreviewCollapse}
                    />
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** For the per-stage preview, rendered like every other result surface. */
function safeStringify(v: unknown): string {
  try {
    return ejsonStringifyReadable(v, 1);
  } catch {
    try {
      return JSON.stringify(v, null, 1);
    } catch {
      return String(v);
    }
  }
}

// ─── Accordion ────────────────────────────────────────────────────────────

export function StageAccordion(props: AccordionProps) {
  const T = themeVars;
  const {
    stages,
    activeId,
    collection,
    sourceCount,
    outputCount,
    stageCounts,
    stageSamples,
    staleStageIds,
    previewLoading,
    darkMode,
    suggestionContext,
    onAdd,
    onToggleActive,
    onToggleEnabled,
    onChangeOp,
    onBodyChange,
    onMoveUp,
    onMoveDown,
    onReorder,
    onRemove,
    onDuplicate,
    onRunToStage,
    onRefreshPreview,
  } = props;

  const rootRef = React.useRef<HTMLDivElement>(null);
  const prevIdsRef = React.useRef<number[]>(stages.map((s) => s.id));

  // Keep keyboard focus anchored when a stage appears or disappears: the
  // button that held it (a picker option, the stage's own delete button) is
  // gone, and focus would otherwise drop to <body>. Only a single add or a
  // single removal moves focus, and only when focus is already lost or inside
  // the accordion, so loading a pipeline or an edit elsewhere never steals it.
  React.useLayoutEffect(() => {
    const prev = prevIdsRef.current;
    const ids = stages.map((s) => s.id);
    prevIdsRef.current = ids;
    const added = ids.filter((id) => !prev.includes(id));
    const removed = prev.filter((id) => !ids.includes(id));
    const root = rootRef.current;
    if (!root || added.length + removed.length !== 1) return;
    const focused = document.activeElement;
    if (focused && focused !== document.body && !root.contains(focused)) return;
    const summary = (id: number | undefined) =>
      id === undefined ? null : root.querySelector<HTMLElement>(`[data-stage-summary="${id}"]`);
    if (added.length === 1) {
      summary(added[0])?.focus();
      return;
    }
    const at = prev.indexOf(removed[0]);
    (
      summary(ids[at]) ??
      summary(ids[at - 1]) ??
      root.querySelector<HTMLElement>('[data-add-stage-tail] button')
    )?.focus();
  }, [stages]);

  const [dragStageId, setDragStageId] = React.useState<number | null>(null);
  const [dragOverStageId, setDragOverStageId] = React.useState<number | null>(null);

  const handleDrop = (targetId: number) => {
    if (dragStageId == null || dragStageId === targetId) {
      setDragStageId(null);
      setDragOverStageId(null);
      return;
    }
    const from = stages.findIndex((s) => s.id === dragStageId);
    const to = stages.findIndex((s) => s.id === targetId);
    if (from !== -1 && to !== -1) {
      onReorder(from, to);
    }
    setDragStageId(null);
    setDragOverStageId(null);
  };

  return (
    <div ref={rootRef} style={{ flex: 1, overflowY: 'auto', padding: '14px 16px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 8,
          padding: '7px 12px',
          background: T.surfaceRaised,
          border: `1px solid ${T.border}`,
          borderRadius: T.rs,
        }}
      >
        <span style={{ color: T.textMuted, display: 'flex' }}>{I.db}</span>
        <span style={{ fontSize: 12, color: T.textMuted }}>{collection || '(source)'}</span>
        {sourceCount !== null && (
          <span style={{ fontSize: 11, color: T.textMuted }}>{fmt(sourceCount)} documents</span>
        )}
      </div>

      {stages.map((stage, idx) => (
        <div key={stage.id}>
          <AddStagePill onAdd={(op) => onAdd(op, idx - 1)} />
          <StageRow
            stage={stage}
            index={idx}
            total={stages.length}
            active={activeId === stage.id}
            darkMode={darkMode}
            count={stageCounts[stage.id]}
            stale={staleStageIds.has(stage.id)}
            previewLoading={previewLoading.has(stage.id)}
            sample={stageSamples[stage.id] ?? []}
            suggestionContext={suggestionContext}
            onToggleActive={() => onToggleActive(stage.id)}
            onToggleEnabled={() => onToggleEnabled(stage.id)}
            onChangeOp={(op) => onChangeOp(stage.id, op)}
            onBodyChange={(b) => onBodyChange(stage.id, b)}
            onMoveUp={() => onMoveUp(idx)}
            onMoveDown={() => onMoveDown(idx)}
            onRemove={() => onRemove(stage.id)}
            onDuplicate={() => onDuplicate(stage.id)}
            onRunToStage={() => onRunToStage(stage.id)}
            onRefreshPreview={() => onRefreshPreview(stage.id)}
            dragging={dragStageId === stage.id}
            dragOver={dragOverStageId === stage.id && dragStageId !== stage.id}
            onGripDragStart={() => setDragStageId(stage.id)}
            onGripDragEnd={() => {
              setDragStageId(null);
              setDragOverStageId(null);
            }}
            onRowDragOver={() => setDragOverStageId(stage.id)}
            onRowDrop={() => handleDrop(stage.id)}
          />
        </div>
      ))}

      <div data-add-stage-tail>
        <AddStagePill onAdd={(op) => onAdd(op)} />
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginTop: 4,
          padding: '7px 12px',
          background: T.accentSoft,
          border: `1px solid ${T.accentBorder}`,
          borderRadius: T.rs,
        }}
      >
        <span style={{ color: T.accent, display: 'flex' }}>{I.arrowR}</span>
        <span style={{ fontSize: 12, color: T.accent, fontWeight: 600 }}>Output</span>
        {outputCount !== null && (
          <span style={{ fontSize: 11, color: T.accent }}>{fmt(outputCount)} documents</span>
        )}
      </div>
    </div>
  );
}
