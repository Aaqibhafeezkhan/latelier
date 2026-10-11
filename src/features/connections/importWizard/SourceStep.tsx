import React from 'react';
import { Alert, Button, Group, Stack, Text, Textarea } from '@mantine/core';
import { SubmitButton } from '../../../components/SubmitButton';

/** Mirrors the limits main enforces on pasted lines (C14 §3); main stays the authority. */
const MAX_LINES = 100;
const MAX_LINE_LENGTH = 4096;

function linesOf(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
}

export interface SourceStepProps {
  /** Which half takes focus when the step opens. */
  initial: 'file' | 'paste';
  busy: boolean;
  error?: string;
  onFile(): void;
  onUris(uris: string[]): void;
}

/** C14 §1 step 1: pick a file, or paste connection strings one per line. */
export function SourceStep({ initial, busy, error, onFile, onUris }: SourceStepProps) {
  const [text, setText] = React.useState('');
  const lines = React.useMemo(() => linesOf(text), [text]);
  const tooLong = lines.findIndex((l) => l.length > MAX_LINE_LENGTH);
  const limitError =
    lines.length > MAX_LINES
      ? `Up to ${MAX_LINES} connection strings at a time.`
      : tooLong >= 0
        ? `Line ${tooLong + 1} is longer than ${MAX_LINE_LENGTH.toLocaleString()} characters.`
        : null;

  return (
    <Stack gap="sm">
      <Group gap="xs">
        {/* `data-autofocus` as well: inside a Modal, Mantine's FocusTrap moves focus after
            mount to `[data-autofocus]`, else to the header's close button, overriding `autoFocus`. */}
        <SubmitButton
          size="compact-xs"
          submitting={busy}
          autoFocus={initial === 'file'}
          data-autofocus={initial === 'file' || undefined}
          onClick={onFile}
        >
          Choose file…
        </SubmitButton>
        <Text size="xs" c="dimmed">
          A Connection Export, a Compass export, or any JSON file listing servers.
        </Text>
      </Group>
      <Textarea
        label="Or paste connection strings"
        description="One per line. Each is named after its host."
        placeholder={'mongodb://user:password@db1.example.com:27017\nmongodb+srv://cluster0.example.mongodb.net'}
        rows={5}
        resize="vertical"
        size="xs"
        autoFocus={initial === 'paste'}
        data-autofocus={initial === 'paste' || undefined}
        spellCheck={false}
        autoComplete="off"
        styles={{ input: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' } }}
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        error={limitError ?? undefined}
      />
      <Group justify="space-between">
        <Text size="xs" c="dimmed" aria-live="polite">
          {lines.length.toLocaleString()} / {MAX_LINES} {lines.length === 1 ? 'line' : 'lines'}
        </Text>
        <Button
          size="compact-xs"
          disabled={busy || lines.length === 0 || limitError !== null}
          onClick={() => onUris(lines)}
        >
          Next
        </Button>
      </Group>
      {error && (
        <Alert color="red" variant="light" role="alert">
          {error}
        </Alert>
      )}
    </Stack>
  );
}
