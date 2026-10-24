import React from 'react';
import { Button } from '@mantine/core';
import { themeVars } from '../../theme/themeVars';
import { I } from '../../icons';
import { api, getErrorMessage } from '../../api/atelier';
import { SubmitButton } from '../../components/SubmitButton';
import { ejsonParse, ejsonStringifyReadable, isEjsonDocument } from '../../utils/ejson';
import { invalidateSchemaEnumCache } from '../../features/fieldSuggestions/sources/schemaEnumSource';
import type { CollectionDetails } from '@shared/ipc';
import type { ValidationAction, ValidationLevel } from '@shared/types';

interface Props {
  connectionId: string;
  dbName: string;
  collection: string;
  details: CollectionDetails;
  /** Reads the details again after a save. */
  onSaved: () => void | Promise<void>;
}

const LEVELS: ValidationLevel[] = ['off', 'strict', 'moderate'];
const ACTIONS: ValidationAction[] = ['error', 'warn', 'errorAndLog'];

/**
 * Structure's validation rules (W16 §15): the collection's validator, level
 * and action, edited in place through `collection:modify`. A read-only
 * connection is refused by main and the refusal shows inline, the same model
 * as the indexes section.
 */
export function ValidationSection({ connectionId, dbName, collection, details, onSaved }: Props) {
  const T = themeVars;
  const { validator } = details.options;
  // listCollections reports only what was set, so an absent value is the server default.
  const level = details.options.validationLevel ?? 'strict';
  const action = details.options.validationAction ?? 'error';
  // A cleared validator reads back as `{}`, which is no rules at all. Shown and
  // edited without canonical wrappers; the readable form re-parses to the same BSON.
  const rules = validator ? ejsonParse<Record<string, unknown>>(validator) : {};
  const pretty = Object.keys(rules).length > 0 ? ejsonStringifyReadable(rules, 2) : '';

  const [editing, setEditing] = React.useState(false);
  const [text, setText] = React.useState('');
  const [draftLevel, setDraftLevel] = React.useState<ValidationLevel>(level);
  const [draftAction, setDraftAction] = React.useState<ValidationAction>(action);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const startEdit = () => {
    setText(pretty);
    setDraftLevel(level);
    setDraftAction(action);
    setError(null);
    setEditing(true);
  };

  const save = async () => {
    if (saving) return;
    const nextRules = text.trim() === '' ? '{}' : text;
    if (!isEjsonDocument(nextRules)) {
      setError('The rules must be a JSON document, like { "$jsonSchema": { … } }.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.collection.modify({
        connectionId,
        dbName,
        collection,
        options: { validator: nextRules, validationLevel: draftLevel, validationAction: draftAction },
      });
      // The value popover's enum suggestions come from these rules.
      invalidateSchemaEnumCache(connectionId, dbName, collection);
      // Leave edit mode only once the new details are in, so the old rules never flash back.
      await onSaved();
      setEditing(false);
    } catch (e) {
      setError(getErrorMessage(e, 'Could not save the rules'));
    } finally {
      setSaving(false);
    }
  };

  const mono: React.CSSProperties = { fontFamily: 'JetBrains Mono, monospace', fontSize: 11.5 };
  const selectStyle: React.CSSProperties = {
    marginLeft: 6,
    padding: '2px 6px',
    fontSize: 12,
    border: `1px solid ${T.border}`,
    borderRadius: T.rs,
    background: T.surfaceRaised,
    color: T.text,
  };

  return (
    <section
      aria-label="Validation"
      style={{ flex: 'none', display: 'flex', flexDirection: 'column', overflow: 'visible' }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 16px',
          borderBottom: `1px solid ${T.border}`,
          background: T.surface,
          fontSize: 12,
        }}
      >
        <div style={{ flex: 1, fontWeight: 600, color: T.text }}>Validation</div>
        {!editing && (
          <Button size="compact-xs" variant="subtle" leftSection={I.edit} onClick={startEdit}>
            Edit rules
          </Button>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 16px', fontSize: 12 }}>
        {editing ? (
          <>
            <textarea
              aria-label="Validator"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={10}
              placeholder='{ "$jsonSchema": { "required": ["name"] } }'
              style={{
                ...mono,
                width: '100%',
                boxSizing: 'border-box',
                padding: 8,
                resize: 'vertical',
                border: `1px solid ${T.border}`,
                borderRadius: T.rs,
                background: T.surfaceRaised,
                color: T.text,
              }}
            />
            <div style={{ display: 'flex', gap: 16, alignItems: 'center', color: T.textMuted }}>
              <label>
                Validation level
                <select
                  value={draftLevel}
                  onChange={(e) => setDraftLevel(e.target.value as ValidationLevel)}
                  style={selectStyle}
                >
                  {LEVELS.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Validation action
                <select
                  value={draftAction}
                  onChange={(e) => setDraftAction(e.target.value as ValidationAction)}
                  style={selectStyle}
                >
                  {ACTIONS.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </label>
              <div style={{ flex: 1 }} />
              <Button size="compact-xs" variant="subtle" onClick={() => setEditing(false)} disabled={saving}>
                Cancel
              </Button>
              <SubmitButton size="compact-xs" variant="filled" onClick={() => void save()} submitting={saving}>
                Save
              </SubmitButton>
            </div>
          </>
        ) : (
          <>
            {pretty ? (
              <pre style={{ ...mono, margin: 0, color: T.text, whiteSpace: 'pre-wrap' }}>{pretty}</pre>
            ) : (
              <div style={{ color: T.textMuted }}>No validation rules</div>
            )}
            <div style={{ display: 'flex', gap: 16, color: T.textMuted }}>
              <span>Level: {level}</span>
              <span>Action: {action}</span>
            </div>
          </>
        )}
        {error && (
          <div role="alert" style={{ color: T.red }}>
            {error}
          </div>
        )}
      </div>
    </section>
  );
}
