import React from 'react';
import { ActionIcon, Autocomplete, Button, Tooltip } from '@mantine/core';
import { themeVars } from '../theme/themeVars';
import { api } from '../api/atelier';
import { ownGet } from '../utils/ownProperty';
import type { UserRoleRef } from '@shared/types';

const FETCH_DEBOUNCE_MS = 300;

/**
 * The role-ref list shared by the user drawer (a user's roles) and the role
 * drawer (a role's inherited roles). Each name field suggests the roles that
 * exist on its row's database, fetched once per database through `role:list`.
 *
 * The check only warns, never blocks: the list can be stale or partial, and a
 * role may be created on the server after the drawer opened.
 */
export function RoleRowsEditor({
  connectionId,
  defaultDb,
  rows,
  onChange,
}: {
  connectionId: string;
  /** Database a new row starts on, and the first catalog fetched. */
  defaultDb: string;
  rows: UserRoleRef[];
  onChange: (rows: UserRoleRef[]) => void;
}) {
  const T = themeVars;
  // Role names per database. `null` marks a list that failed — usually a
  // missing privilege — so no "unknown role" warning is shown for it.
  const [catalog, setCatalog] = React.useState<Record<string, string[] | null>>({});
  const requested = React.useRef(new Set<string>());
  const opened = React.useRef(false);

  const dbKey = [...new Set([defaultDb, ...rows.map((r) => r.db.trim())])]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
    .join('\n');

  React.useEffect(() => {
    const fetchMissing = () => {
      for (const db of dbKey.split('\n')) {
        if (!db || requested.current.has(db)) continue;
        requested.current.add(db);
        api.role.list({ connectionId, dbName: db }).then(
          (roles) => setCatalog((c) => ({ ...c, [db]: roles.map((r) => r.role) })),
          () => setCatalog((c) => ({ ...c, [db]: null })),
        );
      }
    };
    // The drawer's own database loads at once; a db typed into a row waits
    // for the typing to settle, so each keystroke is not a server round-trip.
    if (!opened.current) {
      opened.current = true;
      fetchMissing();
      return;
    }
    const timer = setTimeout(fetchMissing, FETCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [connectionId, dbKey]);

  const update = (i: number, patch: Partial<UserRoleRef>) =>
    onChange(rows.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));

  const inputStyle: React.CSSProperties = {
    width: '100%',
    border: `1px solid ${T.border}`,
    borderRadius: T.rs,
    padding: '4px 8px',
    fontSize: 12,
    color: T.text,
    background: T.surfaceRaised,
    outline: 'none',
    fontFamily: 'inherit',
    boxSizing: 'border-box',
    maxWidth: 130,
  };

  return (
    <>
      {rows.map((r, i) => {
        // A db name is user text: `constructor` or `__proto__` must not read
        // an Object.prototype member as if it were a catalog.
        const known = ownGet(catalog, r.db.trim());
        const name = r.role.trim();
        const unknown = Array.isArray(known) && name !== '' && !known.includes(name);
        return (
          <div key={i} style={{ marginBottom: 6 }}>
            <div style={{ display: 'flex', gap: 6 }}>
              <Autocomplete
                aria-label={`Role name ${i + 1}`}
                value={r.role}
                onChange={(v) => update(i, { role: v })}
                data={known ?? []}
                limit={50}
                size="xs"
                style={{ flex: 1 }}
              />
              <span style={{ fontSize: 12, color: T.textMuted, alignSelf: 'center' }}>@</span>
              <input
                aria-label={`Role db ${i + 1}`}
                value={r.db}
                onChange={(e) => update(i, { db: e.target.value })}
                style={inputStyle}
              />
              <Tooltip label={`Remove role ${i + 1}`} withArrow openDelay={400}>
                <ActionIcon
                  onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
                  aria-label={`Remove role ${i + 1}`}
                  variant="subtle"
                  color="gray"
                  size="sm"
                >
                  ×
                </ActionIcon>
              </Tooltip>
            </div>
            {unknown && (
              <div style={{ fontSize: 11, color: T.warn, marginTop: 2 }}>
                Unknown role on {r.db.trim()}
              </div>
            )}
          </div>
        );
      })}
      <Button
        variant="default"
        size="compact-xs"
        c={T.textMuted}
        style={{ borderStyle: 'dashed' }}
        onClick={() => onChange([...rows, { role: 'read', db: defaultDb }])}
      >
        + Add role
      </Button>
    </>
  );
}
