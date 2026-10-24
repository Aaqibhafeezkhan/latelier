import React from 'react';
import { useNavigate } from 'react-router-dom';
import { themeVars } from '../theme/themeVars';
import { I } from '../icons';
import { Button, Table, UnstyledButton, VisuallyHidden } from '@mantine/core';
import { api, isIpcError } from '../api/atelier';
import { disconnectConnection } from '../features/connections/disconnectConnection';
import type {
  CollectionInfo,
  DbInfo,
  ServerInfo,
} from '@shared/ipc';
import type { ConnectionRuntime, ConnectionSummary } from '@shared/types';
import { UsersTab } from './UsersTab';
import { RolesTab } from './RolesTab';
import { MonitorTab } from './MonitorTab';
import { CreateCollectionDrawer } from './Workspace/CreateCollectionDrawer';
import { useTroubleshooting } from '../troubleshooting/TroubleshootingContext';
import { relativeTime } from '../utils/relativeTime';
import { ownGet } from '../utils/ownProperty';
import { humanBytes } from '../utils/humanBytes';

const TABS = ['Overview', 'Monitor', 'Collections', 'Users', 'Roles'] as const;
type Tab = typeof TABS[number];

function humanDuration(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '—';
  const days = Math.floor(s / 86_400);
  const hours = Math.floor((s % 86_400) / 3_600);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${Math.floor((s % 3600) / 60)}m`;
  const mins = Math.floor(s / 60);
  if (mins > 0) return `${mins}m`;
  return `${Math.floor(s)}s`;
}

function KVRow({ k, v }: { k: string; v: React.ReactNode }) {
  const T = themeVars;
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '6px 0', borderBottom: `1px solid ${T.border}`,
    }}>
      <span style={{ fontSize: 11, color: T.textMuted }}>{k}</span>
      <span style={{ fontSize: 11, color: T.text, fontWeight: 500 }}>{v}</span>
    </div>
  );
}

function OverviewCard({ title, rows }: { title: string; rows: [string, React.ReactNode][] }) {
  const T = themeVars;
  return (
    <div style={{
      flex: 1, border: `1px solid ${T.border}`, borderRadius: T.r,
      padding: '12px 14px', background: T.surface, minWidth: 180,
    }}>
      <div style={{
        fontSize: 11, fontWeight: 600, color: T.textMuted, marginBottom: 8,
        textTransform: 'uppercase', letterSpacing: '0.06em',
      }}>
        {title}
      </div>
      {rows.map(([k, v]) => <KVRow key={k} k={k} v={v} />)}
    </div>
  );
}

function OverviewTab({ conn, runtime }: {
  conn: ConnectionSummary;
  runtime: ConnectionRuntime;
}) {
  const T = themeVars;
  const help = useTroubleshooting();
  const [info, setInfo] = React.useState<ServerInfo | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [stale, setStale] = React.useState(false);
  const [lastLoadedAt, setLastLoadedAt] = React.useState<number | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.mongo.serverInfo(conn.id);
      setInfo(r);
      setStale(false);
      setLastLoadedAt(Date.now());
    } catch (err) {
      if (info) {
        setStale(true);
      } else {
        setError(isIpcError(err) ? err.message : String(err));
      }
    } finally {
      setLoading(false);
    }
  }, [conn.id, info]);

  React.useEffect(() => {
    queueMicrotask(() => {
      setInfo(null);
      setError(null);
      setStale(false);
      if (runtime.status === 'connected') void load();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn.id, runtime.status]);

  React.useEffect(() => {
    if (runtime.status !== 'connected') return;
    const handler = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 15_000);
    return () => clearInterval(handler);
  }, [load, runtime.status]);

  if (runtime.status !== 'connected') {
    const needsConnect = runtime.status === 'disconnected';
    const hasError = runtime.status === 'error';
    const isConnecting = runtime.status === 'connecting';
    return (
      <div style={{ padding: 32, textAlign: 'center' }}>
        <div style={{ fontSize: 13, color: T.text, marginBottom: 16 }}>
          {isConnecting
            ? 'Connecting…'
            : hasError
              ? `Connection error${runtime.errorMessage ? ': ' + runtime.errorMessage : ''}`
              : 'Not connected.'}
        </div>
        {isConnecting && (
          <Button
            variant="subtle"
            size="xs"
            aria-label="Cancel connection"
            onClick={() => {
              void disconnectConnection(conn.id);
            }}
          >
            Cancel connection
          </Button>
        )}
        {(needsConnect || hasError) && (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 12 }}>
            <Button
              variant="filled"
              size="xs"
              onClick={() => {
                void api.mongo.connect(conn.id).catch(() => { /* status event updates UI */ });
              }}
            >
              {hasError ? 'Retry' : 'Connect'}
            </Button>
            {hasError && (
              <Button
                variant="subtle"
                size="compact-xs"
                c={T.accent}
                onClick={() =>
                  help.open({
                    errorCode: runtime.errorCode,
                    message: runtime.errorMessage,
                  })
                }
              >
                Help me fix this →
              </Button>
            )}
          </div>
        )}
      </div>
    );
  }

  if (!info && error) {
    return (
      <div style={{ padding: 20, color: T.warn, fontSize: 13 }}>
        {error}{' '}
        <Button variant="subtle" size="compact-xs" c={T.accent} ml={8} onClick={() => void load()}>
          Retry
        </Button>
      </div>
    );
  }
  if (!info) {
    return (
      <div style={{ padding: 20, color: T.textMuted, fontSize: 13 }}>
        {loading ? 'Loading server info…' : 'Preparing…'}
      </div>
    );
  }

  return (
    <div style={{ padding: 20 }}>
      <div style={{
        display: 'flex', alignItems: 'center', marginBottom: 12, gap: 10,
      }}>
        <span style={{ fontSize: 11, color: T.textMuted }}>
          {lastLoadedAt ? `Updated ${new Date(lastLoadedAt).toLocaleTimeString()}` : 'Never refreshed'}
        </span>
        {stale && (
          <span style={{
            fontSize: 10, padding: '2px 6px', borderRadius: T.rx,
            background: 'rgba(184,76,20,0.1)', color: T.warn,
          }}>
            stale — refresh failed
          </span>
        )}
        <div style={{ flex: 1 }} />
        <Button size="compact-xs" variant="subtle" onClick={() => void load()} leftSection={I.sync}>
          Refresh
        </Button>
      </div>

      {!info!.serverStatsAvailable && (
        <div
          style={{
            marginBottom: 12,
            padding: '8px 10px',
            fontSize: 11,
            color: T.textMuted,
            background: T.surfaceRaised,
            border: `1px solid ${T.border}`,
            borderRadius: T.rs,
          }}
        >
          Server statistics (uptime, connections, ops) aren't available — the
          MongoDB user lacks the <code>serverStatus</code> privilege.
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <OverviewCard
          title="Server"
          rows={[
            ['Host', `${conn.host}:${conn.port}`],
            ['Version', info!.version],
            ['Uptime', info!.serverStatsAvailable ? humanDuration(info!.uptimeSeconds) : '—'],
            ['Topology', info!.topology],
          ]}
        />
        <OverviewCard
          title="Storage"
          rows={[
            ['Databases', info!.databaseCount === null ? '—' : String(info!.databaseCount)],
            ['Data size', info!.dataSizeBytes === null ? '—' : humanBytes(info!.dataSizeBytes)],
            [
              'Storage size',
              info!.storageSizeBytes === null ? '—' : humanBytes(info!.storageSizeBytes),
            ],
            ['Indexes', info!.indexCount === null ? '—' : String(info!.indexCount)],
          ]}
        />
        <OverviewCard
          title="Performance"
          rows={[
            [
              'Connections',
              info!.serverStatsAvailable
                ? `${info!.connectionsCurrent} / ${info!.connectionsAvailable + info!.connectionsCurrent}`
                : '—',
            ],
            ['Ops/sec', info!.serverStatsAvailable ? String(info!.opcountersPerSec) : '—'],
            ['Latency p99', info!.latencyP99Ms === undefined ? '—' : `${info!.latencyP99Ms} ms`],
            ['Cache hit', info!.cacheHitRate === undefined ? '—' : `${(info!.cacheHitRate * 100).toFixed(1)}%`],
          ]}
        />
      </div>
    </div>
  );
}

function CollectionsTab({ conn, runtime }: {
  conn: ConnectionSummary;
  runtime: ConnectionRuntime;
}) {
  const T = themeVars;
  const navigate = useNavigate();
  const [dbs, setDbs] = React.useState<DbInfo[] | null>(null);
  const [colls, setColls] = React.useState<Record<string, CollectionInfo[] | { error: string }>>({});
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
  const [filter, setFilter] = React.useState('');
  const [showSystem, setShowSystem] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [newCollOpen, setNewCollOpen] = React.useState(false);

  React.useEffect(() => {
    void api.prefs
      .get<boolean>('ui.showSystemDbs')
      .then((v) => v !== null && setShowSystem(v))
      .catch(() => { /* non-fatal */ });
  }, []);

  const loadCollections = React.useCallback(async (dbName: string) => {
    try {
      const rows = await api.meta.listCollections({
        connectionId: conn.id,
        dbName,
      });
      setColls((c) => ({ ...c, [dbName]: rows }));
    } catch (err) {
      setColls((c) => ({
        ...c,
        [dbName]: { error: isIpcError(err) ? err.message : String(err) },
      }));
    }
  }, [conn.id]);

  const loadDatabases = React.useCallback(async () => {
    if (runtime.status !== 'connected') return;
    try {
      const rows = await api.meta.listDatabases({
        connectionId: conn.id,
        includeSystem: showSystem,
      });
      setDbs(rows);
      setError(null);
      if (rows.length > 0 && rows.length <= 2) {
        const firstName = rows[0]!.name;
        setExpanded((e) => ({ ...e, [firstName]: true }));
        void loadCollections(firstName);
      }
    } catch (err) {
      setError(isIpcError(err) ? err.message : String(err));
    }
  }, [conn.id, runtime.status, showSystem, loadCollections]);

  React.useEffect(() => {
    setDbs(null);
    setColls({});
    void loadDatabases();
  }, [loadDatabases]);

  const toggleDb = (name: string) => {
    setExpanded((e) => {
      const next = !ownGet(e, name);
      if (next && !ownGet(colls, name)) void loadCollections(name);
      return { ...e, [name]: next };
    });
  };

  const toggleShowSystem = async () => {
    const next = !showSystem;
    setShowSystem(next);
    void api.prefs.set('ui.showSystemDbs', next).catch(() => { /* ok */ });
  };

  if (runtime.status !== 'connected') {
    return (
      <div style={{ padding: 32, textAlign: 'center', color: T.textMuted }}>
        Not connected. Open the Overview tab to connect.
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 20, color: T.warn }}>
        {error}
        <Button variant="subtle" size="compact-xs" c={T.accent} ml={8} onClick={() => void loadDatabases()}>
          Retry
        </Button>
      </div>
    );
  }

  const lowered = filter.trim().toLowerCase();

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 16px', borderBottom: `1px solid ${T.border}`,
        background: T.surface,
      }}>
        <div style={{
          flex: 1, display: 'flex', alignItems: 'center', gap: 6,
          border: `1px solid ${T.border}`, borderRadius: T.rs,
          background: T.surfaceRaised, padding: '4px 8px', maxWidth: 320,
        }}>
          <span style={{ color: T.textGhost, display: 'flex' }}>{I.search}</span>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter collections…"
            aria-label="Filter collections"
            style={{
              flex: 1, border: 'none', outline: 'none', background: 'transparent',
              fontSize: 12, color: T.text, fontFamily: 'inherit',
            }}
          />
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: T.textMuted, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={showSystem}
            onChange={() => void toggleShowSystem()}
            style={{ accentColor: T.accent }}
          />
          Show system DBs
        </label>
        <Button size="compact-xs" variant="subtle" onClick={() => void loadDatabases()} leftSection={I.sync}>Refresh</Button>
        <Button size="compact-xs" variant="filled" leftSection={I.plus} onClick={() => setNewCollOpen(true)}>
          New collection
        </Button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {!dbs && (
          <div style={{ padding: 20, color: T.textMuted, fontSize: 13 }}>Loading databases…</div>
        )}
        {dbs && dbs.length === 0 && (
          <div style={{ padding: 20, color: T.textMuted, fontSize: 13, textAlign: 'center' }}>
            No databases on this server.
          </div>
        )}
        {dbs?.map((db) => {
          const open = Boolean(ownGet(expanded, db.name));
          const entry = ownGet(colls, db.name);
          const rows = Array.isArray(entry)
            ? entry.filter((c) => !lowered || c.name.toLowerCase().includes(lowered))
            : null;
          return (
            <div key={db.name}>
              <UnstyledButton
                type="button"
                onClick={() => toggleDb(db.name)}
                aria-expanded={open}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '9px 16px', borderBottom: `1px solid ${T.border}`,
                  background: T.surface, width: '100%',
                  font: 'inherit', color: 'inherit', textAlign: 'left',
                }}
              >
                <span style={{ color: T.textGhost, display: 'flex' }}>{open ? I.chevD : I.chevR}</span>
                <span style={{ color: T.textMuted, display: 'flex' }}>{I.db}</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: T.text, flex: 1 }}>{db.name}</span>
                <span style={{ fontSize: 11, color: T.textMuted }}>
                  {db.sizeOnDisk === undefined ? '—' : humanBytes(db.sizeOnDisk)}
                </span>
              </UnstyledButton>
              {open && (
                <div style={{ borderBottom: `1px solid ${T.border}` }}>
                  {!entry && (
                    <div style={{ padding: '12px 16px', color: T.textMuted, fontSize: 12 }}>
                      Loading collections…
                    </div>
                  )}
                  {entry && 'error' in entry && (
                    <div style={{ padding: '12px 16px', color: T.warn, fontSize: 12 }}>
                      {entry.error}
                    </div>
                  )}
                  {rows && rows.length === 0 && (
                    <div style={{ padding: '12px 16px', color: T.textMuted, fontSize: 12 }}>
                      No collections{lowered ? ' match the filter' : ''}.
                    </div>
                  )}
                  {rows && rows.length > 0 && (
                    <Table
                      highlightOnHover
                      aria-label={`Collections in ${db.name}`}
                      styles={{
                        table: { fontSize: 11 },
                        th: {
                          fontSize: 10, fontWeight: 700, letterSpacing: 0.6,
                          textTransform: 'uppercase', color: T.textMuted,
                          background: T.surfaceRaised, padding: '6px 16px',
                        },
                        td: { padding: '6px 16px', color: T.textMuted, verticalAlign: 'middle' },
                      }}
                    >
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th>Collection</Table.Th>
                          <Table.Th>Documents</Table.Th>
                          <Table.Th>Size</Table.Th>
                          <Table.Th>Indexes</Table.Th>
                          <Table.Th>Modified</Table.Th>
                          <Table.Th style={{ width: 90 }}><VisuallyHidden>Actions</VisuallyHidden></Table.Th>
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {rows.map((c) => (
                          <Table.Tr key={c.name}>
                            <Table.Td>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <span style={{ color: T.textGhost, display: 'flex' }}>{I.doc}</span>
                                <span style={{ fontSize: 12, fontWeight: 500, color: T.text }}>{c.name}</span>
                              </div>
                            </Table.Td>
                            <Table.Td style={{ fontVariantNumeric: 'tabular-nums' }}>
                              {c.documentCount?.toLocaleString() ?? '—'}
                            </Table.Td>
                            <Table.Td>{c.sizeBytes === undefined ? '—' : humanBytes(c.sizeBytes)}</Table.Td>
                            <Table.Td>{c.indexCount ?? '—'}</Table.Td>
                            <Table.Td>{relativeTime(c.lastModified, '—')}</Table.Td>
                            <Table.Td>
                              <Button size="compact-xs" variant="subtle" leftSection={I.open} onClick={() => {
                                void api.conn.touchUsed(conn.id);
                                void navigate('/workspace', {
                                  state: {
                                    openConnectionId: conn.id,
                                    openCollection: { dbName: db.name, collection: c.name },
                                  },
                                });
                              }}>
                                Open
                              </Button>
                            </Table.Td>
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {newCollOpen && (
        <CreateCollectionDrawer
          connectionId={conn.id}
          onCancel={() => setNewCollOpen(false)}
          onCreated={({ dbName }) => {
            setNewCollOpen(false);
            void loadDatabases();
            setExpanded((e) => ({ ...e, [dbName]: true }));
            void loadCollections(dbName);
          }}
        />
      )}
    </div>
  );
}

export function DetailPanel({ selected, loading, onDelete, onDisconnect }: {
  selected: ConnectionSummary | null;
  // Also null for one beat on first mount before the IPC round-trip resolves; loading distinguishes that from a dead id.
  loading: boolean;
  onDelete: (id: string) => void;
  onDisconnect: (id: string) => void;
}) {
  const T = themeVars;
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = React.useState<Tab>('Overview');
  const [runtime, setRuntime] = React.useState<ConnectionRuntime | null>(null);

  React.useEffect(() => {
    if (!selected) return;
    let active = true;
    void api.mongo.status(selected.id).then((r) => {
      if (active) setRuntime(r);
    }).catch(() => { /* ok */ });
    const off = api.mongo.onStatus((r) => {
      if (!active) return;
      if (r.id === selected.id) setRuntime(r);
    });
    return () => {
      active = false;
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  if (!selected && loading) {
    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: T.bg, color: T.textMuted, fontSize: 13,
      }}>
        Loading…
      </div>
    );
  }

  if (!selected) {
    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: T.bg, color: T.textMuted, fontSize: 13,
      }}>
        <div style={{ textAlign: 'center', maxWidth: 320 }}>
          <div style={{ marginBottom: 16, fontSize: 14, color: T.textMuted }}>
            This connection no longer exists.
          </div>
          <Button variant="filled" size="xs" leftSection={I.chevL} onClick={() => navigate('/workspace')}>
            Back to Data View
          </Button>
        </div>
      </div>
    );
  }

  const summaryStatus = selected.status === 'unknown' ? 'disconnected' : selected.status;
  const effective: ConnectionRuntime =
    runtime ?? { id: selected.id, status: summaryStatus, serverVersion: selected.serverVersion };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: T.bg }}>
      <div style={{
        padding: '14px 20px 0', background: T.surface,
        borderBottom: `1px solid ${T.border}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: T.text }}>{selected.name}</span>
              <span style={{
                fontSize: 10, fontWeight: 600, letterSpacing: '0.05em',
                padding: '2px 7px', borderRadius: 20,
                background: effective.status === 'connected' ? T.accentSoft : `rgba(176,74,20,0.1)`,
                color: effective.status === 'connected' ? T.accent : T.warn,
                border: `1px solid ${effective.status === 'connected' ? T.accentBorder : 'rgba(176,74,20,0.25)'}`,
              }}>
                {effective.status === 'connected' ? 'Connected' : effective.status}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11, color: T.textMuted }}>
                <span style={{ color: T.textMuted }}>Host: </span>
                <span style={{ fontFamily: 'ui-monospace, monospace' }}>
                  {selected.host}:{selected.port}
                </span>
              </span>
              {effective.serverVersion && (
                <span style={{ fontSize: 11, color: T.textMuted }}>
                  <span style={{ color: T.textMuted }}>Version: </span>
                  <span style={{ fontFamily: 'ui-monospace, monospace' }}>{effective.serverVersion}</span>
                </span>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <Button variant="subtle" size="compact-xs" leftSection={I.edit} onClick={() => navigate(`/connections/${selected.id}/edit`)}>
              Edit
            </Button>
            <Button
              variant="subtle"
              size="compact-xs"
              color="red"
              leftSection={I.trash}
              onClick={() => onDelete(selected.id)}
            >
              Delete
            </Button>
            {effective.status === 'connected' && (
              <Button
                variant="subtle"
                size="compact-xs"
                leftSection={I.close}
                onClick={() => onDisconnect(selected.id)}
              >
                Disconnect
              </Button>
            )}
            <Button variant="filled" size="compact-xs" leftSection={I.open} onClick={() => {
              void api.conn.touchUsed(selected.id);
              void navigate('/workspace', { state: { openConnectionId: selected.id } });
            }}>
              Open workspace
            </Button>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 0 }}>
          {TABS.map((tab) => {
            const active = tab === activeTab;
            return (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                style={{
                  padding: '7px 14px', border: 'none', background: 'transparent',
                  fontSize: 12, fontWeight: active ? 600 : 400,
                  color: active ? T.text : T.textMuted,
                  cursor: 'pointer',
                  borderBottom: active ? `2px solid ${T.accent}` : '2px solid transparent',
                  marginBottom: -1,
                }}
              >
                {tab}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {activeTab === 'Overview' && <OverviewTab conn={selected} runtime={effective} />}
        {activeTab === 'Monitor' && <MonitorTab conn={selected} runtime={effective} />}
        {activeTab === 'Collections' && <CollectionsTab conn={selected} runtime={effective} />}
        {activeTab === 'Users' && <UsersTab conn={selected} runtime={effective} />}
        {activeTab === 'Roles' && <RolesTab conn={selected} runtime={effective} />}
      </div>
    </div>
  );
}
