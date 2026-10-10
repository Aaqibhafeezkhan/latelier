import React from 'react';
import { themeVars } from '../../theme/themeVars';
import { tlsWarning } from '../../utils/hostLocality';
import { isMacRenderer } from '../../utils/platform';
import { I } from '../../icons';
import { Button, Modal, Tabs } from '@mantine/core';
import { useForm } from '@mantine/form';
import { api, isIpcError } from '../../api/atelier';
import { useDialogFocusReturn } from '../../hooks/useDialogFocusReturn';
import { SubmitButton } from '../../components/SubmitButton';
import { notify } from '../../theme/notifications';
import type {
  ConnectionInput,
  ConnectionUpdate,
  ProbeErrorCode,
  ProbeResult,
} from '@shared/types';
import type { IpcError, PickFilePurpose } from '@shared/ipc';
import { REPICK_LABEL } from './transferCopy';
import { useTroubleshooting } from '../../troubleshooting/TroubleshootingContext';
import {
  TLS_INLINE_EXPLAINER,
  DIRECT_CONNECTION_INLINE_EXPLAINER,
} from '../../troubleshooting/recipes';


type TestState = 'idle' | 'testing' | 'ok' | 'fail';

type FormState = {
  name: string;
  color: string;
  type: 'srv' | 'standard';
  host: string;
  port: string;
  defaultDb: string;

  authMech: 'default' | 'scram256' | 'scram1' | 'x509' | 'awsiam' | 'none';
  authUsername: string;
  authDatabase: string;
  password: string;
  hasPasswordStored: boolean;
  clearPassword: boolean;

  tlsEnabled: boolean;
  tlsVerify: boolean;
  tlsCaPath: string;
  tlsClientCertPath: string;

  sshEnabled: boolean;
  sshHost: string;
  sshPort: string;
  sshUsername: string;
  sshAuthMethod: 'key' | 'password';
  sshPrivateKeyPath: string;

  connectTimeoutMs: string;
  socketTimeoutMs: string;
  serverSelectionTimeoutMs: string;
  readPreference: 'primary' | 'primaryPreferred' | 'secondary' | 'secondaryPreferred' | 'nearest';
  maxPoolSize: string;
  directConnection: boolean;
  appName: string;

  readOnly: boolean;
};

const COLORS = ['#7c6af7', '#1A5068', '#6B3A8A', '#B84C14', '#7A6820', '#4A4A4A'];
const TABS_NC = ['General', 'Auth', 'TLS', 'SSH', 'Advanced'] as const;
type NCTab = typeof TABS_NC[number];

const INITIAL: FormState = {
  name: '', color: '#7c6af7', type: 'srv',
  host: '', port: '27017', defaultDb: '',
  authMech: 'default', authUsername: '', authDatabase: 'admin',
  password: '', hasPasswordStored: false, clearPassword: false,
  tlsEnabled: true, tlsVerify: true, tlsCaPath: '', tlsClientCertPath: '',
  sshEnabled: false, sshHost: '', sshPort: '22', sshUsername: '',
  sshAuthMethod: 'key', sshPrivateKeyPath: '',
  connectTimeoutMs: '10000', socketTimeoutMs: '30000', serverSelectionTimeoutMs: '30000',
  readPreference: 'primary', maxPoolSize: '100', directConnection: false, appName: '',
  readOnly: false,
};

function toInput(f: FormState): ConnectionInput {
  return {
    name: f.name,
    color: f.color,
    connectionType: f.type,
    host: f.host,
    port: Number(f.port) || 27017,
    defaultDb: f.defaultDb || undefined,
    authMech: f.authMech,
    authUsername: f.authMech === 'none' ? undefined : f.authUsername || undefined,
    authDatabase: f.authMech === 'none' ? undefined : f.authDatabase || undefined,
    password: f.authMech === 'none' ? undefined : f.password || undefined,
    tls: {
      enabled: f.tlsEnabled,
      verify: f.tlsVerify,
      caPath: f.tlsCaPath || undefined,
      clientCertPath: f.tlsClientCertPath || undefined,
    },
    ssh: f.sshEnabled
      ? {
          enabled: true,
          host: f.sshHost || undefined,
          port: Number(f.sshPort) || 22,
          username: f.sshUsername || undefined,
          authMethod: f.sshAuthMethod,
          privateKeyPath: f.sshPrivateKeyPath || undefined,
        }
      : { enabled: false },
    advanced: {
      connectTimeoutMs: Number(f.connectTimeoutMs) || 10_000,
      socketTimeoutMs: Number(f.socketTimeoutMs) || 30_000,
      serverSelectionTimeoutMs: Number(f.serverSelectionTimeoutMs) || 30_000,
      readPreference: f.readPreference,
      maxPoolSize: Number(f.maxPoolSize) || 100,
      directConnection: f.directConnection,
      appName: f.appName || undefined,
    },
    readOnly: f.readOnly,
  };
}

function toUpdate(f: FormState): ConnectionUpdate {
  const base = toInput(f) as ConnectionUpdate;
  // In edit mode, password handling uses explicit presence signals.
  if (f.clearPassword) {
    base.clearPassword = true;
    delete (base as ConnectionInput).password;
  } else if (!f.password) {
    // User didn't type a new password and isn't clearing — don't send the field.
    delete (base as ConnectionInput).password;
  }
  return base;
}


// What a `Field` hands its control so the visible label names it and the error
// text describes it. Null outside a `Field`: the control then renders no id and
// no aria wiring, exactly as before. Not exported — react-refresh only lets a
// component file export components.
const FieldControlContext = React.createContext<{ id: string; errorId: string; invalid: boolean; required: boolean } | null>(null);

function useFieldControlProps() {
  const ctx = React.useContext(FieldControlContext);
  if (!ctx) return {};
  return {
    id: ctx.id,
    'aria-invalid': ctx.invalid || undefined,
    'aria-required': ctx.required || undefined,
    'aria-describedby': ctx.invalid ? ctx.errorId : undefined,
  };
}

