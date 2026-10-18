import { expect, type Page } from '@playwright/test';
import { ConnectionSwitcherPage } from './ConnectionSwitcherPage';

/**
 * Workspace surface helpers. Locators target the stable anchors found in
 * Workspace.tsx, DbCollectionNavigator.tsx, QueryBar.tsx, BuilderPane.tsx,
 * and ResultArea.tsx.
 */
export class WorkspacePage {
  private readonly win: Page;

  /** The Connection Switcher layered over this Data View. */
  readonly switcher: ConnectionSwitcherPage;

  constructor(win: Page) {
    this.win = win;
    this.switcher = new ConnectionSwitcherPage(win);
  }

  // Tree navigator
  get navigator() { return this.win.locator('[aria-label="Database navigator"]'); }
  get navigatorTree() { return this.win.locator('[role="tree"][aria-label="Databases and collections"]'); }
  get navigatorFilter() { return this.win.locator('[aria-label="Database navigator"] input[aria-label="Filter collections"]'); }

  // Tab strip (uses role="tab" + aria-selected)
  get tablist() { return this.win.locator('[role="tablist"][aria-label="Collection view"]'); }

  /** "+ Script" button in the top-level tab strip — opens a new Script tab. */
  get newScriptTab() { return this.win.locator('[aria-label="New script tab"]'); }

  /** Treeitem for a database — uses the data-testid baked into the navigator. */
  dbRow(dbName: string) {
    return this.win.locator(`[data-testid="nav-db-${dbName}"]`);
  }

  /** The navigator's connection-level "Refresh" button — re-fetches the DB list. */
  get navigatorRefreshButton() { return this.win.getByRole('button', { name: 'Refresh' }); }

  /** Treeitem for a collection inside a database. */
  collectionRow(dbName: string, collection: string) {
    return this.win.locator(`[data-testid="nav-coll-${dbName}-${collection}"]`);
  }

  /** The QueryBar textarea is the raw-filter input at the top of a collection tab. */
  get queryBarTextarea() { return this.win.locator('[data-testid="query-bar-input"]'); }

  /** The QueryBar Run button — top of the tab, always visible when a tab is open. */
  get queryBarRunButton() { return this.win.locator('[data-testid="query-run-btn"]'); }

  /**
   * The collapsible advanced row (sort / skip / limit). Only in
   * the DOM while expanded, so presence is the open/closed assertion (W14 §8).
   */
  get queryBarAdvanced() { return this.win.locator('#query-bar-advanced'); }

  /** The QUERY label cell doubles as the advanced row's expand/collapse trigger. */
  get queryBarAdvancedToggle() { return this.win.locator('[aria-controls="query-bar-advanced"]'); }

  /** The result bar's Fields control trigger; its name gains a badge's text when one shows. */
  // `aria-haspopup`: a Tab Group header is named after its Connection, so a
  // Connection called "Fields …" would otherwise match too.
  get fieldsButton() {
    return this.win.getByRole('button', { name: /^Fields/ }).and(this.win.locator('[aria-haspopup="dialog"]'));
  }

  /** Projection input in the Fields control's "fetch" section — only while the control is open. */
  get fieldsProjection() { return this.win.locator('[data-testid="fields-projection"]'); }

  /** SORT input inside the advanced row. */
  get queryBarSort() { return this.win.locator('[data-testid="query-bar-sort"]'); }

  /** LIMIT input inside the advanced row. */
  get queryBarLimit() { return this.win.locator('[data-testid="query-bar-limit"]'); }

  /** SKIP — read-only; driven by the pager (W15 §4.4). */
  get queryBarSkip() { return this.win.locator('[data-testid="query-bar-skip"]'); }

  /**
   * Table-level sort note in the header gutter — present only for a sort the
   * per-column arrows can't express (W15 §3.2).
   */
  get tableSortNote() { return this.win.locator('[data-testid="table-header-sort-note"]'); }

  /** Table header cell for a column. */
  tableHeader(field: string) {
    return this.win.locator(`[data-testid="table-header-${field}"]`);
  }

