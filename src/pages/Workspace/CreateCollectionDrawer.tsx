import React from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Drawer,
  Group,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { api, getErrorMessage } from '../../api/atelier';
import { confirmDestructive } from '../../utils/confirm';
import { useDialogFocusReturn } from '../../hooks/useDialogFocusReturn';
import { SubmitButton } from '../../components/SubmitButton';
import type {
  CollectionCreateOptions,
  ValidationAction,
  ValidationLevel,
} from '@shared/types';

interface CreateCollectionDrawerProps {
  connectionId: string;
  /**
   * Fixed target database (navigator "Create collection" on a DB row). When
   * omitted (DetailPanel's tab-level "New collection" button has no single
   * DB context), a database-name field is rendered so the caller can target
   * an existing DB or type a new one — MongoDB creates the database
   * implicitly on first collection create.
   */
  dbName?: string;
  onCancel: () => void;
  onCreated: (result: { dbName: string; name: string }) => void;
  /** Supplied when the opener is gone by first render (context menu). */
  returnFocusTo?: HTMLElement | null;
}

const GRANULARITY_OPTIONS = [
  { value: 'seconds', label: 'seconds' },
  { value: 'minutes', label: 'minutes' },
  { value: 'hours', label: 'hours' },
];

const VALIDATION_LEVEL_OPTIONS: { value: ValidationLevel; label: string }[] = [
  { value: 'strict', label: 'strict' },
  { value: 'moderate', label: 'moderate' },
  { value: 'off', label: 'off' },
];

const VALIDATION_ACTION_OPTIONS: { value: ValidationAction; label: string }[] = [
  { value: 'error', label: 'error' },
  { value: 'warn', label: 'warn' },
];

/**
 * Hoisted out of the `useState` call so the dirty check below compares against
 * the same literal the field opens with. Inlining it in both places is how the
 * two drift.
 */
const DEFAULT_COLLATION = '{\n  "locale": "en"\n}';
const DEFAULT_VALIDATOR = '{}';