function Label({ children, required, htmlFor, id }: {
  children: React.ReactNode; required?: boolean; htmlFor?: string; id?: string;
}) {
  const T = themeVars;
  const style: React.CSSProperties = {
    fontSize: 11, fontWeight: 600, color: T.textMuted, marginBottom: 5, display: 'flex', gap: 3,
  };
  const content = (
    <>
      {children}
      {required && <span aria-hidden="true" style={{ color: T.warn }}>*</span>}
    </>
  );
  // A label with no labelable control to point at (the colour swatches are a
  // group of buttons) stays a plain element; `Field group` names it instead.
  return htmlFor
    ? <label htmlFor={htmlFor} style={style}>{content}</label>
    : <div id={id} style={style}>{content}</div>;
}

function Field({ label, required, error, group, children }: {
  label?: string; required?: boolean; error?: string; group?: boolean; children: React.ReactNode;
}) {
  const T = themeVars;
  const id = React.useId();
  const errorId = `${id}-error`;
  const labelId = `${id}-label`;
  return (
    <FieldControlContext.Provider value={{ id, errorId, invalid: Boolean(error), required: Boolean(required) }}>
      <div
        style={{ display: 'flex', flexDirection: 'column' }}
        role={group && label ? 'group' : undefined}
        aria-labelledby={group && label ? labelId : undefined}
      >
        {label && (
          <Label required={required} htmlFor={group ? undefined : id} id={labelId}>{label}</Label>
        )}
        {children}
        {error && (
          <div id={errorId} style={{ marginTop: 4, fontSize: 11, color: T.warn }}>{error}</div>
        )}
      </div>
    </FieldControlContext.Provider>
  );
}

function Input({ value, onChange, placeholder, type = 'text', style: sx, readOnly }: {
  value: string; onChange: (v: string) => void; placeholder?: string;
  type?: string; style?: React.CSSProperties; readOnly?: boolean;
}) {
  const T = themeVars;
  const fieldProps = useFieldControlProps();
  return (
    <input
      {...fieldProps}
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      readOnly={readOnly}
      style={{
        width: '100%', boxSizing: 'border-box',
        padding: '6px 10px', border: `1px solid ${T.border}`,
        borderRadius: T.rs, background: T.surfaceRaised,
        color: T.text, fontSize: 12, fontFamily: 'inherit', outline: 'none',
        ...sx,
      }}
    />
  );
}

function Select({ value, onChange, children }: {
  value: string; onChange: (v: string) => void; children: React.ReactNode;
}) {
  const T = themeVars;
  const fieldProps = useFieldControlProps();
  return (
    <select
      {...fieldProps}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        width: '100%', padding: '6px 10px', border: `1px solid ${T.border}`,
        borderRadius: T.rs, background: T.surfaceRaised,
        color: T.text, fontSize: 12, fontFamily: 'inherit', outline: 'none',
        cursor: 'pointer',
      }}
    >
      {children}
    </select>
  );
}

function Toggle({ checked, onChange, label, disabled }: {
  checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean;
}) {
  const T = themeVars;
  // A real `button`, not a `div` with an `onClick`. That one choice carries
  // focus, Tab order, Space/Enter activation, and the `disabled` semantics
  // for free — the previous `div` had none of them, so the read-only switch
  // could not be set without a mouse. `role="switch"` + `aria-checked` is
  // what announces the state; without it a screen reader reads the label and
  // nothing else. The text lives inside the button, so clicking it toggles:
  // the old `label` wrapped no form control and had no `htmlFor`, so a click
  // on the words did nothing at all while `cursor: pointer` promised it would.
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="focus-ring"
      style={{
        display: 'flex', alignItems: 'center', gap: 9,
        cursor: disabled ? 'not-allowed' : 'pointer', userSelect: 'none',
        opacity: disabled ? 0.5 : 1,
        // Strip the UA button chrome; every visual below is unchanged.
        background: 'none', border: 'none', padding: 0, margin: 0,
        font: 'inherit', textAlign: 'left',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 32, height: 18, borderRadius: 9,
          background: checked ? T.accent : T.border,
          position: 'relative', flexShrink: 0, transition: 'background 0.15s',
          display: 'block',
        }}
      >
        <span style={{
          position: 'absolute', top: 2, left: checked ? 16 : 2,
          width: 14, height: 14, borderRadius: '50%',
          background: checked ? T.accentText : T.surface,
          transition: 'left 0.15s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
          display: 'block',
        }} />
      </span>
      <span style={{ fontSize: 12, color: T.text }}>{label}</span>
    </button>
  );
}

function SectionDivider({ children }: { children: React.ReactNode }) {
  const T = themeVars;
  return (
    <div style={{
      fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
      letterSpacing: '0.08em', color: T.textMuted,
      padding: '0 0 8px', marginBottom: 2,
      borderBottom: `1px solid ${T.border}`,
    }}>
      {children}
    </div>
  );
}

function PasswordInput({ value, onChange, placeholder, autoFocus }: {
  value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean;
}) {
  const T = themeVars;
  const [showPwd, setShowPwd] = React.useState(false);
  const fieldProps = useFieldControlProps();
  return (
    <div style={{ position: 'relative' }}>
      <input
        {...fieldProps}
        // `data-autofocus` is what Mantine's Modal focus trap looks for; plain autoFocus alone loses to it.
        data-autofocus={autoFocus ? true : undefined}
        autoFocus={autoFocus}
        type={showPwd ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? '••••••••'}
        style={{
          width: '100%', boxSizing: 'border-box',
          padding: '6px 34px 6px 10px', border: `1px solid ${T.border}`,
          borderRadius: T.rs, background: T.surfaceRaised,
          color: T.text, fontSize: 12, fontFamily: 'inherit', outline: 'none',
        }}
      />
      <button
        type="button"
        aria-label={showPwd ? 'Hide password' : 'Show password'}
        aria-pressed={showPwd}
        onClick={() => setShowPwd((s) => !s)}
        style={{
          position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
          background: 'none', border: 'none', cursor: 'pointer',
          color: T.textMuted, display: 'flex', padding: 0,
        }}
      >
        {showPwd ? I.eyeOff : I.eye}
      </button>
    </div>
  );
}