  /** The QueryBar "Run options" chevron — opens the Run/Explain menu. */
  get queryBarRunOptionsButton() { return this.win.locator('[data-testid="query-run-options-btn"]'); }

  /** ResultBar "Documents" menu trigger — hosts bulk/destructive document actions. */
  get resultOverflowMenuButton() { return this.win.getByRole('button', { name: 'Documents' }); }

  /** "Delete all matching…" item inside the ResultBar "Documents" menu. */
  get deleteAllMatchingMenuItem() {
    return this.win.getByRole('menuitem', { name: /Delete all matching/ });
  }

  /** "Update all matching…" item inside the ResultBar "Documents" menu. */
  get updateAllMatchingMenuItem() {
    return this.win.getByRole('menuitem', { name: /Update all matching/ });
  }

  // T0.4 — contextual bulk-action bar, visible once ≥1 result row is selected.
  get selectionBarCount() { return this.win.locator('[data-testid="selection-bar-count"]'); }
  get selectionBarCopyButton() { return this.win.locator('[data-testid="selection-bar-copy"]'); }
  get selectionBarDeleteButton() { return this.win.locator('[data-testid="selection-bar-delete"]'); }
  get selectionBarClearButton() { return this.win.locator('[data-testid="selection-bar-clear"]'); }

  // Result-view switch is a Mantine SegmentedControl (role="radiogroup"). Each
  // option renders a visible <label>, while its radio <input> is sr-only
  // (height/width: 0) — so target the labels, not a button/radio role.
  private get viewSwitch() { return this.win.getByRole('radiogroup'); }
  get viewTreeButton() { return this.viewSwitch.getByText('Tree', { exact: true }); }
  get viewJsonButton() { return this.viewSwitch.getByText('JSON', { exact: true }); }
  get viewTableButton() { return this.viewSwitch.getByText('Table', { exact: true }); }

  /** A tab in the top-level tab strip. Tabs render the collection name as visible text. */
  tabByName(name: string) {
    return this.win.locator(`[role="tab"]`).filter({ hasText: name });
  }

  async waitNavigatorVisible() {
    await expect(this.navigator).toBeVisible({ timeout: 10000 });
  }

  /**
   * Waits for a DB row to appear, clicking Refresh every second in the
   * meantime.
   *
   * Why this exists: a database created moments earlier via `doc.insert` can
   * be genuinely absent from the very next `listDatabases` the navigator
   * issues — reproduced directly against a real `mongodb-memory-server`, the
   * identical query returns `[]` immediately after the write and `['shop']`
   * a beat later. `DbCollectionNavigator`'s own fetch only runs once per
   * connection (gated on `dbsPresent`), so a first empty answer sticks
   * without a nudge; its own "Refresh" button re-fetches unconditionally.
   */
  async waitForDb(dbName: string, timeout = 8000) {
    const row = this.dbRow(dbName);
    const deadline = Date.now() + timeout;
    for (;;) {
      // Each wait returns the moment the row appears, rather than sleeping a
      // fixed interval regardless of how fast it actually shows up.
      const appeared = await expect(row)
        .toBeVisible({ timeout: 1000 })
        .then(() => true)
        .catch(() => false);
      if (appeared) return;
      if (Date.now() > deadline) break;
      await this.navigatorRefreshButton.click().catch(() => {});
    }
    await expect(row).toBeVisible({ timeout: 1000 });
  }

  /** Click a DB row, then a collection row, and wait for its tab to be active. */
  async openCollectionFromNavigator(dbName: string, collection: string) {
    await this.waitForDb(dbName);
    // Expand the DB if not already; clicking the row toggles expansion.
    await this.dbRow(dbName).click();
    await expect(this.collectionRow(dbName, collection)).toBeVisible({ timeout: 5000 });
    await this.collectionRow(dbName, collection).click();
    // The navigator row's own selection follows the focused tab's database
    // and collection. A tab-name check can't tell same-named collections in
    // two databases apart: with one already open it either matches both
    // tabs, or passes against the old one before the new tab (created after
    // an async IPC round-trip) exists.
    await expect(this.collectionRow(dbName, collection)).toHaveAttribute('aria-selected', 'true', {
      timeout: 5000,
    });
  }
}
