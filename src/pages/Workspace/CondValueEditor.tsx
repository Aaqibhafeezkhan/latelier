import React from 'react';
import { ActionIcon, Button, Pill, Popover, SegmentedControl, TagsInput, TextInput, Tooltip } from '@mantine/core';
import { themeVars } from '../../theme/themeVars';
import { I } from '../../icons';
import { useSuggestions } from '../../features/fieldSuggestions/useSuggestions';
import { SuggestionPopover } from '../../features/fieldSuggestions/SuggestionPopover';
import { DEFAULT_VALUE_SOURCES } from '../../features/fieldSuggestions/sources';
import type { SuggestionContext } from '../../features/fieldSuggestions/types';
import { VALUE_SUGGESTION_OPS } from '../../features/fieldSuggestions/operators';
import type { CondNode, ValType } from '@shared/types';
import { ARRAY_VALUE_OPS, SIMPLE_OPS } from './filterTree';
import {
  DATE_PRESETS,
  chipText,
  chipsFromValue,
  datePresetValue,
  isoToLocalInput,
  localInputToIso,
  parseChipText,
  valueFromChips,
} from './condValue';


/**
 * Mongosh-flavored preview of the typed value the user just entered. Shown
 * as a faint hint to the right of the value input so the user sees what
 * the wrapped MQL will look like (e.g. `ISODate("2026-04-01")`) without
 * having to read the generated query bar.
 */
function formatCondPreview(cond: { valType: ValType; value: string }): string {
  const v = cond.value;
  switch (cond.valType) {
    case 'string':
      return v ? `"${v}"` : '""';
    case 'number':
      return v || '0';
    case 'long':
      return v ? `NumberLong("${v}")` : 'NumberLong("…")';
    case 'decimal':
      return v ? `NumberDecimal("${v}")` : 'NumberDecimal("…")';
    case 'boolean':
      return v === 'true' ? 'true' : 'false';
    case 'date':
      return v ? `ISODate("${v}")` : 'ISODate("…")';
    case 'null':
      return 'null';
    case 'regex':
      return v ? `/${v}/` : '/…/';
    case 'objectid':
      return v ? `ObjectId("${v}")` : 'ObjectId("…")';
    case 'array':
      return v || '[]';
    default:
      return v || '…';
  }
}

/**
 * The value half of a condition row, shaped by its type and operator (W15
 * §14.3): nothing for `$exists` and `null`, chips for a list, a true / false
 * choice for a boolean, and a date picker beside the text for a date. Every
 * other case is the plain text input. The text input and the chips both
 * offer value suggestions.
 *
 * `problem` is the row's print problem when it is about the value; it shows
 * under the input that holds the value, which names it as that input's
 * description.
 *
 * `onPatch`'s key names the box being typed into; the row turns it into its
 * own undo-coalescing key.
 */