// The path is read-only: main accepts a credential path only if its own file
// dialog returned it (or it is already stored), so a typed path would be
// rejected on save. Browse sets it, Clear empties it.
function FilePathRow({ purpose, label, value, onChange, placeholder }: {
  purpose: PickFilePurpose;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const T = themeVars;
  const pick = async () => {
    try {
      const r = await api.app.pickFile(purpose);
      if (r.path) onChange(r.path);
    } catch (err) {
      // If the picker fails we silently keep the current value.
      console.warn('pickFile failed', err);
    }
  };
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      <Input value={value} onChange={onChange} placeholder={placeholder} readOnly />
      <button
        type="button"
        onClick={() => void pick()}
        title="Browse"
        aria-label={`Browse for ${label}`}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '6px 10px', border: `1px solid ${T.border}`, borderRadius: T.rs,
          background: T.surfaceRaised, color: T.textMuted, cursor: 'pointer',
          fontSize: 11,
        }}
      >
        ⋯
      </button>
      {value !== '' && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label={`Clear ${label}`}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '6px 10px', border: `1px solid ${T.border}`, borderRadius: T.rs,
            background: T.surfaceRaised, color: T.textMuted, cursor: 'pointer',
            fontSize: 11,
          }}
        >
          Clear
        </button>
      )}
    </div>
  );
}


function GeneralTab({
  form, set, fieldErrors, onPasteUri,
}: {
  form: FormState;
  set: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
  fieldErrors: Record<string, string>;
  onPasteUri: (uri: string) => void;
}) {
  const T = themeVars;
  const [showUri, setShowUri] = React.useState(false);
  const [uriDraft, setUriDraft] = React.useState('');

  const submitUri = () => {
    if (!uriDraft.trim()) return;
    onPasteUri(uriDraft);
    setUriDraft('');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div>
        <SectionDivider>Identity</SectionDivider>
        <div style={{ display: 'grid', gap: 12, marginTop: 10 }}>
          <Field label="Name" required error={fieldErrors['name']}>
            <Input value={form.name} onChange={(v) => set('name', v)} placeholder="My MongoDB Server" />
          </Field>
          <Field label="Color" group>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  // COLORS is bare hex, so this is the honest accessible
                  // name available — not pretty, but truthful.
                  aria-label={`Color ${c}`}
                  aria-pressed={form.color === c}
                  onClick={() => set('color', c)}
                  style={{
                    padding: 0, margin: 0, font: 'inherit', textAlign: 'left',
                    width: 22, height: 22, borderRadius: '50%',
                    cursor: 'pointer',
                    border: form.color === c ? `2px solid ${T.text}` : `2px solid transparent`,
                    boxSizing: 'border-box',
                    background: c,
                  }}
                />
              ))}
            </div>
          </Field>
        </div>
      </div>

      <div>
        <SectionDivider>Host</SectionDivider>
        <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '8px 0 10px' }}>
          <button
            onClick={() => setShowUri((v) => !v)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              fontSize: 11, color: T.accent, fontFamily: 'inherit', padding: 0,
              fontWeight: 600,
            }}
          >
            {showUri ? 'Use fields' : 'Paste URI'} {showUri ? I.chevD : I.chevR}
          </button>
        </div>

        {showUri ? (
          <Field label="Connection URI">
            <div style={{ display: 'flex', gap: 6 }}>
              <Input
                value={uriDraft}
                onChange={setUriDraft}
                placeholder="mongodb+srv://user:pass@cluster.mongodb.net/db"
              />
              <Button size="compact-xs" variant="default" onClick={submitUri}>Apply</Button>
            </div>
          </Field>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: form.type === 'srv' ? '1fr' : '2fr 1fr',
                gap: 10,
              }}
            >
              <Field label="Hostname" required error={fieldErrors['host']}>
                <Input value={form.host} onChange={(v) => set('host', v)} placeholder="cluster.mongodb.net" />
              </Field>
              {form.type !== 'srv' && (
                <Field label="Port" error={fieldErrors['port']}>
                  <Input
                    value={form.port}
                    onChange={(v) => set('port', v)}
                    placeholder="27017"
                  />
                </Field>
              )}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <Field label="Default database">
                <Input
                  value={form.defaultDb}
                  onChange={(v) => set('defaultDb', v)}
                  placeholder="mydb"
                />
              </Field>
              <Field label="Connection type">
                <Select
                  value={form.type}
                  onChange={(v) => {
                    const next = v as FormState['type'];
                    set('type', next);
                    if (next === 'srv') {
                      // SRV uses DNS-discovered ports and always implies TLS.
                      set('port', '');
                      set('tlsEnabled', true);
                    } else {
                      if (form.port === '') set('port', '27017');
                      // Only auto-disable TLS if the user hasn't configured certs.
                      if (!form.tlsCaPath && !form.tlsClientCertPath) {
                        set('tlsEnabled', false);
                      }
                    }
                  }}
                >
                  <option value="srv">SRV (mongodb+srv://)</option>
                  <option value="standard">Standard (mongodb://)</option>
                </Select>
              </Field>
            </div>
          </div>
        )}
      </div>

      <div>
        <SectionDivider>Safety</SectionDivider>
        <div style={{ marginTop: 10 }}>
          <Toggle
            checked={form.readOnly}
            onChange={(v) => set('readOnly', v)}
            label="Read-only connection"
          />
          <div style={{ fontSize: 11, color: T.textMuted, marginTop: 4 }}>
            Blocks every write through this connection — document edits, drops,
            and shell/script writes — enforced outside the UI, not just hidden.
          </div>
        </div>
      </div>
    </div>
  );
}

