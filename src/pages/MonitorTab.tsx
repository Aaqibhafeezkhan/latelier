import React from 'react';
import { Button, Checkbox, SegmentedControl, Table, VisuallyHidden } from '@mantine/core';
import { themeVars } from '../theme/themeVars';
import { I } from '../icons';
import { api, isIpcError } from '../api/atelier';
import { confirmDestructive } from '../utils/confirm';
import { ejsonParse } from '../utils/ejson';
import { DisclosureToggle } from '../components/DisclosureToggle';
import { FeatureHint } from '../hints/FeatureHint';
import { useFeatureHint } from '../hints/useFeatureHint';
import { MONITOR_POLL_MS } from '../utils/monitorPoll';
import type { DbInfo } from '@shared/ipc';
import type {
  ConnectionRuntime,
  ConnectionSummary,
  CurrentOpSummary,
  ProfileLevel,
  ProfileStatus,
} from '@shared/types';

const MIN_SECS_DEBOUNCE_MS = 300;
const PROFILE_ROWS = 50;

const tableStyles = {
  table: { fontSize: 12 },
  th: {
    fontSize: 10,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    fontWeight: 600,
    color: themeVars.textMuted,
    padding: '8px 12px',
  },
  td: { padding: '6px 12px', verticalAlign: 'middle' as const },
};

const sectionTitle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: themeVars.textMuted,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
};

const inputStyle: React.CSSProperties = {
  border: `1px solid ${themeVars.border}`,
  borderRadius: themeVars.rs,
  background: themeVars.surfaceRaised,
  padding: '3px 6px',
  fontSize: 12,
  color: themeVars.text,
};

function errText(err: unknown): string {
  return isIpcError(err) ? err.message : String(err);
}

/** A `system.profile` row read off its canonical EJSON. */
function profileRow(doc: unknown): { ts: string; op: string; ns: string; millis: string; plan: string } {
  const d = ejsonParse<Record<string, unknown>>(JSON.stringify(doc));
  const text = (v: unknown) => (typeof v === 'string' ? v : '—');
  return {
    ts: d.ts instanceof Date ? d.ts.toLocaleString() : '—',
    op: text(d.op),
    ns: text(d.ns),
    millis: d.millis === undefined ? '—' : String(d.millis),
    plan: text(d.planSummary),
  };
}

