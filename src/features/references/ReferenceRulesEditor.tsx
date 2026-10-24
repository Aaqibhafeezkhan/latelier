import React from 'react';
import { themeVars } from '../../theme/themeVars';
import { I } from '../../icons';
import { ActionIcon, Button, Modal, Tooltip } from '@mantine/core';
import { api, getErrorMessage, isIpcError } from '../../api/atelier';
import { confirmDestructive } from '../../utils/confirm';
import { useDialogFocusReturn } from '../../hooks/useDialogFocusReturn';
import { SubmitButton } from '../../components/SubmitButton';
import { FieldAutocompleteInput } from '../fieldSuggestions/FieldAutocompleteInput';
import type { SuggestionContext } from '../fieldSuggestions/types';
import type {
  ReferenceAutodetectCandidate,
  ReferenceRule,
  ReferenceRuleCreateInput,
  ReferenceRuleUpdateInput,
} from '@shared/types';

interface ReferenceRulesEditorProps {
  connectionId: string;
  dbName: string;
  collection: string;
  /** Optional sample docs (e.g., lastRun) handed to the auto-detector. */
  sampleDocs?: unknown[];
  onClose: () => void;
  /** Called after any mutation so the parent can refresh its own cache. */
  onChanged?: () => void;
}

type FormState = {
  id?: string;
  sourceField: string;
  targetDb: string;
  targetCollection: string;
  targetField: string;
  projectionText: string;
  displayTemplate: string;
  enabled: boolean;
};

function emptyForm(dbName: string): FormState {
  return {
    sourceField: '',
    targetDb: dbName,
    targetCollection: '',
    targetField: '_id',
    projectionText: '',
    displayTemplate: '',
    enabled: true,
  };
}

function ruleToForm(r: ReferenceRule): FormState {
  return {
    id: r.id,
    sourceField: r.sourceField,
    targetDb: r.targetDb,
    targetCollection: r.targetCollection,
    targetField: r.targetField,
    projectionText: r.projection.join(', '),
    displayTemplate: r.displayTemplate ?? '',
    enabled: r.enabled,
  };
}

