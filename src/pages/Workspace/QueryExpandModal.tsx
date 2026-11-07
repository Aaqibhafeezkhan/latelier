import React from 'react';
import { Alert, Button, Group, Modal, Stack } from '@mantine/core';
import { themeVars } from '../../theme/themeVars';
import { ejsonParse, ejsonStringifyReadable } from '../../utils/ejson';
import { repairOnCommit } from '../../utils/shellSyntax';
import { filterProblem } from './builder';
import { useShellSyntaxField } from './useShellSyntaxField';

interface QueryExpandModalProps {
  queryRaw: string;
  onApply: (next: string) => void;
  onClose: () => void;
}

// Best-effort pretty-print for the popup's initial contents. Falls back to
// the raw text untouched — this is a read-and-edit convenience, not a gate,
// so a query the small bar already shows warty (unrepairable shell syntax,
// a fragment mid-edit) still opens exactly as typed rather than erroring.
function formatForDisplay(text: string): string {
  const { text: canonical } = repairOnCommit(text, () => {});
  try {
    return ejsonStringifyReadable(ejsonParse(canonical), 2);
  } catch {
    return text;
  }
}

/**
 * Popup for reading and editing a query filter that has outgrown the QUERY
 * row's single line — same repair/validate pipeline as that row (X14 §2),
 * just with room to see the whole thing.
 */
export function QueryExpandModal({ queryRaw, onApply, onClose }: QueryExpandModalProps) {
  const T = themeVars;
  const [draft, setDraft] = React.useState(() => formatForDisplay(queryRaw));
  const shell = useShellSyntaxField({ value: draft, commit: setDraft, thenCheck: filterProblem });
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  // Opening this modal without landing in the textarea would defeat its
  // purpose (editing a long filter) — same effect as `autoFocus`, but
  // typescript:S9379 flags the attribute itself, so this drives it by ref.
  React.useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const apply = () => {
    const { text, outcome } = shell.commitNow();
    if (outcome.kind === 'failed' || filterProblem(text)) return;
    onApply(text);
    onClose();
  };

  return (
    <Modal opened onClose={onClose} title="Query filter" centered size="lg">
      <Stack gap="sm">
        <textarea
          ref={textareaRef}
          aria-label="Query filter"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            shell.onChange(e.target.value);
          }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              apply();
            }
          }}
          spellCheck={false}
          data-testid="query-expand-textarea"
          style={{
            width: '100%',
            minHeight: 320,
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: T.fsSm,
            lineHeight: 1.5,
            padding: 10,
            border: `1px solid ${shell.refusal ? T.warn : T.border}`,
            borderRadius: T.rs,
            background: T.surface,
            color: T.text,
            resize: 'vertical',
            outline: 'none',
          }}
        />
        {shell.refusal && (
          <Alert color="yellow" variant="light" role="alert">
            {shell.refusal}
          </Alert>
        )}
        <Group justify="flex-end" gap="xs">
          <Button variant="subtle" size="compact-xs" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="filled" size="compact-xs" onClick={apply} data-testid="query-expand-apply">
            Apply
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