export function CondValueEditor({
  node,
  readOnly,
  problem,
  onPatch,
  suggestionContext,
}: {
  node: CondNode;
  readOnly: boolean;
  problem: string | undefined;
  onPatch: (p: Partial<CondNode>, key?: string) => void;
  suggestionContext: SuggestionContext | null;
}) {
  const T = themeVars;
  const isListOp = ARRAY_VALUE_OPS.has(node.op);
  const chips = isListOp ? chipsFromValue(node.value, node.valType) : null;
  // A list shows as chips until the person asks for the JSON, or starts
  // typing in the text box: a half-typed list that happens to parse must not
  // swap the box out from under the caret.
  const [listAsText, setListAsText] = React.useState(false);
  const chipMode = chips !== null && !listAsText;
  // What is typed in the chip box but not yet a chip.
  const [chipSearch, setChipSearch] = React.useState('');

  // Value suggestions: gated on a non-empty field and one of
  // `VALUE_SUGGESTION_OPS` — every other op (`$exists`, `$regex`, `$mod`, ...)
  // gets none, mirroring what `RecentFieldValueService` will ever record for
  // it. They are asked for only while the value box has focus.
  const valueInputRef = React.useRef<HTMLInputElement>(null);
  const [suggesting, setSuggesting] = React.useState(false);
  const valueSuggestionsAllowed = node.field.trim() !== '' && VALUE_SUGGESTION_OPS.has(node.op);
  const valueSuggestionCtx = React.useMemo<SuggestionContext | null>(
    () =>
      suggestionContext && valueSuggestionsAllowed
        ? { ...suggestionContext, target: { field: node.field, operator: node.op } }
        : null,
    [suggestionContext, valueSuggestionsAllowed, node.field, node.op],
  );
  const { items: valueSuggestionItems } = useSuggestions(
    suggesting ? valueSuggestionCtx : null,
    chipMode ? chipSearch : node.value,
    { valueSources: DEFAULT_VALUE_SOURCES },
  );
  const [datePickerOpen, setDatePickerOpen] = React.useState(false);

  // No input to hang it on: a problem, should one ever reach these rows,
  // still shows.
  const bareProblem = problem && (
    <span role="alert" style={{ fontSize: 10, color: T.warn, lineHeight: 1.3 }}>
      {problem}
    </span>
  );

  if (node.op === '$exists' || node.valType === 'null') return bareProblem || null;

  if (chipMode) {
    // A suggestion is offered as the chip it would become, labelled the way
    // the chip will show; TagsInput leaves out the ones already picked.
    const suggestedChips = [
      ...new Set(
        valueSuggestionItems.flatMap((s) =>
          s.kind === 'value' ? [chipText(parseChipText(s.display, node.valType), node.valType)] : [],
        ),
      ),
    ];
    return (
      <div style={{ display: 'flex', gap: 4, alignItems: 'flex-start', flex: 1, minWidth: 0 }}>
        <TagsInput
          aria-label="Values"
          placeholder="add a value, Enter"
          value={chips.map((c) => chipText(c, node.valType))}
          onChange={(tags) => onPatch({ value: valueFromChips(tags.map((t) => parseChipText(t, node.valType))) })}
          data={suggestedChips}
          searchValue={chipSearch}
          onSearchChange={setChipSearch}
          onFocus={() => setSuggesting(true)}
          onBlur={() => setSuggesting(false)}
          // A comma ends a chip, so a value holding one is entered through
          // "Edit as JSON" instead.
          splitChars={[',', '\n']}
          // Mantine's own check ignores case, which would drop `"A"` from a
          // `$in` that already holds `"a"`; MongoDB treats them as different.
          isDuplicate={(v, current) => current.includes(v)}
          error={problem}
          disabled={readOnly}
          size="xs"
          style={{ flex: 1, minWidth: 0 }}
          styles={{ input: { fontFamily: 'monospace' } }}
          // The stock remove button is hidden from assistive tech and out of
          // the tab order; named and focusable, each chip can be removed by
          // keyboard, not only the last one by Backspace.
          renderPill={({ value, onRemove, disabled }) => (
            <Pill
              withRemoveButton={!disabled}
              onRemove={onRemove}
              disabled={disabled}
              removeButtonProps={{ 'aria-label': `Remove ${value}`, 'aria-hidden': false, tabIndex: 0 }}
            >
              {value}
            </Pill>
          )}
        />
        <ListToggle asText={false} disabled={readOnly} onToggle={() => setListAsText(true)} />
      </div>
    );
  }

  if (node.valType === 'boolean' && SIMPLE_OPS.has(node.op)) {
    return (
      <>
        <SegmentedControl
          aria-label="Value"
          size="xs"
          data={['true', 'false']}
          value={node.value === 'true' ? 'true' : 'false'}
          onChange={(v) => onPatch({ value: v })}
          disabled={readOnly}
        />
        {bareProblem}
      </>
    );
  }

  const isDate = node.valType === 'date' && SIMPLE_OPS.has(node.op);

  // The preview sits on its own line: beside the input it took the width the
  // input and its error message needed once the pane was narrow.
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
      <div style={{ display: 'flex', gap: 4, alignItems: 'flex-start', minWidth: 0 }}>
        <TextInput
          ref={valueInputRef}
          placeholder="value"
          value={node.value}
          disabled={readOnly}
          onChange={(e) => {
            if (isListOp) setListAsText(true);
            onPatch({ value: e.target.value }, 'value');
            if (!suggesting) setSuggesting(true);
          }}
          onFocus={() => setSuggesting(true)}
          onBlur={() => {
            window.setTimeout(() => setSuggesting(false), 100);
          }}
          error={problem}
          size="xs"
          style={{ flex: 1, minWidth: 140 }}
          styles={{ input: { fontFamily: 'monospace' }, error: { fontSize: 10 } }}
        />
        {valueSuggestionsAllowed && (
          <SuggestionPopover
            open={suggesting}
            items={valueSuggestionItems}
            anchorRef={valueInputRef}
            label="Value suggestions"
            onSelect={(s) => {
              if (s.kind === 'value') onPatch({ value: s.display });
              setSuggesting(false);
              valueInputRef.current?.blur();
            }}
            onClose={() => setSuggesting(false)}
          />
        )}
        {isDate && (
          <Popover opened={datePickerOpen} onChange={setDatePickerOpen} position="bottom-end" shadow="md" width={220}>
            <Popover.Target>
              <ActionIcon
                variant="subtle"
                color="gray"
                size="sm"
                aria-label="Pick date"
                aria-expanded={datePickerOpen}
                disabled={readOnly}
                onClick={() => setDatePickerOpen((o) => !o)}
                style={{ marginTop: 2 }}
              >
                {I.clock}
              </ActionIcon>
            </Popover.Target>
            <Popover.Dropdown aria-label="Pick date" style={{ padding: 6 }}>
              <input
                type="datetime-local"
                aria-label="Date and time"
                value={isoToLocalInput(node.value)}
                onChange={(e) => {
                  // Mid-edit the input reports '' until every segment is
                  // filled; writing that would blank the value under it.
                  const iso = localInputToIso(e.target.value);
                  if (iso) onPatch({ value: iso }, 'date');
                }}
                style={{
                  width: '100%',
                  font: 'inherit',
                  fontSize: 11,
                  padding: '3px 4px',
                  color: T.text,
                  background: T.surface,
                  border: `1px solid ${T.border}`,
                  borderRadius: T.rs,
                }}
              />
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', marginTop: 6 }}>
                {DATE_PRESETS.map((p) => (
                  <Button
                    key={p.id}
                    variant="subtle"
                    color="gray"
                    size="compact-xs"
                    styles={{ inner: { justifyContent: 'flex-start' } }}
                    onClick={() => {
                      onPatch({ value: datePresetValue(p.id, new Date()) });
                      setDatePickerOpen(false);
                    }}
                  >
                    {p.label}
                  </Button>
                ))}
              </div>
            </Popover.Dropdown>
          </Popover>
        )}
        {chips !== null && <ListToggle asText disabled={readOnly} onToggle={() => setListAsText(false)} />}
      </div>
      {!problem && (
        <Tooltip label={formatCondPreview(node)} withArrow>
          <span
            aria-hidden="true"
            style={{
              fontSize: 9,
              color: T.textGhost,
              fontFamily: '"JetBrains Mono", monospace',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {formatCondPreview(node)}
          </span>
        </Tooltip>
      )}
    </div>
  );
}

/** Switches a list between chips and its JSON text. */
function ListToggle({ asText, disabled, onToggle }: { asText: boolean; disabled: boolean; onToggle: () => void }) {
  return (
    <Button
      variant="subtle"
      color="gray"
      size="compact-xs"
      disabled={disabled}
      onClick={onToggle}
      styles={{ root: { flexShrink: 0, fontSize: 10, padding: '0 4px', marginTop: 4 } }}
    >
      {asText ? 'Edit as chips' : 'Edit as JSON'}
    </Button>
  );
}