function AuthTab({ form, set, fieldErrors, isEdit, focusPassword }: {
  form: FormState;
  set: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
  fieldErrors: Record<string, string>;
  isEdit: boolean;
  focusPassword?: boolean;
}) {
  const T = themeVars;
  const pwField = (
    <Field
      label="Password"
      required={!form.hasPasswordStored && !form.clearPassword}
      error={fieldErrors['password']}
    >
      <PasswordInput
        autoFocus={focusPassword}
        value={form.password}
        onChange={(v) => set('password', v)}
        placeholder={
          form.hasPasswordStored && !form.clearPassword
            ? '••••• (stored — enter new to replace)'
            : '••••••••'
        }
      />
      {isEdit && form.hasPasswordStored && !form.clearPassword && (
        <div style={{ marginTop: 6 }}>
          <button
            type="button"
            onClick={() => set('clearPassword', true)}
            style={{
              background: 'none', border: 'none', padding: 0, cursor: 'pointer',
              color: T.warn, fontSize: 11, fontFamily: 'inherit',
            }}
          >
            Remove stored password
          </button>
        </div>
      )}
      {form.clearPassword && (
        <div style={{ marginTop: 6, fontSize: 11, color: T.warn }}>
          Will be removed on save.{' '}
          <button
            type="button"
            onClick={() => set('clearPassword', false)}
            style={{ background: 'none', border: 'none', color: T.accent, cursor: 'pointer', fontSize: 11 }}
          >
            Undo
          </button>
        </div>
      )}
    </Field>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Field label="Authentication mechanism">
        <Select value={form.authMech} onChange={(v) => set('authMech', v as FormState['authMech'])}>
          <option value="default">Default (negotiate)</option>
          <option value="scram256">SCRAM-SHA-256</option>
          <option value="scram1">SCRAM-SHA-1</option>
          <option value="x509">X.509</option>
          <option value="awsiam">AWS IAM</option>
          <option value="none">None</option>
        </Select>
      </Field>
      {(form.authMech === 'default' ||
        form.authMech === 'scram256' ||
        form.authMech === 'scram1') && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Field label="Username" required error={fieldErrors['authUsername']}>
              <Input value={form.authUsername} onChange={(v) => set('authUsername', v)} placeholder="admin" />
            </Field>
            <Field label="Auth database">
              <Input value={form.authDatabase} onChange={(v) => set('authDatabase', v)} placeholder="admin" />
            </Field>
          </div>
          {pwField}
        </>
      )}
      {form.authMech === 'awsiam' && (
        <>
          <Field label="AWS Access Key ID" required error={fieldErrors['authUsername']}>
            <Input value={form.authUsername} onChange={(v) => set('authUsername', v)} placeholder="AKIA..." />
          </Field>
          {pwField}
        </>
      )}
      {form.authMech === 'x509' && (
        <div style={{ fontSize: 12, color: T.textMuted, lineHeight: 1.5 }}>
          X.509 authentication uses the client certificate from the <strong>TLS</strong> tab.
          Make sure TLS is enabled and the certificate path is set.
        </div>
      )}
      {form.authMech === 'none' && (
        <div style={{ fontSize: 12, color: T.textMuted }}>
          No authentication — credentials will be ignored.
        </div>
      )}
    </div>
  );
}

function TLSTab({ form, set, fieldErrors }: {
  form: FormState;
  set: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
  fieldErrors: Record<string, string>;
}) {
  const T = themeVars;
  const warning = tlsWarning({
    enabled: form.tlsEnabled,
    verify: form.tlsVerify,
    host: form.host,
    viaSshTunnel: form.sshEnabled,
  });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Toggle checked={form.tlsEnabled} onChange={(v) => set('tlsEnabled', v)} label="Enable TLS / SSL" />
      <div style={{ fontSize: 11, color: T.textMuted, lineHeight: 1.5 }}>
        {TLS_INLINE_EXPLAINER}
      </div>
      {warning && (
        <div
          role="status"
          data-testid="tls-warning"
          style={{
            padding: '8px 10px', background: T.redSoft, color: T.redText,
            border: `1px solid ${T.redBorder}`, borderRadius: T.rs,
            fontSize: 12, lineHeight: 1.5,
          }}
        >
          <strong>Warning:</strong> {warning}
        </div>
      )}
      {form.tlsEnabled && (
        <>
          <div style={{ height: 1, background: T.border }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Field label="CA Certificate" error={fieldErrors['tls.caPath']}>
              <FilePathRow
                purpose="tls-ca"
                label="CA Certificate"
                value={form.tlsCaPath}
                onChange={(v) => set('tlsCaPath', v)}
                placeholder="/path/to/ca.pem"
              />
            </Field>
            <Field label="Client Certificate" error={fieldErrors['tls.clientCertPath']}>
              <FilePathRow
                purpose="tls-client-cert"
                label="Client Certificate"
                value={form.tlsClientCertPath}
                onChange={(v) => set('tlsClientCertPath', v)}
                placeholder="/path/to/client.pem"
              />
            </Field>
            <Toggle
              checked={form.tlsVerify}
              onChange={(v) => set('tlsVerify', v)}
              label="Verify server certificate"
            />
          </div>
        </>
      )}
    </div>
  );
}

function SSHTab({ form, set }: {
  form: FormState;
  set: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
}) {
  const T = themeVars;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Toggle
        checked={form.sshEnabled}
        onChange={(v) => set('sshEnabled', v)}
        label="SSH tunnel (coming soon)"
        disabled
      />
      <div style={{ fontSize: 11, color: T.textMuted }}>
        SSH tunneling is not supported in this iteration. Fields below are retained for future use.
      </div>
      {form.sshEnabled && (
        <>
          <div style={{ height: 1, background: T.border }} />
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
            <Field label="SSH Host">
              <Input value={form.sshHost} onChange={(v) => set('sshHost', v)} placeholder="bastion.example.com" />
            </Field>
            <Field label="SSH Port">
              <Input value={form.sshPort} onChange={(v) => set('sshPort', v)} placeholder="22" />
            </Field>
          </div>
        </>
      )}
    </div>
  );
}