function parseProjection(text: string): string[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function ReferenceRulesEditor({
  connectionId,
  dbName,
  collection,
  sampleDocs,
  onClose,
  onChanged,
}: ReferenceRulesEditorProps) {
  const T = themeVars;
  const [rules, setRules] = React.useState<ReferenceRule[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [form, setForm] = React.useState<FormState | null>(null);
  // X15 §2 — "dirty" is "differs from what the form opened with", never "was
  // touched". The rule form opens *pre-filled* on all three of its entry paths:
  // `emptyForm` already seeds `targetDb`, `targetField: '_id'` and
  // `enabled: true`, Edit copies a whole rule, and a detected candidate fills
  // four fields. So a literal `sourceField !== ''` style check would report
  // dirty the instant the form opens and prompt on every clean Cancel. Snapshot
  // at open instead — every open path goes through `openForm`.
  const [formInitial, setFormInitial] = React.useState<string | null>(null);
  const openForm = (f: FormState) => {
    setForm(f);
    setFormInitial(JSON.stringify(f));
  };
  const closeForm = () => {
    setForm(null);
    setFormInitial(null);
  };
  // Compared whole rather than field by field, so the guard covers every buffer
  // the dialog owns — including the `enabled` checkbox, which defaults to
  // `true` and would make a bare-truthy `form.enabled ||` term read dirty on a
  // clean open and clean once the user unticks it (exactly backwards).
  // `JSON.stringify` is sound here because both sides descend from the same
  // object literal — `RuleForm`'s `onChange` spreads `{ ...form }` — so key
  // order is preserved.
  const isDirty = form !== null && JSON.stringify(form) !== formInitial;
  const [saving, setSaving] = React.useState(false);
  const [candidates, setCandidates] = React.useState<ReferenceAutodetectCandidate[] | null>(null);
  const [detecting, setDetecting] = React.useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = React.useState<string | null>(null);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);

  // Dismiss paths only. This dialog has no success close path — saving a
  // rule clears the form and keeps the editor open — so ✕ and Escape are all
  // there is to wrap.
  const close = useDialogFocusReturn(onClose);

  const requestClose = async () => {
    if (!isDirty) return close();
    const discard = await confirmDestructive({
      title: 'Discard changes?',
      body: 'This closes the editor and loses what you typed.',
      confirmLabel: 'Discard',
    });
    if (discard) close();
  };

  const loadRules = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await api.refs.list({ connectionId, dbName, collection });
      setRules(rows);
    } catch (err) {
      setError(isIpcError(err) ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [connectionId, dbName, collection]);

  React.useEffect(() => {
    queueMicrotask(() => {
      void loadRules();
    });
  }, [loadRules]);

  const refresh = async () => {
    await loadRules();
    onChanged?.();
  };

  const handleSave = async () => {
    if (!form || saving) return;
    if (!form.sourceField || !form.targetCollection) {
      setError('Source field and target collection are required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const projection = parseProjection(form.projectionText);
      if (form.id) {
        const patch: ReferenceRuleUpdateInput = {
          targetDb: form.targetDb,
          targetCollection: form.targetCollection,
          targetField: form.targetField,
          projection,
          displayTemplate: form.displayTemplate,
          enabled: form.enabled,
        };
        await api.refs.update({ id: form.id, patch });
      } else {
        const input: ReferenceRuleCreateInput = {
          connectionId,
          sourceDb: dbName,
          sourceCollection: collection,
          sourceField: form.sourceField,
          targetDb: form.targetDb,
          targetCollection: form.targetCollection,
          targetField: form.targetField,
          projection,
          displayTemplate: form.displayTemplate || undefined,
          enabled: form.enabled,
        };
        await api.refs.create(input);
      }
      closeForm();
      await refresh();
    } catch (err) {
      setError(isIpcError(err) ? err.message : getErrorMessage(err, 'Failed to save'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (deletingId) return;
    setDeletingId(id);
    try {
      await api.refs.delete({ id });
      setConfirmDeleteId(null);
      await refresh();
    } catch (err) {
      setError(isIpcError(err) ? err.message : getErrorMessage(err, 'Failed to delete'));
    } finally {
      setDeletingId(null);
    }
  };

  const handleDetect = async () => {
    if (detecting) return;
    setDetecting(true);
    setError(null);
    try {
      const rows = await api.refs.autodetect({
        connectionId,
        dbName,
        collection,
        sampleDocs,
      });
      setCandidates(rows);
    } catch (err) {
      setError(isIpcError(err) ? err.message : getErrorMessage(err, 'Failed to detect'));
    } finally {
      setDetecting(false);
    }
  };

  // Applying a candidate *opens* the form pre-filled, so it snapshots like any
  // other open path: choosing a candidate and closing straight away is clean.
  const applyCandidate = (c: ReferenceAutodetectCandidate) => {
    openForm({
      sourceField: c.sourceField,
      targetDb: c.targetDb,
      targetCollection: c.targetCollection,
      targetField: c.targetField,
      projectionText: '',
      displayTemplate: '',
      enabled: true,
    });
  };

  return (
    // X15 T8 — `closeOnClickOutside={false}` is load-bearing. Mantine defaults
    // it to `true`, which would reproduce the hand-rolled backdrop's
    // `onClick={onClose}` this migration removed: one stray click discarding a
    // half-filled rule. The backdrop is now inert — it neither closes nor
    // prompts. Escape still closes, but through `requestClose`, so it prompts
    // when there is something to lose.
    //
    // `title` is the bare string rather than a node carrying the
    // `db.collection` subtitle: Mantine wires `aria-labelledby` to the title
    // element, so folding the subtitle in there would make the accessible name
    // "Reference rules shop.orders". The subtitle moved into the body instead.
    <Modal
      opened
      onClose={() => void requestClose()}
      title="Reference rules"
      size={620}
      centered
      closeOnClickOutside={false}
    >
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
        <div style={{ fontSize: 11, color: T.textMuted, marginBottom: 10 }}>
          {dbName}.{collection}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          {error && (
            <div
              role="alert"
              style={{
                color: T.warn,
                fontSize: 12,
                padding: '8px 10px',
                border: `1px solid ${T.warn}`,
                borderRadius: T.rs,
                marginBottom: 12,
              }}
            >
              {error}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <Button
              size="compact-xs"
              variant="filled"
              leftSection={I.plus}
              onClick={() => openForm(emptyForm(dbName))}
            >
              New rule
            </Button>
            <SubmitButton size="compact-xs" variant="subtle" onClick={handleDetect} submitting={detecting}>
              {detecting ? 'Detecting…' : 'Detect from sample'}
            </SubmitButton>
          </div>

          {candidates && candidates.length > 0 && (
            <div
              style={{
                marginBottom: 12,
                padding: '10px 12px',
                border: `1px solid ${T.border}`,
                borderRadius: T.rs,
                background: T.surfaceRaised,
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  color: T.textMuted,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  marginBottom: 8,
                }}
              >
                Detected candidates
              </div>
              {candidates.map((c) => (
                <div
                  key={c.sourceField}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '4px 0',
                    fontSize: 12,
                  }}
                >
                  <span style={{ fontFamily: 'monospace', color: T.text }}>
                    {c.sourceField}
                  </span>
                  <span style={{ color: T.textGhost }}>→</span>
                  <span style={{ fontFamily: 'monospace', color: T.text }}>
                    {c.targetCollection}.{c.targetField}
                  </span>
                  <span style={{ flex: 1 }} />
                  {c.alreadyConfigured ? (
                    <span style={{ color: T.textMuted, fontSize: 11 }}>
                      already configured
                    </span>
                  ) : (
                    <Button size="compact-xs" variant="subtle" onClick={() => applyCandidate(c)}>
                      Use
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
          {candidates && candidates.length === 0 && (
            <div style={{ marginBottom: 12, color: T.textMuted, fontSize: 12 }}>
              No *_id / *Id fields with matching collections found.
            </div>
          )}

          {loading ? (
            <div style={{ color: T.textMuted, fontSize: 12 }}>Loading…</div>
          ) : rules.length === 0 ? (
            <div
              style={{
                color: T.textMuted,
                fontSize: 12,
                fontStyle: 'italic',
                padding: '12px 0',
              }}
            >
              No rules yet. Click "New rule" or "Detect from sample" to add one.
            </div>
          ) : (
            <div style={{ border: `1px solid ${T.border}`, borderRadius: T.rs }}>
              {rules.map((r) => (
                <div
                  key={r.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 12px',
                    borderBottom: `1px solid ${T.border}`,
                    fontSize: 12,
                  }}
                >
                  <span style={{ fontFamily: 'monospace', color: T.text, minWidth: 120 }}>
                    {r.sourceField}
                  </span>
                  <span style={{ color: T.textGhost }}>→</span>
                  <span style={{ fontFamily: 'monospace', color: T.text, flex: 1 }}>
                    {r.targetCollection}.{r.targetField}
                  </span>
                  {!r.enabled && (
                    <span style={{ fontSize: 10, color: T.textGhost }}>disabled</span>
                  )}
                  {confirmDeleteId === r.id ? (
                    <>
                      <span style={{ fontSize: 11, color: T.red }}>Delete?</span>
                      <SubmitButton
                        onClick={() => void handleDelete(r.id)}
                        aria-label="Confirm delete"
                        submitting={deletingId === r.id}
                        color="red"
                        size="compact-xs"
                      >
                        {deletingId === r.id ? 'Deleting…' : 'Delete'}
                      </SubmitButton>
                      <Button
                        onClick={() => setConfirmDeleteId(null)}
                        aria-label="Cancel delete"
                        disabled={deletingId === r.id}
                        variant="default"
                        size="compact-xs"
                      >
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <>
                      <Tooltip label="Edit rule" withArrow openDelay={400}>
                        <ActionIcon
                          onClick={() => openForm(ruleToForm(r))}
                          aria-label="Edit rule"
                          variant="default"
                          c={T.textMuted}
                          size="sm"
                        >
                          {I.edit}
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label="Delete rule" withArrow openDelay={400}>
                        <ActionIcon
                          onClick={() => setConfirmDeleteId(r.id)}
                          aria-label="Delete rule"
                          variant="default"
                          c={T.red}
                          size="sm"
                        >
                          {I.trash}
                        </ActionIcon>
                      </Tooltip>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}

          {form && (
            <RuleForm
              form={form}
              onChange={setForm}
              onSave={handleSave}
              onCancel={closeForm}
              saving={saving}
              connectionId={connectionId}
              sourceDb={dbName}
              sourceCollection={collection}
            />
          )}
        </div>
      </div>
    </Modal>
  );
}

interface RuleFormProps {
  form: FormState;
  onChange: (f: FormState) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  connectionId: string;
  sourceDb: string;
  sourceCollection: string;
}

function RuleForm({
  form,
  onChange,
  onSave,
  onCancel,
  saving,
  connectionId,
  sourceDb,
  sourceCollection,
}: RuleFormProps) {
  const T = themeVars;
  const labelStyle: React.CSSProperties = {
    fontSize: 11,
    color: T.textMuted,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  };
  const inputStyle: React.CSSProperties = {
    padding: '6px 10px',
    border: `1px solid ${T.border}`,
    borderRadius: T.rs,
    background: T.surfaceRaised,
    color: T.text,
    fontSize: 12,
    fontFamily: 'monospace',
  };
  const editing = !!form.id;

  // Source-collection context: drives autocomplete on the "Source field" input.
  const sourceCtx = React.useMemo<SuggestionContext>(
    () => ({ connectionId, dbName: sourceDb, collection: sourceCollection }),
    [connectionId, sourceDb, sourceCollection],
  );
  // Target-collection context: drives autocomplete on Target field, Projection,
  // and Display template. Only meaningful once the user has filled in both
  // target db + target collection.
  const targetCtx = React.useMemo<SuggestionContext | null>(
    () =>
      form.targetDb && form.targetCollection
        ? {
            connectionId,
            dbName: form.targetDb,
            collection: form.targetCollection,
          }
        : null,
    [connectionId, form.targetDb, form.targetCollection],
  );

  return (
    <div
      style={{
        marginTop: 14,
        padding: '14px 16px',
        background: T.surfaceRaised,
        border: `1px solid ${T.border}`,
        borderRadius: T.rs,
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 600, color: T.text, marginBottom: 10 }}>
        {editing ? 'Edit rule' : 'New rule'}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <label style={labelStyle}>
          Source field
          <FieldAutocompleteInput
            value={form.sourceField}
            onChange={(v) => onChange({ ...form, sourceField: v })}
            context={sourceCtx}
            disabled={editing}
            placeholder="contact_id"
            ariaLabel="Source field"
            style={{ ...inputStyle, opacity: editing ? 0.6 : 1 }}
          />
        </label>
        <label style={labelStyle}>
          Target collection
          <input
            value={form.targetCollection}
            onChange={(e) => onChange({ ...form, targetCollection: e.target.value })}
            placeholder="contacts"
            style={inputStyle}
          />
        </label>
        <label style={labelStyle}>
          Target database
          <input
            value={form.targetDb}
            onChange={(e) => onChange({ ...form, targetDb: e.target.value })}
            style={inputStyle}
          />
        </label>
        <label style={labelStyle}>
          Target field
          <FieldAutocompleteInput
            value={form.targetField}
            onChange={(v) => onChange({ ...form, targetField: v })}
            context={targetCtx}
            placeholder="_id"
            ariaLabel="Target field"
            style={inputStyle}
          />
        </label>
      </div>
      <label style={{ ...labelStyle, marginTop: 10 }}>
        Projection (comma-separated, empty = full doc)
        <FieldAutocompleteInput
          value={form.projectionText}
          onChange={(v) => onChange({ ...form, projectionText: v })}
          context={targetCtx}
          mode="csv"
          placeholder="name, email, phone"
          ariaLabel="Projection fields"
          style={inputStyle}
        />
      </label>
      <label style={{ ...labelStyle, marginTop: 10 }}>
        Display template (e.g. {'{name} ({email})'})
        <FieldAutocompleteInput
          value={form.displayTemplate}
          onChange={(v) => onChange({ ...form, displayTemplate: v })}
          context={targetCtx}
          mode="brace"
          placeholder="{name}"
          ariaLabel="Display template"
          style={inputStyle}
        />
      </label>
      <label
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          marginTop: 12,
          fontSize: 12,
          color: T.textMuted,
        }}
      >
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(e) => onChange({ ...form, enabled: e.target.checked })}
        />
        Enabled
      </label>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <Button size="compact-xs" variant="subtle" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <SubmitButton size="compact-xs" variant="filled" onClick={onSave} submitting={saving}>
          {saving ? 'Saving…' : editing ? 'Save' : 'Create'}
        </SubmitButton>
      </div>
    </div>
  );
}