export function MonitorTab({ conn, runtime }: { conn: ConnectionSummary; runtime: ConnectionRuntime }) {
  const T = themeVars;
  const connected = runtime.status === 'connected';
  const readOnlyNoteId = React.useId();
  // Every disabled write control points at the visible read-only note.
  const readOnlyProps = conn.readOnly
    ? { disabled: true, 'aria-describedby': readOnlyNoteId }
    : {};

  // ─── Current operations ───────────────────────────────────────────────
  const [ops, setOps] = React.useState<CurrentOpSummary[] | null>(null);
  const [opsError, setOpsError] = React.useState<string | null>(null);
  const [activeOnly, setActiveOnly] = React.useState(true);
  const [minSecs, setMinSecs] = React.useState('');
  const [paused, setPaused] = React.useState(false);
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = React.useState<number | null>(null);
  // Only the latest poll may write state: a slow reply must not overwrite a newer one.
  const latest = React.useRef(0);
  // Requests still pending. An interval tick is skipped while one is, so a slow
  // server never has polls piling up behind each other.
  const pending = React.useRef(0);

  // The text field feeds the request through a short delay, so typing "120"
  // sends one $currentOp, not three overlapping ones.
  const [appliedMinSecs, setAppliedMinSecs] = React.useState('');
  React.useEffect(() => {
    const handle = setTimeout(() => setAppliedMinSecs(minSecs), MIN_SECS_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [minSecs]);
  const minSecsRunning = Number.parseInt(appliedMinSecs, 10);
  const loadOps = React.useCallback(async () => {
    const id = ++latest.current;
    pending.current++;
    try {
      const res = await api.admin.currentOp({
        connectionId: conn.id,
        activeOnly,
        ...(minSecsRunning > 0 ? { minSecsRunning } : {}),
      });
      if (id !== latest.current) return;
      setOps(res.ops);
      setOpsError(null);
      setUpdatedAt(Date.now());
    } catch (err) {
      if (id === latest.current) setOpsError(errText(err));
    } finally {
      pending.current--;
    }
  }, [conn.id, activeOnly, minSecsRunning]);

  // Same cadence pattern as the Overview tab: poll on an interval, skip while
  // the window is hidden or the last request is still out. Pause stops the
  // interval altogether.
  React.useEffect(() => {
    if (!connected || paused) return;
    // A fetch: its setState lands after the await, as in RolesTab.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadOps();
    const handle = setInterval(() => {
      if (document.visibilityState === 'visible' && pending.current === 0) void loadOps();
    }, MONITOR_POLL_MS);
    return () => clearInterval(handle);
  }, [loadOps, connected, paused]);

  const kill = async (o: CurrentOpSummary & { opid: string }) => {
    const where = o.ns || o.desc || 'no namespace';
    const ok = await confirmDestructive({
      title: `Kill operation ${o.opid}?`,
      body: `${o.op} on ${where}, running ${o.secsRunning ?? 0}s. The server stops it; whatever it already wrote stays written.`,
      confirmLabel: 'Kill',
    });
    if (!ok) return;
    try {
      await api.admin.killOp({ connectionId: conn.id, opid: o.opid });
      await loadOps();
    } catch (err) {
      setOpsError(errText(err));
    }
  };

  // ─── Profiler ─────────────────────────────────────────────────────────
  const [dbs, setDbs] = React.useState<DbInfo[] | null>(null);
  const [dbName, setDbName] = React.useState(conn.defaultDb ?? '');
  const [status, setStatus] = React.useState<ProfileStatus | null>(null);
  const [level, setLevel] = React.useState<ProfileLevel>(0);
  const [slowms, setSlowms] = React.useState('100');
  const [profile, setProfile] = React.useState<unknown[] | null>(null);
  const [profError, setProfError] = React.useState<string | null>(null);
  // The level the last successful Apply set, for the profiler hint; 0 = nothing on.
  const [appliedLevel, setAppliedLevel] = React.useState<ProfileLevel>(0);
  const latestProfile = React.useRef(0);
  // The database picked right now, readable from a closure captured earlier.
  const dbNameRef = React.useRef(dbName);

  React.useEffect(() => {
    if (!connected) return;
    api.meta
      .listDatabases({ connectionId: conn.id })
      .then((rows) => {
        setDbs(rows);
        if (!dbNameRef.current) {
          dbNameRef.current = rows[0]?.name || 'admin';
          setDbName(dbNameRef.current);
        }
      })
      .catch((err: unknown) => setProfError(errText(err)));
  }, [conn.id, connected]);

  const loadProfile = React.useCallback(async () => {
    // A stale closure (an Apply that finished after another database was
    // picked) must not start a load: bumping the counter would also discard
    // the reply of the load that belongs to the picked database.
    if (!dbName || dbName !== dbNameRef.current) return;
    // A reply for a database no longer picked must not land.
    const id = ++latestProfile.current;
    try {
      const [st, tail] = await Promise.all([
        api.admin.profileStatus({ connectionId: conn.id, dbName }),
        api.admin.profileTail({ connectionId: conn.id, dbName, limit: PROFILE_ROWS }),
      ]);
      if (id !== latestProfile.current) return;
      setStatus(st);
      setLevel(st.level);
      setSlowms(String(st.slowms));
      setProfile(tail.docs);
      setProfError(null);
    } catch (err) {
      if (id !== latestProfile.current) return;
      // Without a status there is nothing to apply against: Apply stays off
      // rather than sending the defaults.
      setStatus(null);
      setProfile(null);
      setProfError(errText(err));
    }
  }, [conn.id, dbName]);

  const pickDb = (next: string) => {
    // A select fires change for the value it already holds too; clearing then
    // would leave nothing to reload it.
    if (next === dbName) return;
    dbNameRef.current = next;
    setDbName(next);
    setStatus(null);
    setProfile(null);
    setAppliedLevel(0);
  };

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a fetch, as above
    if (connected) void loadProfile();
  }, [loadProfile, connected]);

  const applyLevel = async () => {
    const ms = Number.parseInt(slowms, 10);
    try {
      await api.admin.setProfileLevel({
        connectionId: conn.id,
        dbName,
        level,
        ...(ms >= 0 ? { slowms: ms } : {}),
      });
      // The user may have picked another database while this was in flight; the
      // level just applied says nothing about the one now selected.
      if (dbNameRef.current === dbName) setAppliedLevel(level);
      await loadProfile();
    } catch (err) {
      setProfError(errText(err));
    }
  };

  const liveHint = useFeatureHint('monitor.live', connected);
  const profilerHint = useFeatureHint('monitor.profiler', connected && appliedLevel !== 0);

  if (!connected) {
    return (
      <div style={{ padding: 32, textAlign: 'center', color: T.textMuted }}>
        Not connected. Open the Overview tab to connect.
      </div>
    );
  }

  const dbNames = dbs?.map((d) => d.name) ?? [];
  if (dbName && !dbNames.includes(dbName)) dbNames.unshift(dbName);

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 20 }}>
      {conn.readOnly && (
        <div id={readOnlyNoteId} style={{ fontSize: 12, color: T.textMuted }}>
          Read-only connection: killing operations and changing the profiler are disabled.
        </div>
      )}
      <section aria-label="Current operations" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={sectionTitle}>Current operations</span>
          <Checkbox
            size="xs"
            label="Active only"
            checked={activeOnly}
            onChange={(e) => setActiveOnly(e.currentTarget.checked)}
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: T.textMuted }}>
            Running ≥
            <input
              type="number"
              min={0}
              value={minSecs}
              onChange={(e) => setMinSecs(e.target.value)}
              aria-label="Minimum seconds running"
              style={{ ...inputStyle, width: 60 }}
            />
            s
          </label>
          <div style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: T.textMuted }}>
            {paused
              ? 'Paused'
              : updatedAt
                ? `Updated ${new Date(updatedAt).toLocaleTimeString()}`
                : 'Loading…'}
          </span>
          <Button
            size="compact-xs"
            variant="subtle"
            data-hint-anchor="monitor.live"
            onClick={() => setPaused((p) => !p)}
          >
            {paused ? 'Resume' : 'Pause'}
          </Button>
          <Button size="compact-xs" variant="subtle" leftSection={I.sync} onClick={() => void loadOps()}>
            Refresh
          </Button>
        </div>
        {opsError && <div role="alert" style={{ color: T.warn, fontSize: 12 }}>{opsError}</div>}
        {ops && ops.length === 0 && (
          <div style={{ color: T.textMuted, fontSize: 12, padding: '8px 0' }}>No operations match.</div>
        )}
        {ops && ops.length > 0 && (
          <Table striped highlightOnHover withTableBorder styles={tableStyles} aria-label="Running operations">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Opid</Table.Th>
                <Table.Th>Op</Table.Th>
                <Table.Th>Namespace</Table.Th>
                <Table.Th>Secs</Table.Th>
                <Table.Th>Client</Table.Th>
                <Table.Th>Plan</Table.Th>
                <Table.Th style={{ width: 64 }}><VisuallyHidden>Actions</VisuallyHidden></Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {ops.map((o, i) => {
                // A row without an opid (the server gives none to some) is keyed by
                // position and offers no Kill.
                const key = o.opid ?? `no-opid-${i}`;
                const open = expanded === key;
                const opid = o.opid;
                return (
                  <React.Fragment key={key}>
                    <Table.Tr onClick={() => setExpanded(open ? null : key)} style={{ cursor: 'pointer' }}>
                      <Table.Td>
                        <DisclosureToggle open={open}>
                          <span style={{ fontFamily: 'monospace' }}>{opid ?? '—'}</span>
                        </DisclosureToggle>
                      </Table.Td>
                      <Table.Td>{o.op}</Table.Td>
                      <Table.Td style={{ fontFamily: 'monospace' }}>{o.ns || o.desc || '—'}</Table.Td>
                      <Table.Td>{o.secsRunning ?? '—'}</Table.Td>
                      <Table.Td>{o.client ?? '—'}</Table.Td>
                      <Table.Td>{o.planSummary ?? '—'}</Table.Td>
                      <Table.Td>
                        {opid !== undefined && (
                          <Button
                            size="compact-xs"
                            variant="subtle"
                            color="red"
                            aria-label={`Kill operation ${opid}`}
                            {...readOnlyProps}
                            onClick={(e) => {
                              e.stopPropagation();
                              void kill({ ...o, opid });
                            }}
                          >
                            Kill
                          </Button>
                        )}
                      </Table.Td>
                    </Table.Tr>
                    {open && (
                      <Table.Tr>
                        <Table.Td colSpan={7}>
                          {/* Shown as text, never parsed: the command may be cut off mid-token. */}
                          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 11 }}>
                            {o.command}
                          </pre>
                        </Table.Td>
                      </Table.Tr>
                    )}
                  </React.Fragment>
                );
              })}
            </Table.Tbody>
          </Table>
        )}
      </section>

      <section aria-label="Profiler" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {/* Anchored on the toolbar, not the section: the profile table below can run
            past the viewport and the hint would land off-screen. */}
        <div data-hint-anchor="monitor.profiler" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={sectionTitle}>Profiler</span>
          <select
            aria-label="Profiler database"
            value={dbName}
            onChange={(e) => pickDb(e.target.value)}
            style={{ ...inputStyle, minWidth: 140 }}
          >
            {dbNames.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
          <span style={{ fontSize: 12, color: T.textMuted }}>
            {status ? `Current: ${['Off', 'Slow', 'All'][status.level]}, slowms ${status.slowms}` : ''}
          </span>
          <SegmentedControl
            size="xs"
            aria-label="Profiling level"
            value={String(level)}
            onChange={(v) => setLevel(Number(v) as ProfileLevel)}
            {...readOnlyProps}
            data={[
              { value: '0', label: 'Off' },
              { value: '1', label: 'Slow' },
              { value: '2', label: 'All' },
            ]}
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: T.textMuted }}>
            slowms
            <input
              type="number"
              min={0}
              value={slowms}
              onChange={(e) => setSlowms(e.target.value)}
              {...readOnlyProps}
              aria-label="slowms"
              style={{ ...inputStyle, width: 70 }}
            />
            <span style={{ fontSize: 11 }}>(server-wide, not just this database)</span>
          </label>
          <Button
            size="compact-xs"
            variant="filled"
            {...readOnlyProps}
            disabled={conn.readOnly || !status}
            onClick={() => void applyLevel()}
          >
            Apply
          </Button>
          <div style={{ flex: 1 }} />
          <Button size="compact-xs" variant="subtle" leftSection={I.sync} onClick={() => void loadProfile()}>
            Refresh
          </Button>
        </div>
        {profError && <div role="alert" style={{ color: T.warn, fontSize: 12 }}>{profError}</div>}
        {profile && profile.length === 0 && (
          <div style={{ color: T.textMuted, fontSize: 12, padding: '8px 0' }}>
            No profiled operations on {dbName}.
          </div>
        )}
        {profile && profile.length > 0 && (
          <Table striped withTableBorder styles={tableStyles} aria-label="Profiled operations">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Time</Table.Th>
                <Table.Th>Op</Table.Th>
                <Table.Th>Namespace</Table.Th>
                <Table.Th>Millis</Table.Th>
                <Table.Th>Plan</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {profile.map((doc, i) => {
                const r = profileRow(doc);
                return (
                  // ponytail: index key; system.profile rows have no id and the list is replaced wholesale.
                  <Table.Tr key={i}>
                    <Table.Td>{r.ts}</Table.Td>
                    <Table.Td>{r.op}</Table.Td>
                    <Table.Td style={{ fontFamily: 'monospace' }}>{r.ns}</Table.Td>
                    <Table.Td>{r.millis}</Table.Td>
                    <Table.Td>{r.plan}</Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        )}
      </section>
      <FeatureHint id="monitor.live" visible={liveHint.visible} onDismiss={liveHint.dismiss} />
      <FeatureHint
        id="monitor.profiler"
        visible={profilerHint.visible}
        onDismiss={profilerHint.dismiss}
      />
    </div>
  );
}