function AdvancedTab({ form, set, fieldErrors }: {
  form: FormState;
  set: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
  fieldErrors: Record<string, string>;
}) {
  const T = themeVars;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div>
        <SectionDivider>Timeouts (ms)</SectionDivider>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginTop: 10 }}>
          <Field label="Connect timeout" error={fieldErrors['advanced.connectTimeoutMs']}>
            <Input value={form.connectTimeoutMs} onChange={(v) => set('connectTimeoutMs', v)} placeholder="10000" />
          </Field>
          <Field label="Socket timeout" error={fieldErrors['advanced.socketTimeoutMs']}>
            <Input value={form.socketTimeoutMs} onChange={(v) => set('socketTimeoutMs', v)} placeholder="30000" />
          </Field>
          <Field label="Server selection" error={fieldErrors['advanced.serverSelectionTimeoutMs']}>
            <Input
              value={form.serverSelectionTimeoutMs}
              onChange={(v) => set('serverSelectionTimeoutMs', v)}
              placeholder="30000"
            />
          </Field>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Field label="Read preference">
          <Select
            value={form.readPreference}
            onChange={(v) => set('readPreference', v as FormState['readPreference'])}
          >
            <option value="primary">Primary</option>
            <option value="primaryPreferred">Primary preferred</option>
            <option value="secondary">Secondary</option>
            <option value="secondaryPreferred">Secondary preferred</option>
            <option value="nearest">Nearest</option>
          </Select>
        </Field>
        <Field label="Max pool size" error={fieldErrors['advanced.maxPoolSize']}>
          <Input value={form.maxPoolSize} onChange={(v) => set('maxPoolSize', v)} placeholder="100" />
        </Field>
      </div>
      <Toggle
        checked={form.directConnection}
        onChange={(v) => set('directConnection', v)}
        label="Direct connection"
      />
      <div style={{ fontSize: 11, color: T.textMuted, lineHeight: 1.5 }}>
        {DIRECT_CONNECTION_INLINE_EXPLAINER}
      </div>
      <Field label="App name">
        <Input value={form.appName} onChange={(v) => set('appName', v)} placeholder="myapp" />
      </Field>
    </div>
  );
}


function TestStatus({ state, errorMsg }: { state: TestState; errorMsg: string | null }) {
  const T = themeVars;
  if (state === 'idle') return null;

  const palette: Record<Exclude<TestState, 'idle'>, {
    color: string; bg: string; border: string; text: string;
  }> = {
    testing: { color: T.textMuted, bg: T.surfaceRaised, border: T.border, text: 'Testing connection…' },
    ok: { color: T.accent, bg: T.accentSoft, border: T.accentBorder, text: 'Connection successful' },
    fail: {
      color: T.warn, bg: 'rgba(184,76,20,0.08)', border: 'rgba(184,76,20,0.25)',
      text: errorMsg ?? 'Connection failed',
    },
  };
  const c = palette[state];
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 7,
      padding: '6px 12px', borderRadius: T.rs,
      background: c.bg, border: `1px solid ${c.border}`,
      color: c.color, fontSize: 11, maxWidth: 480,
    }}>
      {state === 'testing' && (
        <span style={{
          display: 'inline-block', width: 10, height: 10, borderRadius: '50%',
          border: `2px solid ${T.textGhost}`, borderTopColor: T.accent,
          animation: 'spin 0.7s linear infinite',
        }} />
      )}
      {state === 'ok' && <span style={{ display: 'flex' }}>{I.check}</span>}
      {state === 'fail' && <span style={{ display: 'flex', color: T.warn }}>{I.close}</span>}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {c.text}
      </span>
    </div>
  );
}


function probeResultToText(r: ProbeResult): string {
  if (r.ok) return 'Connection successful';
  switch (r.errorCode) {
    case 'AUTH':
      return 'Authentication failed — check username, password, and auth database.';
    case 'NETWORK':
      return 'Could not reach the server. Check host, port, and firewall.';
    case 'TIMEOUT':
      return 'Connection timed out. Check host reachability or raise the timeout.';
    case 'TLS':
      return 'TLS handshake failed. Verify certificates and server TLS support.';
    case 'TLS_HANDSHAKE':
      return "Server doesn't speak TLS on this port. Try toggling TLS off.";
    case 'UNAUTHORIZED':
      return 'The user lacks permission on the target database.';
    default:
      return r.errorMessage ?? 'Connection failed.';
  }
}

function ipcIssuesToFieldErrors(err: IpcError): Record<string, string> {
  const out: Record<string, string> = {};
  const details = err.details as
    | { issues?: Array<{ path: (string | number)[]; message: string }> }
    | undefined;
  if (!details?.issues) return out;
  for (const issue of details.issues) {
    const key = issue.path.map(String).join('.');
    out[key] = issue.message;
  }
  return out;
}

function firstErrorTab(fieldErrors: Record<string, string>): NCTab | null {
  const keys = Object.keys(fieldErrors);
  if (keys.length === 0) return null;
  const k = keys[0]!;
  if (k.startsWith('tls')) return 'TLS';
  if (k.startsWith('ssh')) return 'SSH';
  if (k.startsWith('advanced')) return 'Advanced';
  if (k === 'authMech' || k === 'authUsername' || k === 'authDatabase' || k === 'password') return 'Auth';
  return 'General';
}


// `mode` is a discriminant literal: without one, TypeScript structurally
// merges `{connectionId?: undefined} | {connectionId: string}` instead of
// picking a branch, so a `string | undefined` value would type-check against either.
export type ConnectionFormProps = (
  | { mode: 'create'; connectionId?: undefined }
  | { mode: 'edit'; connectionId: string }
) & {
  onSaved: (id: string) => void;
  onCancel: () => void;
  /** ConnectionFormModal's Escape/backdrop bypass onCancel, so it needs this to know there's unsaved state. */
  onDirtyChange?: (dirty: boolean) => void;
  /** True inside ConnectionFormModal (which draws its own card) to drop this form's own chrome. */
  embedded?: boolean;
  /** Start on the Auth tab with the password field focused (#396). */
  initialFocus?: 'password';
};

// Keyed on connectionId so switching targets unmounts/remounts rather than
// reconciling — the hydrate effect merges values in rather than resetting,
// which would otherwise show the previous connection's values mid-load.
export function ConnectionForm(props: ConnectionFormProps) {
  return <ConnectionFormImpl key={props.connectionId ?? 'new'} {...props} />;
}