export function CreateCollectionDrawer({
  connectionId,
  dbName: fixedDbName,
  onCancel,
  onCreated,
  returnFocusTo,
}: CreateCollectionDrawerProps) {
  const close = useDialogFocusReturn(onCancel, returnFocusTo);
  const [dbNameInput, setDbNameInput] = React.useState('');
  const [name, setName] = React.useState('');

  const [cappedEnabled, setCappedEnabled] = React.useState(false);
  const [size, setSize] = React.useState('');
  const [max, setMax] = React.useState('');

  const [clusteredEnabled, setClusteredEnabled] = React.useState(false);
  const [clusteredName, setClusteredName] = React.useState('');

  const [timeseriesEnabled, setTimeseriesEnabled] = React.useState(false);
  const [timeField, setTimeField] = React.useState('');
  const [metaField, setMetaField] = React.useState('');
  const [granularity, setGranularity] = React.useState<string | null>(null);

  const [collationEnabled, setCollationEnabled] = React.useState(false);
  const [collation, setCollation] = React.useState(DEFAULT_COLLATION);

  const [validatorEnabled, setValidatorEnabled] = React.useState(false);
  const [validator, setValidator] = React.useState(DEFAULT_VALIDATOR);
  const [validationLevel, setValidationLevel] = React.useState<ValidationLevel>('strict');
  const [validationAction, setValidationAction] = React.useState<ValidationAction>('error');

  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Which capped field the validation error is about, so it can take focus and
  // be tied to the alert for assistive tech.
  const [errorField, setErrorField] = React.useState<'size' | 'max' | null>(null);
  const sizeRef = React.useRef<HTMLInputElement>(null);
  const maxRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (errorField === 'size') sizeRef.current?.focus();
    else if (errorField === 'max') maxRef.current?.focus();
  }, [errorField, error]);

  const effectiveDbName = fixedDbName ?? dbNameInput.trim();
  const trimmedName = name.trim();
  const canSubmit =
    trimmedName.length > 0 &&
    effectiveDbName.length > 0 &&
    !(cappedEnabled && size.trim().length === 0) &&
    !(timeseriesEnabled && timeField.trim().length === 0);

  // X15 §2 — the dirty guard, as the disjunction over EVERY field this drawer
  // owns rather than the focused one. A per-field check is wrong in a way that
  // is easy to ship and hard to notice: fill three fields, clear the last one,
  // dismiss, and a check reading only that field reports clean while the other
  // three are lost. Every field opens at a known constant, so "differs from
  // initial" is a comparison against that constant — not a "was touched" flag,
  // which would prompt after typing a character and deleting it again.
  const isDirty =
    dbNameInput !== '' ||
    name !== '' ||
    cappedEnabled ||
    size !== '' ||
    max !== '' ||
    clusteredEnabled ||
    clusteredName !== '' ||
    timeseriesEnabled ||
    timeField !== '' ||
    metaField !== '' ||
    granularity !== null ||
    collationEnabled ||
    collation !== DEFAULT_COLLATION ||
    validatorEnabled ||
    validator !== DEFAULT_VALIDATOR ||
    validationLevel !== 'strict' ||
    validationAction !== 'error';

  const requestClose = async () => {
    if (!isDirty) return close();
    const discard = await confirmDestructive({
      title: 'Discard changes?',
      body: 'This closes the editor and loses what you typed.',
      confirmLabel: 'Discard',
    });
    if (discard) close();
  };

  // #89 — both paths restore focus to the same `returnFocusTo` (the tree
  // container survives a create, unlike #74's tabs which had nothing to
  // restore to). Two calls because `useDialogFocusReturn` memoizes on its
  // own `onClose`, so one hook can't serve two different close reasons.
  const finish = useDialogFocusReturn(
    () => onCreated({ dbName: effectiveDbName, name: trimmedName }),
    returnFocusTo,
  );

  const submit = async () => {
    if (!canSubmit || submitting) return;
    setError(null);
    setErrorField(null);

    const options: CollectionCreateOptions = {};
    if (cappedEnabled) {
      const n = Number(size);
      if (!Number.isInteger(n) || n <= 0) {
        setError('Capped size must be a positive integer of bytes.');
        setErrorField('size');
        return;
      }
      options.capped = true;
      options.size = n;
      if (max.trim()) {
        const m = Number(max);
        if (!Number.isInteger(m) || m <= 0) {
          setError('Max document count must be a positive integer.');
          setErrorField('max');
          return;
        }
        options.max = m;
      }
    }
    if (timeseriesEnabled) {
      options.timeseries = {
        timeField: timeField.trim(),
        ...(metaField.trim() ? { metaField: metaField.trim() } : {}),
        ...(granularity ? { granularity: granularity as 'seconds' | 'minutes' | 'hours' } : {}),
      };
    }
    if (clusteredEnabled) {
      options.clustered = true;
      if (clusteredName.trim()) options.clusteredIndexName = clusteredName.trim();
    }
    if (collationEnabled) {
      try {
        const parsed: unknown = JSON.parse(collation);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('not a JSON object');
        }
      } catch {
        setError('collation: invalid JSON object.');
        return;
      }
      options.collation = collation;
    }
    if (validatorEnabled) {
      try {
        const parsed: unknown = JSON.parse(validator);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('not a JSON object');
        }
      } catch {
        setError('validator: invalid JSON object.');
        return;
      }
      options.validator = validator;
      options.validationLevel = validationLevel;
      options.validationAction = validationAction;
    }

    setSubmitting(true);
    try {
      await api.collection.create({
        connectionId,
        dbName: effectiveDbName,
        collection: trimmedName,
        options,
      });
      finish();
    } catch (err) {
      setError(getErrorMessage(err, 'Create collection failed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    // X15 §2 — see the note in `DocumentEditor.tsx`'s Modal. The backdrop is
    // inert: it does not close and it does not prompt. Escape goes through
    // the guard.
    <Drawer
      opened
      onClose={() => void requestClose()}
      position="right"
      size={400}
      title={fixedDbName ? `New collection — ${fixedDbName}` : 'New collection'}
      padding="md"
      closeOnClickOutside={false}
    >
      <Stack gap="md" style={{ height: '100%' }}>
        {!fixedDbName && (
          <TextInput
            label="Database name"
            aria-label="Database name"
            value={dbNameInput}
            onChange={(e) => setDbNameInput(e.currentTarget.value)}
            placeholder="existing or new database"
            size="xs"
          />
        )}

        <TextInput
          label="Collection name"
          aria-label="Collection name"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          autoFocus
          size="xs"
        />

        <Stack gap={6}>
          <Checkbox
            label="Capped collection"
            aria-label="Capped"
            checked={cappedEnabled}
            onChange={(e) => setCappedEnabled(e.currentTarget.checked)}
            disabled={clusteredEnabled}
            size="xs"
          />
          {cappedEnabled && (
            <Group gap="xs" pl="lg">
              <TextInput
                ref={sizeRef}
                type="number"
                inputMode="numeric"
                min={1}
                label="Size (bytes)"
                aria-label="Capped size (bytes)"
                error={errorField === 'size' ? error : undefined}
                value={size}
                onChange={(e) => setSize(e.currentTarget.value)}
                size="xs"
              />
              <TextInput
                ref={maxRef}
                type="number"
                inputMode="numeric"
                min={1}
                label="Max documents (optional)"
                aria-label="Capped max documents"
                error={errorField === 'max' ? error : undefined}
                value={max}
                onChange={(e) => setMax(e.currentTarget.value)}
                size="xs"
              />
            </Group>
          )}
        </Stack>

        <Stack gap={6}>
          <Checkbox
            label="Time series"
            aria-label="Time series"
            checked={timeseriesEnabled}
            onChange={(e) => setTimeseriesEnabled(e.currentTarget.checked)}
            disabled={clusteredEnabled}
            size="xs"
          />
          {timeseriesEnabled && (
            <Stack gap="xs" pl="lg">
              <TextInput
                label="timeField"
                aria-label="Time series timeField"
                value={timeField}
                onChange={(e) => setTimeField(e.currentTarget.value)}
                size="xs"
              />
              <TextInput
                label="metaField (optional)"
                aria-label="Time series metaField"
                value={metaField}
                onChange={(e) => setMetaField(e.currentTarget.value)}
                size="xs"
              />
              <Select
                label="Granularity (optional)"
                aria-label="Time series granularity"
                data={GRANULARITY_OPTIONS}
                value={granularity}
                onChange={setGranularity}
                clearable
                size="xs"
              />
            </Stack>
          )}
        </Stack>

        <Stack gap={6}>
          <Checkbox
            label="Clustered collection (MongoDB 5.3+)"
            aria-label="Clustered"
            checked={clusteredEnabled}
            onChange={(e) => setClusteredEnabled(e.currentTarget.checked)}
            disabled={cappedEnabled || timeseriesEnabled}
            description={
              cappedEnabled || timeseriesEnabled
                ? 'Not available with capped or time series collections.'
                : undefined
            }
            size="xs"
          />
          {clusteredEnabled && (
            <TextInput
              label="Index name (optional)"
              aria-label="Clustered index name"
              value={clusteredName}
              onChange={(e) => setClusteredName(e.currentTarget.value)}
              size="xs"
              pl="lg"
            />
          )}
        </Stack>

        <Stack gap={6}>
          <Checkbox
            label="Collation (EJSON)"
            aria-label="Collation"
            checked={collationEnabled}
            onChange={(e) => setCollationEnabled(e.currentTarget.checked)}
            size="xs"
          />
          {collationEnabled && (
            <Textarea
              aria-label="Collation EJSON"
              value={collation}
              onChange={(e) => setCollation(e.currentTarget.value)}
              minRows={2}
              styles={{ input: { fontFamily: 'monospace', fontSize: 11 } }}
            />
          )}
        </Stack>

        <Stack gap={6}>
          <Checkbox
            label="Validator (EJSON)"
            aria-label="Validator"
            checked={validatorEnabled}
            onChange={(e) => setValidatorEnabled(e.currentTarget.checked)}
            size="xs"
          />
          {validatorEnabled && (
            <Stack gap="xs">
              <Textarea
                aria-label="Validator EJSON"
                value={validator}
                onChange={(e) => setValidator(e.currentTarget.value)}
                minRows={3}
                styles={{ input: { fontFamily: 'monospace', fontSize: 11 } }}
              />
              <Group gap="xs">
                <Select
                  label="Validation level"
                  aria-label="Validation level"
                  data={VALIDATION_LEVEL_OPTIONS}
                  value={validationLevel}
                  onChange={(v) => v && setValidationLevel(v as ValidationLevel)}
                  size="xs"
                />
                <Select
                  label="Validation action"
                  aria-label="Validation action"
                  data={VALIDATION_ACTION_OPTIONS}
                  value={validationAction}
                  onChange={(v) => v && setValidationAction(v as ValidationAction)}
                  size="xs"
                />
              </Group>
            </Stack>
          )}
        </Stack>

        {!fixedDbName && trimmedName && effectiveDbName && (
          <Text size="xs" c="dimmed">
            Creates {effectiveDbName}.{trimmedName}
          </Text>
        )}

        {error && errorField === null && (
          <Alert color="red" variant="light" role="alert">
            {error}
          </Alert>
        )}

        <Group justify="flex-end" gap="xs" mt="auto">
          <Button
            variant="subtle"
            size="compact-xs"
            onClick={() => void requestClose()}
            disabled={submitting}
          >
            Cancel
          </Button>
          <SubmitButton
            variant="filled"
            size="compact-xs"
            onClick={() => void submit()}
            disabled={!canSubmit}
            submitting={submitting}
          >
            {submitting ? 'Creating…' : 'Create collection'}
          </SubmitButton>
        </Group>
      </Stack>
    </Drawer>
  );
}
