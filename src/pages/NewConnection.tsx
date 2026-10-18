import React from 'react';
import { useBlocker, useLocation, useNavigate, useParams } from 'react-router-dom';
import { DarkCtx, useTheme } from '../ThemeContext';
import { themeVars } from '../theme/themeVars';
import { I } from '../icons';
import { ConnectionForm } from '../features/connections/ConnectionForm';
import { TitleBarBackLink } from '../components/TitleBarBackLink';
import { confirmDestructive } from '../utils/confirm';

export default function NewConnection() {
  const [dark, toggle] = useTheme();
  const T = themeVars;
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams<{ id?: string }>();
  const isEdit = Boolean(params.id);
  const returnTo = (location.state as { returnTo?: string } | null)?.returnTo;
  const backTarget = isEdit ? returnTo ?? `/connections/${params.id}` : '/workspace';
  const backLabel = isEdit ? (returnTo === '/workspace' ? 'Data View' : 'Connection') : 'Data View';
  // Every in-app way off this page (back link, Cancel, the palette, a shortcut)
  // is a router navigation, so one blocker covers them. It does not cover
  // closing the window, quitting or reloading (#531); `beforeunload` is no fix,
  // since Electron cancels it silently. Refs, not state: the blocker predicate
  // must see the latest value without re-subscribing.
  const dirtyRef = React.useRef(false);
  const bypassRef = React.useRef(false);
  const promptingRef = React.useRef(false);
  const onDirtyChange = React.useCallback((dirty: boolean) => {
    dirtyRef.current = dirty;
  }, []);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirtyRef.current && !bypassRef.current && nextLocation.pathname !== currentLocation.pathname,
  );
  React.useEffect(() => {
    if (blocker.state !== 'blocked' || promptingRef.current) return;
    promptingRef.current = true;
    void confirmDestructive({
      title: 'Discard changes?',
      body: 'This closes the connection form and loses what you typed, including any password.',
      confirmLabel: 'Discard',
    }).then((discard) => {
      promptingRef.current = false;
      if (discard) blocker.proceed();
      else blocker.reset();
    });
  }, [blocker]);

  const sharedFormProps = {
    onSaved: (id: string) => {
      // A saved form is not unsaved work, even if the form still reads dirty.
      bypassRef.current = true;
      void navigate(backTarget, {
        replace: true,
        state: isEdit ? undefined : { openConnectionId: id },
      });
    },
    onCancel: () => navigate(backTarget),
    onDirtyChange,
  };

  return (
    <DarkCtx.Provider value={dark}>
      <div style={{
        height: '100vh', display: 'flex', flexDirection: 'column',
        background: T.bg, color: T.text,
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        fontSize: 13,
      }}>
        <div style={{
          height: 46, display: 'flex', alignItems: 'center', gap: 12,
          padding: '0 16px', borderBottom: `1px solid ${T.border}`,
          background: T.surface, flexShrink: 0,
          WebkitAppRegion: 'drag',
        } as React.CSSProperties}>
          <div style={{ width: 70, flexShrink: 0 }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
            <TitleBarBackLink label={backLabel} onClick={() => navigate(backTarget)} />
            <span style={{ color: T.textGhost }}>/</span>
            <span style={{ color: T.textMuted, fontSize: 13 }}>
              {isEdit ? 'Edit Connection' : 'New Connection'}
            </span>
          </div>
          <div style={{ flex: 1 }} />
          <button onClick={toggle} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 28, height: 28, border: `1px solid ${T.border}`, borderRadius: T.rs,
            background: T.surfaceRaised, color: T.textMuted, cursor: 'pointer',
            WebkitAppRegion: 'no-drag',
          } as React.CSSProperties}>
            {dark ? I.sun : I.moon}
          </button>
        </div>

        {/* `key` forces a remount per target — without it, switching create↔edit at the same route reconciles and keeps stale form values. */}
        {params.id
          ? <ConnectionForm key={params.id} mode="edit" connectionId={params.id} {...sharedFormProps} />
          : <ConnectionForm key="new" mode="create" {...sharedFormProps} />}
      </div>
    </DarkCtx.Provider>
  );
}