function ConnectionFormImpl({
  mode,
  connectionId,
  onSaved,
  onCancel,
  onDirtyChange,
  embedded = false,
  initialFocus,
}: ConnectionFormProps) {
  const T = themeVars;
  // Driven by `mode`, not connectionId's truthiness — an empty string is
  // falsy but still a valid edit-mode id.
  const isEdit = mode === 'edit';
  if (isEdit && !connectionId) {
    throw new Error(`ConnectionForm: mode is "edit" but connectionId is ${JSON.stringify(connectionId)}`);
  }
  const help = useTroubleshooting();

  const [tab, setTab] = React.useState<NCTab>(initialFocus === 'password' ? 'Auth' : 'General');
  const formApi = useForm<FormState>({ mode: 'controlled', initialValues: INITIAL });
  const form = formApi.values;

  // @mantine/form's own dirty tracking; the edit-mode hydrate below calls
  // resetDirty() once loaded, so a freshly-opened Edit reads clean.
  const dirty = formApi.isDirty();
  React.useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  const set = React.useCallback(
    <K extends keyof FormState>(k: K, v: FormState[K]) => {
      // Mantine's setFieldValue overload uses FormPathValue<…> which doesn't
      // align with our generic key/value pair; cast through unknown.
      (formApi.setFieldValue as unknown as (k: string, v: unknown) => void)(
        k as string,
        v as unknown,
      );
    },
    [formApi],
  );
  const fieldErrors = formApi.errors as Record<string, string>;
  const [loading, setLoading] = React.useState<boolean>(isEdit);
  const [saving, setSaving] = React.useState(false);
  // The ⌘S listener closes over a stale `saving`; this ref gives it a live read.
  const savingRef = React.useRef(false);
  const [testState, setTestState] = React.useState<TestState>('idle');
  const [testErrorMsg, setTestErrorMsg] = React.useState<string | null>(null);
  const [testFailure, setTestFailure] = React.useState<{
    errorCode?: ProbeErrorCode;
    message?: string;
  } | null>(null);
  const [toast, setToast] = React.useState<string | null>(null);
  const [plaintextFallback, setPlaintextFallback] = React.useState<boolean>(false);
  const [showPlaintextModal, setShowPlaintextModal] = React.useState<boolean>(false);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const v = await api.prefs.get<boolean>('secrets.allowPlaintextFallback');
        if (!cancelled) setPlaintextFallback(v === true);
      } catch {
        if (!cancelled) setPlaintextFallback(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    if (!isEdit || !connectionId) return;
    let cancelled = false;
    void (async () => {
      try {
        const c = await api.conn.get(connectionId);
        if (cancelled) return;
        formApi.setValues({
          name: c.name,
          color: c.color,
          type: c.connectionType,
          host: c.host,
          port: String(c.port),
          defaultDb: c.defaultDb ?? '',
          authMech: c.authMech,
          authUsername: c.authUsername ?? '',
          authDatabase: c.authDatabase ?? 'admin',
          password: '',
          hasPasswordStored: c.hasPasswordStored,
          clearPassword: false,
          tlsEnabled: c.tls.enabled,
          tlsVerify: c.tls.verify,
          tlsCaPath: c.tls.caPath ?? '',
          tlsClientCertPath: c.tls.clientCertPath ?? '',
          // A legacy row may carry ssh.enabled=true. SSH is unsupported and the schema now
          // rejects it, so load it as off; the next save sends ssh.enabled=false and clears it.
          sshEnabled: false,
          sshHost: c.ssh?.host ?? '',
          sshPort: c.ssh?.port ? String(c.ssh.port) : '22',
          sshUsername: c.ssh?.username ?? '',
          sshAuthMethod: c.ssh?.authMethod ?? 'key',
          sshPrivateKeyPath: c.ssh?.privateKeyPath ?? '',
          connectTimeoutMs: String(c.advanced.connectTimeoutMs),
          socketTimeoutMs: String(c.advanced.socketTimeoutMs),
          serverSelectionTimeoutMs: String(c.advanced.serverSelectionTimeoutMs),
          readPreference: c.advanced.readPreference,
          maxPoolSize: String(c.advanced.maxPoolSize),
          directConnection: c.advanced.directConnection,
          appName: c.advanced.appName ?? '',
          readOnly: c.readOnly,
        });
        formApi.resetDirty();
      } catch (err) {
        notify.error(isIpcError(err) ? err.message : String(err), { title: 'Load failed' });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEdit, connectionId]);

  const handlePasteUri = async (uri: string) => {
    try {
      const { input, warnings, repick } = await api.conn.parseUri(uri);
      formApi.setValues((f) => ({
        ...f,
        type: input.connectionType ?? f.type,
        host: input.host ?? f.host,
        port: input.port ? String(input.port) : f.port,
        defaultDb: input.defaultDb ?? f.defaultDb,
        authMech: input.authMech ?? f.authMech,
        authUsername: input.authUsername ?? f.authUsername,
        authDatabase: input.authDatabase ?? f.authDatabase,
        password: input.password ?? f.password,
        tlsEnabled: input.tls?.enabled ?? f.tlsEnabled,
        tlsVerify: input.tls?.verify ?? f.tlsVerify,
        connectTimeoutMs: input.advanced?.connectTimeoutMs
          ? String(input.advanced.connectTimeoutMs) : f.connectTimeoutMs,
        socketTimeoutMs: input.advanced?.socketTimeoutMs
          ? String(input.advanced.socketTimeoutMs) : f.socketTimeoutMs,
        serverSelectionTimeoutMs: input.advanced?.serverSelectionTimeoutMs
          ? String(input.advanced.serverSelectionTimeoutMs) : f.serverSelectionTimeoutMs,
        readPreference: input.advanced?.readPreference ?? f.readPreference,
        maxPoolSize: input.advanced?.maxPoolSize
          ? String(input.advanced.maxPoolSize) : f.maxPoolSize,
        directConnection: input.advanced?.directConnection ?? f.directConnection,
        appName: input.advanced?.appName ?? f.appName,
      }));
      // The paths are machine-local, so the fields stay empty and the user picks the files again.
      const files = (repick ?? []).map((f) => REPICK_LABEL[f]);
      const repickNote = files.length > 0 ? ` Still to do: ${files.join(', ')}.` : '';
      if (warnings.length > 0) {
        setToast(
          `URI applied. ${warnings.length} warning${warnings.length > 1 ? 's' : ''}: ${
            warnings.map((w) => w.detail ?? w.code).join(', ')
          }${repickNote}`,
        );
      } else {
        setToast(`URI applied.${repickNote}`);
      }
    } catch (err) {
      notify.error(isIpcError(err) ? err.message : 'Could not parse URI', { title: 'URI parse failed' });
    }
  };

  const handleTest = async (formOverride?: FormState): Promise<{ ok: boolean }> => {
    setTestState('testing');
    setTestErrorMsg(null);
    setTestFailure(null);
    const probeForm = formOverride ?? form;
    try {
      const r = await api.conn.test(toInput(probeForm));
      if (r.ok) {
        setTestState('ok');
        setTimeout(() => setTestState('idle'), 6000);
        return { ok: true };
      }
      setTestState('fail');
      setTestErrorMsg(probeResultToText(r));
      setTestFailure({ errorCode: r.errorCode, message: r.errorMessage });
      return { ok: false };
    } catch (err) {
      setTestState('fail');
      const msg = isIpcError(err) ? err.message : String(err);
      setTestErrorMsg(msg);
      setTestFailure({ message: msg });
      return { ok: false };
    }
  };

  const handleSave = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      setSaving(true);
      formApi.clearErrors();
      if (isEdit && connectionId) {
        const updated = await api.conn.update(connectionId, toUpdate(form));
        onSaved(updated.id);
      } else {
        const created = await api.conn.create(toInput(form));
        onSaved(created.id);
      }
    } catch (err) {
      if (isIpcError(err)) {
        if (err.code === 'VALIDATION') {
          const fe = ipcIssuesToFieldErrors(err);
          formApi.setErrors(fe);
          const target = firstErrorTab(fe);
          if (target) setTab(target);
        } else if (err.code === 'CONFLICT') {
          notify.error(err.message, { title: 'Conflict' });
        } else if (err.code === 'SECRETS_UNAVAILABLE') {
          setShowPlaintextModal(true);
        } else {
          notify.error(err.message, { title: 'Save failed' });
        }
      } else {
        notify.error(String(err), { title: 'Save failed' });
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const enablePlaintextFallbackAndRetry = async () => {
    try {
      // Main asks for its own confirmation before enabling; cancelling there
      // comes back disabled, and a save would only hit the same error again.
      const { enabled } = await api.secrets.setPlaintextFallback(true);
      if (!enabled) {
        setShowPlaintextModal(false);
        return;
      }
      setPlaintextFallback(true);
    } catch (err) {
      notify.error(isIpcError(err) ? err.message : String(err), { title: 'Could not enable fallback' });
      setShowPlaintextModal(false);
      return;
    }
    setShowPlaintextModal(false);
    await handleSave();
  };

  const disablePlaintextFallback = async () => {
    try {
      await api.secrets.setPlaintextFallback(false);
      setPlaintextFallback(false);
      setToast('Plaintext password storage disabled. New saves will require an OS keychain.');
    } catch (err) {
      notify.error(isIpcError(err) ? err.message : String(err), { title: 'Could not disable fallback' });
    }
  };

  // Keyboard: ⌘↵ test, ⌘S save. Capture phase + stopPropagation so this always
  // wins over another window-level shortcut listener mounted underneath (e.g. a
  // host page's own ⌘↵ binding) when the form is hosted in a modal.
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        void handleTest();
      } else if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        e.stopPropagation();
        // No `!saving` gate here: this listener closes over a stale `saving`
        // (see savingRef). handleSave's own savingRef guard blocks re-entry.
        void handleSave();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, isEdit, connectionId]);

  // Auto-dismiss toast
  React.useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    <>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {plaintextFallback && (
        <div
          role="status"
          data-testid="plaintext-fallback-banner"
          style={{
            padding: '8px 20px', background: 'rgba(184,76,20,0.08)',
            color: T.warn, borderBottom: `1px solid ${T.border}`, fontSize: 12,
            display: 'flex', alignItems: 'center', gap: 12,
          }}
        >
          <span>
            <strong>Plaintext password storage is enabled.</strong>{' '}
            Connection passwords are stored unencrypted in the local database.
          </span>
          <div style={{ flex: 1 }} />
          <button
            onClick={() => void disablePlaintextFallback()}
            style={{
              background: 'none', border: `1px solid ${T.border}`,
              borderRadius: T.rs, padding: '3px 8px', cursor: 'pointer',
              color: T.text, fontSize: 11, fontFamily: 'inherit',
            }}
          >
            Disable
          </button>
        </div>
      )}

      <div style={{
        flex: 1, overflowY: 'auto',
        display: 'flex', justifyContent: 'center',
        padding: embedded ? 0 : '28px 16px 40px',
      }}>
        <div style={{
          width: '100%', maxWidth: 740,
          ...(embedded
            ? {}
            : { background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.r, boxShadow: T.shadow }),
          display: 'flex', flexDirection: 'column',
        }}>
          {/* X59 — this was five bare <button>s distinguished by an accent
              bottom-border on the active one: no role, no aria-selected,
              no aria-controls, five separate tab stops. Mantine's Tabs is
              the tablist pattern already built (BuilderPane.tsx's drawer
              strip uses it the same way), so this inherits arrow-key
              roving as a single tab stop rather than hand-rolling a fifth
              copy.

              `keepMounted={false}` is load-bearing: Mantine's default keeps
              inactive panels in the DOM, which would mount every tab's
              fields at once instead of the one panel this file's other
              tests (and the "jump to first offending tab" error handling)
              expect to find alone in the document. */}
          <Tabs
            value={tab}
            onChange={(v) => { if (v) setTab(v as NCTab); }}
            keepMounted={false}
            style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}
          >
            <Tabs.List aria-label="Connection settings" style={{ padding: '0 20px' }}>
              {TABS_NC.map((t) => (
                <Tabs.Tab key={t} value={t} styles={{ tab: { fontSize: 12 } }}>
                  {t}
                </Tabs.Tab>
              ))}
            </Tabs.List>

            <div style={{ flex: 1, overflowY: 'auto', padding: '22px 24px' }}>
              {loading ? (
                <div style={{ color: T.textMuted, fontSize: 13, padding: '32px 0' }}>Loading…</div>
              ) : (
                <>
                  <Tabs.Panel value="General">
                    <GeneralTab
                      form={form}
                      set={set}
                      fieldErrors={fieldErrors}
                      onPasteUri={(uri) => void handlePasteUri(uri)}
                    />
                  </Tabs.Panel>
                  <Tabs.Panel value="Auth">
                    <AuthTab
                      form={form}
                      set={set}
                      fieldErrors={fieldErrors}
                      isEdit={isEdit}
                      focusPassword={initialFocus === 'password'}
                    />
                  </Tabs.Panel>
                  <Tabs.Panel value="TLS">
                    <TLSTab form={form} set={set} fieldErrors={fieldErrors} />
                  </Tabs.Panel>
                  <Tabs.Panel value="SSH">
                    <SSHTab form={form} set={set} />
                  </Tabs.Panel>
                  <Tabs.Panel value="Advanced">
                    <AdvancedTab form={form} set={set} fieldErrors={fieldErrors} />
                  </Tabs.Panel>
                </>
              )}
            </div>
          </Tabs>

          {toast && (
            <div role="status" style={{
              padding: '8px 24px', fontSize: 11, color: T.textMuted,
              borderTop: `1px solid ${T.border}`, background: T.surfaceRaised,
            }}>
              {toast}
            </div>
          )}

          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '12px 24px', borderTop: `1px solid ${T.border}`,
            background: T.surfaceRaised,
            ...(embedded ? {} : { borderRadius: `0 0 ${T.r} ${T.r}` }),
          }}>
            <TestStatus state={testState} errorMsg={testErrorMsg} />
            {testState === 'fail' && testFailure && (
              <button
                onClick={() =>
                  help.open(testFailure, {
                    retryWithoutTls: async () => {
                      const next = { ...form, tlsEnabled: false };
                      formApi.setValues(next);
                      const r = await handleTest(next);
                      return r.ok;
                    },
                    retryDirectConnection: async () => {
                      const next = { ...form, directConnection: true };
                      formApi.setValues(next);
                      const r = await handleTest(next);
                      return r.ok;
                    },
                  })
                }
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: T.accent,
                  fontSize: 11,
                  fontFamily: 'inherit',
                  padding: '4px 6px',
                  textDecoration: 'underline',
                }}
              >
                Help me fix this →
              </button>
            )}
            <div style={{ flex: 1 }} />
            <button
              onClick={onCancel}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: T.textMuted, fontSize: 12, fontFamily: 'inherit',
                padding: '6px 4px',
              }}
            >
              Cancel
            </button>
            <Button variant="subtle" size="compact-xs" onClick={() => void handleTest()} leftSection={I.server}>
              {testState === 'testing' ? 'Testing…' : 'Test connection'}
            </Button>
            <SubmitButton
              variant="filled"
              size="compact-xs"
              onClick={() => void handleSave()}
              submitting={saving}
            >
              {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Save'}
            </SubmitButton>
          </div>
        </div>
      </div>
      {showPlaintextModal && (
        <PlaintextFallbackModal
          onCancel={() => setShowPlaintextModal(false)}
          onConfirm={() => void enablePlaintextFallbackAndRetry()}
        />
      )}
    </>
  );
}

