import type { SchemaTabState } from '@shared/types';
import { IndexesTab, type IndexCreateRequest } from '../IndexesTab';
import { CollectionStatsSection } from './CollectionStatsSection';
import { SchemaView } from './SchemaView';
import { ValidationSection } from './ValidationSection';
import { useCollectionDetails } from './useCollectionDetails';

interface Props {
  connectionId: string;
  dbName: string;
  collection: string;
  state: SchemaTabState;
  onPatch: (patch: Partial<SchemaTabState>) => void;
  /** See `IndexCreateRequest` — threaded straight through to `IndexesTab`. */
  initialCreate?: IndexCreateRequest | null;
  onInitialCreateConsumed?: () => void;
}

/**
 * The collection tab's Structure sub-view (W16 Tier 2, ADR 0003): the
 * statistics header, the namespace-scoped indexes and the validation rules
 * stacked above the sampled schema, so the enforced shape sits next to the
 * observed one, in one
 * scrolling pane rather than a fourth tab. `IndexesTab` and `SchemaView`
 * each used to own their own `flex:1; overflow:auto` scroller, sized by a
 * flex parent with a definite height (the collection tab's result panel).
 * Stacked here inside a plain scrolling block, that same styling collapses
 * both sections toward zero height — an "auto" height ancestor gives a
 * `flex:1` child (flex-basis 0%) nothing to grow against, and a non-visible
 * `overflow` zeroes its automatic min size. `IndexesTab` and `SchemaView`
 * lay out at natural content height instead; this pane is the only
 * scroller.
 */
export function StructureView({
  connectionId,
  dbName,
  collection,
  state,
  onPatch,
  initialCreate,
  onInitialCreateConsumed,
}: Props) {
  const { details, error, loading, reload } = useCollectionDetails(connectionId, dbName, collection);
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
      <CollectionStatsSection details={details} error={error} loading={loading} onRefresh={() => void reload()} />
      {/* Held until the details settle: a view must never be asked for its indexes. */}
      {(details || error) && (
        <IndexesTab
          connectionId={connectionId}
          dbName={dbName}
          collection={collection}
          viewOn={details?.type === 'view' ? details.options.viewOn : undefined}
          initialCreate={initialCreate}
          onInitialCreateConsumed={onInitialCreateConsumed}
          onChanged={() => void reload()}
        />
      )}
      {/* The server refuses collMod rules on a view and on a time-series collection. */}
      {details?.type === 'collection' && (
        <ValidationSection
          connectionId={connectionId}
          dbName={dbName}
          collection={collection}
          details={details}
          onSaved={reload}
        />
      )}
      <SchemaView
        connectionId={connectionId}
        dbName={dbName}
        collection={collection}
        state={state}
        onPatch={onPatch}
      />
    </div>
  );
}
