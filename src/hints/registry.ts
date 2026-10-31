import type { FeatureHintId } from '@shared/types';
import { MONITOR_POLL_MS } from '../utils/monitorPoll';

export interface FeatureHintCopy {
  id: FeatureHintId;
  title: string;
  body: string;
  ctaLabel?: string;
  /**
   * Lower wins. When more than one candidate's `when` is true at once,
   * `HintsProvider` shows the one with the lowest `priority` rather than
   * whichever mounted first — the primary path (Run) should always beat a
   * secondary feature hint, regardless of registration order.
   */
  priority: number;
}

export const HINT_REGISTRY: Record<FeatureHintId, FeatureHintCopy> = {
  'run.execute': {
    id: 'run.execute',
    title: 'Press Run to see your results',
    body: 'Cmd+Enter (Ctrl+Enter on Windows/Linux) runs the query without leaving the keyboard.',
    priority: 0,
  },
  'refs.configure': {
    id: 'refs.configure',
    title: 'Link this field to another doc?',
    body: 'Fields ending in _id or Id can become clickable references. Configure a rule to follow them.',
    ctaLabel: 'Configure references',
    priority: 10,
  },
  'tabs.pin': {
    id: 'tabs.pin',
    title: 'Pin this tab',
    body: 'Pinned tabs stay at the front of the strip and are easy to find later. Right-click any tab to pin it.',
    priority: 20,
  },
  'saved.create': {
    id: 'saved.create',
    title: 'Save this query',
    body: 'Run something useful? Save it for one-click reuse from the Saved tab.',
    ctaLabel: 'Save now',
    priority: 30,
  },
  'palette.discover': {
    id: 'palette.discover',
    title: 'Find any action with ⌘K',
    body: 'Press ⌘K (Ctrl+K on Windows/Linux) to search every action — switch connections, run queries, configure references, and more.',
    ctaLabel: 'Try it',
    priority: 40,
  },
  'suggestions.keyboard': {
    id: 'suggestions.keyboard',
    title: 'Navigate suggestions',
    body: 'Tab inserts the highlighted item. ↑↓ to pick another, then Enter or Tab. Esc to close.',
    priority: 50,
  },
  'startup.restore': {
    id: 'startup.restore',
    title: 'Your tabs were reopened',
    body: 'Tabs from last time came back. You can turn this off in Settings → Reopen tabs on launch.',
    ctaLabel: 'Open settings',
    priority: 60,
  },
  'monitor.live': {
    id: 'monitor.live',
    title: 'This list refreshes on its own',
    body: `It refreshes every ${MONITOR_POLL_MS / 1000} s while the window is visible; Pause stops it. Kill asks first, and whatever the operation already wrote stays written.`,
    priority: 70,
  },
  'monitor.profiler': {
    id: 'monitor.profiler',
    title: 'Profiling stays on until you turn it off',
    body: 'The level is a server-side setting for this database, so it keeps running until you set it back to Off. Profiling can add write load.',
    priority: 80,
  },
  'indexes.usage': {
    id: 'indexes.usage',
    title: 'What the Use column counts',
    body: 'Use counts how often queries used an index since the date in its tooltip (server restart or index creation). Near zero over a long window: a drop candidate.',
    priority: 90,
  },
  'find.options': {
    id: 'find.options',
    title: 'Collation and hint apply to the whole query',
    body: 'They apply to Run, the count, export and Copy code. Delete by filter and bulk update refuse while one is set: clear it first.',
    priority: 100,
  },
};