function PlaintextFallbackModal({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const T = themeVars;
  // Dismiss path only — `onConfirm` hands off into the parent's retried save and
  // unmounts the trigger along with the form, so it stays raw.
  const close = useDialogFocusReturn(onCancel);
  if (isMacRenderer()) {
    // On macOS the keychain is always present: the user denied access, and only
    // a relaunch makes macOS ask again. Plaintext storage would be the wrong fix.
    return (
      <Modal
        opened
        onClose={close}
        title="Keychain access blocked"
        size={460}
        centered
        styles={{ title: { fontSize: 15, fontWeight: 600, color: T.warn } }}
        attributes={{ content: { 'data-testid': 'keychain-blocked-modal' } }}
      >
        <div style={{ color: T.text }}>
          <p style={{ marginTop: 0, marginBottom: 16, fontSize: 13, lineHeight: 1.5 }}>
            macOS blocked access to the keychain. Quit and reopen L'Atelier, then click
            {' '}"Always Allow" when macOS asks.
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button variant="filled" size="compact-xs" onClick={close}>
              Close
            </Button>
          </div>
        </div>
      </Modal>
    );
  }
  return (
    // No dirty-guard and no closeOnClickOutside={false} here, deliberately:
    // this dialog holds no typed input, so a backdrop click discards nothing.
    <Modal
      opened
      onClose={close}
      title="OS keychain unavailable"
      size={460}
      centered
      styles={{ title: { fontSize: 15, fontWeight: 600, color: T.warn } }}
      attributes={{ content: { 'data-testid': 'plaintext-fallback-modal' } }}
    >
      <div style={{ color: T.text }}>
        <p style={{ marginTop: 0, marginBottom: 8, fontSize: 13, lineHeight: 1.5 }}>
          L'Atelier couldn't reach your OS keychain to encrypt this password. On Linux this
          usually means <code>libsecret</code> isn't installed or no session keyring is running.
        </p>
        <p style={{ marginTop: 0, marginBottom: 12, fontSize: 13, lineHeight: 1.5 }}>
          You can:
        </p>
        <ul style={{ marginTop: 0, marginBottom: 12, paddingLeft: 20, fontSize: 13, lineHeight: 1.55 }}>
          <li>Switch this connection to <strong>X.509</strong> or <strong>None</strong> auth, which doesn't store a password.</li>
          <li>Or, store passwords as <strong>plaintext</strong> in the local database.</li>
        </ul>
        <div
          style={{
            background: 'rgba(184,76,20,0.1)', color: T.warn,
            border: `1px solid ${T.warn}33`, borderRadius: T.rs,
            padding: '8px 10px', fontSize: 12, lineHeight: 1.5, marginBottom: 16,
          }}
        >
          <strong>Not recommended.</strong> Anyone with read access to the local database
          {' '}file will be able to recover the password. Use this only on machines you control.
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button
            type="button"
            onClick={close}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: T.textMuted, fontSize: 13, fontFamily: 'inherit',
              padding: '6px 8px',
            }}
          >
            Cancel
          </button>
          <Button variant="filled" color="red" size="compact-xs" onClick={onConfirm}>
            Store as plaintext
          </Button>
        </div>
      </div>
    </Modal>
  );
}
