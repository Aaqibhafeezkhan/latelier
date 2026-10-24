/**
 * Static MQL operator catalog. Hand-curated for MongoDB 7.x. The list is the
 * source of truth for operator-name autocomplete, ranking hints inside the
 * condition builder, and rich-documentation tooltips (X04).
 *
 * `validIn` tags the contexts an operator is applicable in; the operator
 * source downranks entries whose `validIn` doesn't cover the caret's
 * `operatorContext` (resolved by the grammar detector from stageOp + depth).
 */

export type OperatorClass =
  | 'stage'
  | 'query'
  | 'logical'
  | 'element'
  | 'evaluation'
  | 'array'
  | 'geo'
  | 'accumulator'
  | 'expression'
  | 'update';

export type OperatorContext =
  | 'matchKey'
  | 'groupValue'
  | 'projectValue'
  | 'addFieldsValue'
  | 'stage'
  | 'update';

export interface OperatorDef {
  name: string;
  class: OperatorClass;
  /** One-line description (≤ 60 chars). Shown in popover rows and AddStagePill inline text. */
  summary?: string;
  /**
   * Short English *name* for the operator — "greater than", not a sentence
   * (ADR 0004's scope note). Deliberately a separate field from `summary`,
   * which is a description and reads wrong next to a symbol.
   *
   * Carried only by the query operators. A pipeline is written in real
   * operator names, so a stage keeps `$group` and gets no label.
   */
  label?: string;
  /** The symbol a user is likely to type for this operator, e.g. `>`. */
  symbol?: string;
  validIn?: readonly OperatorContext[];

  /** 1–3 sentences, plain text. Full explanation of what the op does. */
  description?: string;
  /** Signature line, rendered in a monospace block. */
  syntax?: string;
  /** Short valid JSON snippet demonstrating the op. */
  example?: string;
  /** Authoritative MongoDB docs URL. */
  url?: string;
}

// Contexts are errs-toward-inclusive: Phase B ranks off-context ops down rather
// than hiding them, so an extra tag doesn't hurt.
const MATCH: readonly OperatorContext[] = ['matchKey'];
const STAGE: readonly OperatorContext[] = ['stage'];
const GROUP: readonly OperatorContext[] = ['groupValue'];
const PROJECT_EXPR: readonly OperatorContext[] = [
  'projectValue',
  'addFieldsValue',
  'groupValue',
  'matchKey',
];
const UPDATE: readonly OperatorContext[] = ['update'];

const DOCS = 'https://www.mongodb.com/docs/manual/reference/operator';

/**
 * The only operators a value is suggested after: the builder's value box and
 * a `$match` stage body both gate on it. It mirrors `RECORDABLE_OPS` in
 * `RecentFieldValueService`, the ops main records values for. Any other
 * operator (`$regex`, `$type`, `$options`, `$exists`, ...) takes a value
 * that is not one of the field's own.
 */
export const VALUE_SUGGESTION_OPS: ReadonlySet<string> = new Set([
  '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin',
]);

/**
 * Names valid directly at a field's own operator position, `{ field: { $op:
 * value } }`. Strictly narrower than `validIn: matchKey` — that tag also
 * covers ~136 expression-class operators (`PROJECT_EXPR` includes `matchKey`)
 * plus keys that only ever appear at the top of a filter document (`$expr`,
 * `$text`, `$where`, `$and`, `$or`, `$nor`, `$jsonSchema`) or as a nested
 * modifier of another operator (`$geometry`, `$box`, `$center`,
 * `$centerSphere`, `$polygon`, `$minDistance`, `$maxDistance`), never as a
 * field's own operator.
 *
 * Used only to strictly filter the Query Builder's op box, which always sits
 * in this exact position. The wider catalog mis-tagging above (which also
 * reaches the Filter Bar and stage bodies, and only ranks down rather than
 * hides) is a separate, broader fix tracked outside this list.
 */
export const FIELD_POSITION_OPS: ReadonlySet<string> = new Set([
  '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin',
  '$exists', '$type',
  '$all', '$elemMatch', '$size',
  '$mod', '$regex', '$not',
  '$bitsAllClear', '$bitsAllSet', '$bitsAnyClear', '$bitsAnySet',
  '$geoWithin', '$geoIntersects', '$near', '$nearSphere',
]);

// ─── Stage operators ──────────────────────────────────────────────────────
const STAGES: readonly OperatorDef[] = [
  {
    name: '$match',
    class: 'stage',
    summary: 'Filter documents',
    validIn: STAGE,
    description:
      'Filters the pipeline so that only documents matching the query ' +
      'pass to the next stage. The query syntax is identical to find().',
    syntax: '{ $match: <query> }',
    example: '{ $match: { status: "active", age: { $gte: 21 } } }',
    url: `${DOCS}/aggregation/match/`,
  },
  {
    name: '$group',
    class: 'stage',
    summary: 'Group & aggregate values',
    validIn: STAGE,
    description:
      'Groups documents by the _id expression and computes accumulator ' +
      'values for each group. Use _id: null to aggregate across every document.',
    syntax: '{ $group: { _id: <expr>, <field>: { <accumulator>: <expr> }, … } }',
    example:
      '{\n' +
      '  $group: {\n' +
      '    _id: "$status",\n' +
      '    total: { $sum: "$amount" },\n' +
      '    count: { $sum: 1 }\n' +
      '  }\n' +
      '}',
    url: `${DOCS}/aggregation/group/`,
  },
  {
    name: '$sort',
    class: 'stage',
    summary: 'Order documents',
    validIn: STAGE,
    description:
      'Sorts documents by one or more fields. Use 1 for ascending, -1 for ' +
      'descending. For large sorts, ensure an index covers the sort keys.',
    syntax: '{ $sort: { <field1>: 1 | -1, … } }',
    example: '{ $sort: { createdAt: -1, _id: 1 } }',
    url: `${DOCS}/aggregation/sort/`,
  },
  {
    name: '$project',
    class: 'stage',
    summary: 'Reshape documents',
    validIn: STAGE,
    description:
      'Reshapes each document by including, excluding, or computing fields. ' +
      'Mixing inclusion (1) and exclusion (0) in the same stage is invalid, ' +
      'except for _id which can always be excluded.',
    syntax: '{ $project: { <field>: <1|0|expr>, … } }',
    example: '{ $project: { name: 1, total: { $multiply: ["$price", "$qty"] }, _id: 0 } }',
    url: `${DOCS}/aggregation/project/`,
  },
  {
    name: '$addFields',
    class: 'stage',
    summary: 'Add or override fields',
    validIn: STAGE,
    description:
      'Adds new fields to each document without removing existing ones. ' +
      'If a named field already exists, its value is replaced.',
    syntax: '{ $addFields: { <field>: <expr>, … } }',
    example: '{ $addFields: { total: { $multiply: ["$price", "$qty"] } } }',
    url: `${DOCS}/aggregation/addFields/`,
  },
  {
    name: '$set',
    class: 'stage',
    summary: 'Alias for $addFields',
    validIn: STAGE,
    description:
      'Alias for $addFields. Adds new fields or replaces existing ones. ' +
      'Prefer $set when the stage intent is "update a field".',
    syntax: '{ $set: { <field>: <expr>, … } }',
    example: '{ $set: { fullName: { $concat: ["$first", " ", "$last"] } } }',
    url: `${DOCS}/aggregation/set/`,
  },
  {
    name: '$unset',
    class: 'stage',
    summary: 'Remove fields',
    validIn: STAGE,
    description:
      'Removes one or more fields from each document. Accepts a single ' +
      'field name or an array of field names.',
    syntax: '{ $unset: <field> | [<field1>, <field2>, …] }',
    example: '{ $unset: ["password", "internalId"] }',
    url: `${DOCS}/aggregation/unset/`,
  },
  {
    name: '$limit',
    class: 'stage',
    summary: 'Limit result count',
    validIn: STAGE,
    description:
      'Caps the number of documents passed to the next stage. Place after ' +
      '$sort to get top-N results efficiently.',
    syntax: '{ $limit: <positive integer> }',
    example: '{ $limit: 100 }',
    url: `${DOCS}/aggregation/limit/`,
  },
  {
    name: '$skip',
    class: 'stage',
    summary: 'Skip n documents',
    validIn: STAGE,
    description:
      'Discards the first n documents. Typically combined with $sort and ' +
      '$limit for pagination — consider $match with a cursor field instead ' +
      'for large offsets.',
    syntax: '{ $skip: <non-negative integer> }',
    example: '{ $skip: 20 }',
    url: `${DOCS}/aggregation/skip/`,
  },
  {
    name: '$count',
    class: 'stage',
    summary: 'Count matched documents',
    validIn: STAGE,
    description:
      'Counts the documents passed into the stage and returns a single ' +
      'document with the given field name holding the count.',
    syntax: '{ $count: <fieldName> }',
    example: '{ $count: "totalActive" }',
    url: `${DOCS}/aggregation/count/`,
  },
  {
    name: '$lookup',
    class: 'stage',
    summary: 'Left join another collection',
    validIn: STAGE,
    description:
      'Performs a left outer join between the input documents and a ' +
      'foreign collection. Each input document receives an array field ' +
      'containing the matching foreign documents.',
    syntax:
      '{ $lookup: { from: <coll>, localField: <f>, foreignField: <f>, as: <arr> } }',
    example:
      '{\n' +
      '  $lookup: {\n' +
      '    from: "orders",\n' +
      '    localField: "_id",\n' +
      '    foreignField: "customerId",\n' +
      '    as: "orders"\n' +
      '  }\n' +
      '}',
    url: `${DOCS}/aggregation/lookup/`,
  },
  {
    name: '$unwind',
    class: 'stage',
    summary: 'Deconstruct array field',
    validIn: STAGE,
    description:
      'Deconstructs an array field from the input documents to output one ' +
      'document per array element. Set preserveNullAndEmptyArrays: true to ' +
      'keep documents with a missing or empty array.',
    syntax: '{ $unwind: <fieldPath> | { path: <fieldPath>, preserveNullAndEmptyArrays: <bool> } }',
    example: '{ $unwind: { path: "$items", preserveNullAndEmptyArrays: true } }',
    url: `${DOCS}/aggregation/unwind/`,
  },
  {
    name: '$replaceRoot',
    class: 'stage',
    summary: 'Replace root document',
    validIn: STAGE,
    description:
      'Replaces the input document with the document resulting from ' +
      'newRoot. Use to promote a nested subdocument to the top level.',
    syntax: '{ $replaceRoot: { newRoot: <expr> } }',
    example: '{ $replaceRoot: { newRoot: "$profile" } }',
    url: `${DOCS}/aggregation/replaceRoot/`,
  },
  {
    name: '$replaceWith',
    class: 'stage',
    summary: 'Replace root (alias)',
    validIn: STAGE,
    description:
      'Shorthand alias for $replaceRoot. Replaces the root document with ' +
      'the given expression.',
    syntax: '{ $replaceWith: <expr> }',
    example: '{ $replaceWith: "$profile" }',
    url: `${DOCS}/aggregation/replaceWith/`,
  },
  {
    name: '$redact',
    class: 'stage',
    summary: 'Restrict document content',
    validIn: STAGE,
    description:
      'Restricts the content of documents based on per-document access ' +
      'rules. Returns $$KEEP, $$PRUNE, or $$DESCEND to control which ' +
      'subdocuments propagate.',
    syntax: '{ $redact: <expr returning $$KEEP | $$PRUNE | $$DESCEND> }',
    example:
      '{\n' +
      '  $redact: {\n' +
      '    $cond: [\n' +
      '      { $eq: ["$level", "secret"] },\n' +
      '      "$$PRUNE",\n' +
      '      "$$DESCEND"\n' +
      '    ]\n' +
      '  }\n' +
      '}',
    url: `${DOCS}/aggregation/redact/`,
  },
  {
    name: '$out',
    class: 'stage',
    summary: 'Write result to a collection',
    validIn: STAGE,
    description:
      'Writes the pipeline output to the specified collection, replacing ' +
      'its contents. Must be the final stage. Use $merge when you need to ' +
      'upsert into an existing collection.',
    syntax: '{ $out: <collection> | { db: <dbName>, coll: <collection> } }',
    example: '{ $out: "reportMonthly" }',
    url: `${DOCS}/aggregation/out/`,
  },
  {
    name: '$merge',
    class: 'stage',
    summary: 'Merge result into a collection',
    validIn: STAGE,
    description:
      'Writes the pipeline output into an existing collection, matching on ' +
      'the given key(s) and choosing how to handle matches and non-matches. ' +
      'Must be the final stage.',
    syntax:
      '{ $merge: { into: <coll>, on: <field(s)>, whenMatched: <action>, whenNotMatched: <action> } }',
    example:
      '{\n' +
      '  $merge: {\n' +
      '    into: "users",\n' +
      '    on: "_id",\n' +
      '    whenMatched: "merge",\n' +
      '    whenNotMatched: "insert"\n' +
      '  }\n' +
      '}',
    url: `${DOCS}/aggregation/merge/`,
  },
  {
    name: '$facet',
    class: 'stage',
    summary: 'Run sub-pipelines in parallel',
    validIn: STAGE,
    description:
      'Runs multiple sub-pipelines over the same input set and returns ' +
      'a single document with one array per sub-pipeline. Useful for ' +
      'computing facets alongside a main result.',
    syntax: '{ $facet: { <name>: [<sub-pipeline>], … } }',
    example:
      '{\n' +
      '  $facet: {\n' +
      '    byCategory: [{ $group: { _id: "$category", n: { $sum: 1 } } }],\n' +
      '    topPriced: [{ $sort: { price: -1 } }, { $limit: 5 }]\n' +
      '  }\n' +
      '}',
    url: `${DOCS}/aggregation/facet/`,
  },
  {
    name: '$bucket',
    class: 'stage',
    summary: 'Group by value boundaries',
    validIn: STAGE,
    description:
      'Groups documents into buckets defined by explicit boundaries. ' +
      'A default bucket collects documents outside the boundaries.',
    syntax:
      '{ $bucket: { groupBy: <expr>, boundaries: [<v1>, <v2>, …], default: <any>, output: { … } } }',
    example:
      '{\n' +
      '  $bucket: {\n' +
      '    groupBy: "$age",\n' +
      '    boundaries: [0, 18, 35, 65, 120],\n' +
      '    default: "unknown",\n' +
      '    output: { count: { $sum: 1 } }\n' +
      '  }\n' +
      '}',
    url: `${DOCS}/aggregation/bucket/`,
  },
  {
    name: '$bucketAuto',
    class: 'stage',
    summary: 'Auto-group into N buckets',
    validIn: STAGE,
    description:
      'Automatically computes bucket boundaries to produce approximately ' +
      'evenly-distributed buckets. Useful for histogram-style summaries.',
    syntax: '{ $bucketAuto: { groupBy: <expr>, buckets: <n>, output: { … }, granularity: <preset> } }',
    example:
      '{\n' +
      '  $bucketAuto: {\n' +
      '    groupBy: "$price",\n' +
      '    buckets: 4,\n' +
      '    output: { count: { $sum: 1 } }\n' +
      '  }\n' +
      '}',
    url: `${DOCS}/aggregation/bucketAuto/`,
  },
  {
    name: '$sample',
    class: 'stage',
    summary: 'Random sample of documents',
    validIn: STAGE,
    description:
      'Randomly selects the specified number of documents from the input. ' +
      'Uses a pseudo-random algorithm; the sample varies between runs.',
    syntax: '{ $sample: { size: <n> } }',
    example: '{ $sample: { size: 50 } }',
    url: `${DOCS}/aggregation/sample/`,
  },
  {
    name: '$sortByCount',
    class: 'stage',
    summary: 'Group by value & sort by count',
    validIn: STAGE,
    description:
      'Groups incoming documents by the given expression and sorts the ' +
      'groups by count descending. Shortcut for $group + $sort.',
    syntax: '{ $sortByCount: <expr> }',
    example: '{ $sortByCount: "$category" }',
    url: `${DOCS}/aggregation/sortByCount/`,
  },
  {
    name: '$setWindowFields',
    class: 'stage',
    summary: 'Compute over document windows',
    validIn: STAGE,
    description:
      'Computes window-function output fields over documents partitioned ' +
      'by an expression and sorted by another. Powers moving averages, ' +
      'running totals, rank, and time-series analysis.',
    syntax:
      '{ $setWindowFields: { partitionBy: <expr>, sortBy: { … }, output: { <field>: { <windowOp>: <expr>, window: { … } } } } }',
    example:
      '{\n' +
      '  $setWindowFields: {\n' +
      '    partitionBy: "$userId",\n' +
      '    sortBy: { ts: 1 },\n' +
      '    output: { running: { $sum: "$amount", window: { documents: ["unbounded", "current"] } } }\n' +
      '  }\n' +
      '}',
    url: `${DOCS}/aggregation/setWindowFields/`,
  },
  {
    name: '$graphLookup',
    class: 'stage',
    summary: 'Recursive graph traversal',
    validIn: STAGE,
    description:
      'Performs a recursive search on a collection, following references ' +
      'from one document to another. Useful for hierarchies and graphs.',
    syntax:
      '{ $graphLookup: { from: <coll>, startWith: <expr>, connectFromField: <f>, connectToField: <f>, as: <arr>, maxDepth: <n> } }',
    example:
      '{\n' +
      '  $graphLookup: {\n' +
      '    from: "employees",\n' +
      '    startWith: "$reportsTo",\n' +
      '    connectFromField: "reportsTo",\n' +
      '    connectToField: "_id",\n' +
      '    as: "managerChain"\n' +
      '  }\n' +
      '}',
    url: `${DOCS}/aggregation/graphLookup/`,
  },
  {
    name: '$unionWith',
    class: 'stage',
    summary: 'Union with another collection',
    validIn: STAGE,
    description:
      'Combines the results from another collection or pipeline with the ' +
      'current pipeline. Duplicates are preserved.',
    syntax: '{ $unionWith: <coll> | { coll: <coll>, pipeline: [<stage>, …] } }',
    example: '{ $unionWith: { coll: "archive", pipeline: [{ $match: { year: 2023 } }] } }',
    url: `${DOCS}/aggregation/unionWith/`,
  },
  {
    name: '$densify',
    class: 'stage',
    summary: 'Fill in missing range values',
    validIn: STAGE,
    description:
      'Creates new documents in a numeric or date range where documents ' +
      'are missing. Useful for producing continuous time series.',
    syntax: '{ $densify: { field: <f>, range: { step: <n>, unit: <unit>, bounds: <range> } } }',
    example:
      '{\n' +
      '  $densify: {\n' +
      '    field: "ts",\n' +
      '    range: { step: 1, unit: "hour", bounds: "full" }\n' +
      '  }\n' +
      '}',
    url: `${DOCS}/aggregation/densify/`,
  },
  {
    name: '$fill',
    class: 'stage',
    summary: 'Fill null / missing values',
    validIn: STAGE,
    description:
      'Populates null and missing field values in documents. Supports ' +
      'last-observation-carried-forward, linear interpolation, and literal ' +
      'fill values.',
    syntax:
      '{ $fill: { sortBy: { … }, output: { <field>: { method: "locf" | "linear" } | { value: <expr> } } } }',
    example:
      '{\n' +
      '  $fill: {\n' +
      '    sortBy: { ts: 1 },\n' +
      '    output: { temperature: { method: "linear" } }\n' +
      '  }\n' +
      '}',
    url: `${DOCS}/aggregation/fill/`,
  },
  {
    name: '$search',
    class: 'stage',
    summary: 'Atlas full-text search',
    validIn: STAGE,
    description:
      'Performs a full-text search using Atlas Search. Requires a configured ' +
      'Atlas Search index on the collection. Must be the first stage.',
    syntax: '{ $search: { index: <name>, <operator>: { … } } }',
    example:
      '{\n' +
      '  $search: {\n' +
      '    index: "default",\n' +
      '    text: { query: "mongodb", path: "description" }\n' +
      '  }\n' +
      '}',
    url: 'https://www.mongodb.com/docs/atlas/atlas-search/query-syntax/',
  },
  {
    name: '$searchMeta',
    class: 'stage',
    summary: 'Atlas search metadata',
    validIn: STAGE,
    description:
      'Returns metadata (counts, facets) about an Atlas Search query ' +
      'without returning the matching documents.',
    syntax: '{ $searchMeta: { index: <name>, <operator>: { … } } }',
    example: '{ $searchMeta: { index: "default", facet: { operator: { text: { query: "mongo", path: "title" } } } } }',
    url: 'https://www.mongodb.com/docs/atlas/atlas-search/query-syntax/#-searchmeta-stage',
  },
  {
    name: '$vectorSearch',
    class: 'stage',
    summary: 'Atlas vector search',
    validIn: STAGE,
    description:
      'Performs an approximate nearest-neighbour vector search using an ' +
      'Atlas Vector Search index. Must be the first stage.',
    syntax:
      '{ $vectorSearch: { index: <name>, path: <field>, queryVector: [<n>, …], numCandidates: <n>, limit: <n> } }',
    example:
      '{\n' +
      '  $vectorSearch: {\n' +
      '    index: "embeddings",\n' +
      '    path: "embedding",\n' +
      '    queryVector: [0.12, -0.08, 0.44],\n' +
      '    numCandidates: 100,\n' +
      '    limit: 10\n' +
      '  }\n' +
      '}',
    url: 'https://www.mongodb.com/docs/atlas/atlas-vector-search/vector-search-stage/',
  },
  {
    name: '$geoNear',
    class: 'stage',
    summary: 'Sort by distance from a point',
    validIn: STAGE,
    description:
      'Returns documents ordered by distance from a GeoJSON point or ' +
      'legacy coordinates. Requires a geospatial index; must be the first ' +
      'stage.',
    syntax:
      '{ $geoNear: { near: <point>, distanceField: <f>, spherical: <bool>, maxDistance: <m>, query: <q> } }',
    example:
      '{\n' +
      '  $geoNear: {\n' +
      '    near: { type: "Point", coordinates: [-73.99, 40.75] },\n' +
      '    distanceField: "distance",\n' +
      '    spherical: true\n' +
      '  }\n' +
      '}',
    url: `${DOCS}/aggregation/geoNear/`,
  },
  {
    name: '$collStats',
    class: 'stage',
    summary: 'Collection storage statistics',
    validIn: STAGE,
    description:
      'Returns storage statistics for the collection. Must be the first ' +
      'stage.',
    syntax: '{ $collStats: { latencyStats: { … }, storageStats: { … }, count: { … } } }',
    example: '{ $collStats: { storageStats: {} } }',
    url: `${DOCS}/aggregation/collStats/`,
  },
  {
    name: '$indexStats',
    class: 'stage',
    summary: 'Per-index usage statistics',
    validIn: STAGE,
    description:
      'Returns statistics for each index on the collection, including ' +
      'usage counters since the server started.',
    syntax: '{ $indexStats: { } }',
    example: '{ $indexStats: {} }',
    url: `${DOCS}/aggregation/indexStats/`,
  },
  {
    name: '$currentOp',
    class: 'stage',
    summary: 'List current operations',
    validIn: STAGE,
    description:
      'Returns information about in-progress operations. Admin-only.',
    syntax: '{ $currentOp: { allUsers: <bool>, idleConnections: <bool> } }',
    example: '{ $currentOp: { allUsers: true } }',
    url: `${DOCS}/aggregation/currentOp/`,
  },
  {
    name: '$listLocalSessions',
    class: 'stage',
    summary: 'List local cached sessions',
    validIn: STAGE,
    description:
      'Lists the sessions cached in memory on the node to which the ' +
      'command is sent.',
    syntax: '{ $listLocalSessions: { allUsers: <bool> } }',
    example: '{ $listLocalSessions: {} }',
    url: `${DOCS}/aggregation/listLocalSessions/`,
  },
  {
    name: '$listSessions',
    class: 'stage',
    summary: 'List all cluster sessions',
    validIn: STAGE,
    description:
      'Lists sessions persisted in the config.system.sessions collection.',
    syntax: '{ $listSessions: { allUsers: <bool> } }',
    example: '{ $listSessions: { allUsers: true } }',
    url: `${DOCS}/aggregation/listSessions/`,
  },
  {
    name: '$planCacheStats',
    class: 'stage',
    summary: 'Plan cache statistics',
    validIn: STAGE,
    description:
      'Returns information about the plan cache for the collection.',
    syntax: '{ $planCacheStats: { } }',
    example: '{ $planCacheStats: {} }',
    url: `${DOCS}/aggregation/planCacheStats/`,
  },
  {
    name: '$changeStream',
    class: 'stage',
    summary: 'Open a change stream',
    validIn: STAGE,
    description:
      'Returns a change stream cursor over the collection, database, or ' +
      'cluster. Must be the first stage.',
    syntax: '{ $changeStream: { fullDocument: "updateLookup", startAtOperationTime: <ts> } }',
    example: '{ $changeStream: { fullDocument: "updateLookup" } }',
    url: `${DOCS}/aggregation/changeStream/`,
  },
  {
    name: '$documents',
    class: 'stage',
    summary: 'Literal documents as input',
    validIn: STAGE,
    description:
      'Injects a literal array of documents into the pipeline. Useful as ' +
      'the first stage when querying without a source collection.',
    syntax: '{ $documents: [<doc1>, <doc2>, …] }',
    example: '{ $documents: [{ n: 1 }, { n: 2 }, { n: 3 }] }',
    url: `${DOCS}/aggregation/documents/`,
  },
  {
    name: '$shardedDataDistribution',
    class: 'stage',
    summary: 'Sharded collection distribution',
    validIn: STAGE,
    description:
      'Returns information about the distribution of data across shards ' +
      'for a sharded collection.',
    syntax: '{ $shardedDataDistribution: { } }',
    example: '{ $shardedDataDistribution: {} }',
    url: `${DOCS}/aggregation/shardedDataDistribution/`,
  },
];

// ─── Query operators (comparison / element / evaluation / array / geo) ────
const QUERY: readonly OperatorDef[] = [
  // comparison
  {
    name: '$eq',
    class: 'query',
    validIn: MATCH,
    description:
      'Matches documents where the field value equals the given value. ' +
      'Also used implicitly when a match filter uses plain { field: value }.',
    syntax: '{ field: { $eq: <value> } }',
    example: '{ status: { $eq: "active" } }',
    url: `${DOCS}/query/eq/`,
  },
  {
    name: '$ne',
    class: 'query',
    validIn: MATCH,
    description:
      'Matches documents where the field value does not equal the given ' +
      'value. Also matches documents where the field is missing.',
    syntax: '{ field: { $ne: <value> } }',
    example: '{ status: { $ne: "archived" } }',
    url: `${DOCS}/query/ne/`,
  },
  {
    name: '$gt',
    class: 'query',
    validIn: MATCH,
    description: 'Matches documents where the field value is strictly greater than the given value.',
    syntax: '{ field: { $gt: <value> } }',
    example: '{ age: { $gt: 17 } }',
    url: `${DOCS}/query/gt/`,
  },
  {
    name: '$gte',
    class: 'query',
    validIn: MATCH,
    description: 'Matches documents where the field value is greater than or equal to the given value.',
    syntax: '{ field: { $gte: <value> } }',
    example: '{ age: { $gte: 18 } }',
    url: `${DOCS}/query/gte/`,
  },
  {
    name: '$lt',
    class: 'query',
    validIn: MATCH,
    description: 'Matches documents where the field value is strictly less than the given value.',
    syntax: '{ field: { $lt: <value> } }',
    example: '{ price: { $lt: 100 } }',
    url: `${DOCS}/query/lt/`,
  },
  {
    name: '$lte',
    class: 'query',
    validIn: MATCH,
    description: 'Matches documents where the field value is less than or equal to the given value.',
    syntax: '{ field: { $lte: <value> } }',
    example: '{ price: { $lte: 99.99 } }',
    url: `${DOCS}/query/lte/`,
  },
  {
    name: '$in',
    class: 'query',
    validIn: MATCH,
    description:
      'Matches documents where the field value equals any value in the ' +
      'given array. The array must be a literal — to compare against ' +
      'another field, use $expr with { $in: [<expr>, <array>] }.',
    syntax: '{ field: { $in: [<v1>, <v2>, …] } }',
    example: '{ status: { $in: ["active", "pending"] } }',
    url: `${DOCS}/query/in/`,
  },
  {
    name: '$nin',
    class: 'query',
    validIn: MATCH,
    description:
      'Matches documents where the field value is not in the given array, ' +
      'including documents where the field is missing.',
    syntax: '{ field: { $nin: [<v1>, <v2>, …] } }',
    example: '{ status: { $nin: ["archived", "deleted"] } }',
    url: `${DOCS}/query/nin/`,
  },
  // logical
  {
    name: '$and',
    class: 'logical',
    validIn: MATCH,
    description:
      'Joins query clauses with a logical AND. All clauses must match. ' +
      'Implicit when multiple fields appear in the same query document.',
    syntax: '{ $and: [<clause1>, <clause2>, …] }',
    example: '{ $and: [{ status: "active" }, { age: { $gte: 18 } }] }',
    url: `${DOCS}/query/and/`,
  },
  {
    name: '$or',
    class: 'logical',
    validIn: MATCH,
    description: 'Joins query clauses with a logical OR. A document matches if any clause matches.',
    syntax: '{ $or: [<clause1>, <clause2>, …] }',
    example: '{ $or: [{ status: "active" }, { trial: true }] }',
    url: `${DOCS}/query/or/`,
  },
  {
    name: '$not',
    class: 'logical',
    validIn: MATCH,
    description:
      'Inverts the effect of a query expression. Applied to a field-level ' +
      'expression — not a whole query document.',
    syntax: '{ field: { $not: <expr> } }',
    example: '{ age: { $not: { $gte: 18 } } }',
    url: `${DOCS}/query/not/`,
  },
  {
    name: '$nor',
    class: 'logical',
    validIn: MATCH,
    description: 'Joins query clauses with a logical NOR. A document matches if no clause matches.',
    syntax: '{ $nor: [<clause1>, <clause2>, …] }',
    example: '{ $nor: [{ status: "archived" }, { banned: true }] }',
    url: `${DOCS}/query/nor/`,
  },
  // element
  {
    name: '$exists',
    class: 'element',
    validIn: MATCH,
    description:
      'Matches documents based on the presence or absence of a field. ' +
      'Use with true to match when present, false to match when missing.',
    syntax: '{ field: { $exists: <boolean> } }',
    example: '{ deletedAt: { $exists: false } }',
    url: `${DOCS}/query/exists/`,
  },
  {
    name: '$type',
    class: 'element',
    validIn: MATCH,
    description:
      'Matches documents where the field is one of the listed BSON types. ' +
      'Accepts BSON type numbers or alias strings ("string", "number", ' +
      '"date", "objectId", etc.).',
    syntax: '{ field: { $type: <typeAlias> | [<alias1>, <alias2>, …] } }',
    example: '{ createdAt: { $type: "date" } }',
    url: `${DOCS}/query/type/`,
  },
  // evaluation
  {
    name: '$expr',
    class: 'evaluation',
    validIn: ['matchKey', 'projectValue', 'addFieldsValue', 'groupValue'],
    description:
      'Allows using an aggregation expression inside a query. Required ' +
      'when comparing two fields from the same document.',
    syntax: '{ $expr: <aggregation expression> }',
    example: '{ $expr: { $gt: ["$spent", "$budget"] } }',
    url: `${DOCS}/query/expr/`,
  },
  {
    name: '$jsonSchema',
    class: 'evaluation',
    validIn: MATCH,
    description:
      'Matches documents that satisfy the given JSON Schema. Most ' +
      'commonly used in collection validation rules.',
    syntax: '{ $jsonSchema: <schema> }',
    example:
      '{\n' +
      '  $jsonSchema: {\n' +
      '    bsonType: "object",\n' +
      '    required: ["email"],\n' +
      '    properties: { email: { bsonType: "string" } }\n' +
      '  }\n' +
      '}',
    url: `${DOCS}/query/jsonSchema/`,
  },
  {
    name: '$mod',
    class: 'evaluation',
    validIn: MATCH,
    description:
      'Matches documents where the field value, divided by the divisor, ' +
      'has the specified remainder. Takes a length-2 array: [divisor, remainder].',
    syntax: '{ field: { $mod: [<divisor>, <remainder>] } }',
    example: '{ count: { $mod: [4, 0] } }',
    url: `${DOCS}/query/mod/`,
  },
  {
    name: '$regex',
    class: 'evaluation',
    validIn: MATCH,
    description:
      'Matches documents where the string field matches the given regex. ' +
      'Anchor with ^ / $ for full-string matches. Case-insensitive mode is ' +
      'enabled via the $options "i" flag.',
    syntax: '{ field: { $regex: <pattern>, $options: <flags> } }',
    example: '{ email: { $regex: "@example\\.com$", $options: "i" } }',
    url: `${DOCS}/query/regex/`,
  },
  {
    name: '$text',
    class: 'evaluation',
    validIn: MATCH,
    description:
      'Performs a text search using the collection\'s text index. Only one ' +
      'text index is allowed per collection.',
    syntax: '{ $text: { $search: <query>, $language: <lang>, $caseSensitive: <bool> } }',
    example: '{ $text: { $search: "coffee shop" } }',
    url: `${DOCS}/query/text/`,
  },
  {
    name: '$where',
    class: 'evaluation',
    validIn: MATCH,
    description:
      'Matches documents against a JavaScript expression. Slow — prefer ' +
      '$expr when possible. Not available on serverless or Atlas free tier.',
    syntax: '{ $where: <JS function or string> }',
    example: '{ $where: "this.credits === this.debits" }',
    url: `${DOCS}/query/where/`,
  },
  {
    name: '$bitsAllClear',
    class: 'evaluation',
    validIn: MATCH,
    description: 'Matches numeric or binary values where all the given bit positions are clear (0).',
    syntax: '{ field: { $bitsAllClear: <bitmask> | [<pos>, …] } }',
    example: '{ flags: { $bitsAllClear: [1, 3] } }',
    url: `${DOCS}/query/bitsAllClear/`,
  },
  {
    name: '$bitsAllSet',
    class: 'evaluation',
    validIn: MATCH,
    description: 'Matches numeric or binary values where all the given bit positions are set (1).',
    syntax: '{ field: { $bitsAllSet: <bitmask> | [<pos>, …] } }',
    example: '{ flags: { $bitsAllSet: [0, 2] } }',
    url: `${DOCS}/query/bitsAllSet/`,
  },
  {
    name: '$bitsAnyClear',
    class: 'evaluation',
    validIn: MATCH,
    description: 'Matches numeric or binary values where any of the given bit positions are clear (0).',
    syntax: '{ field: { $bitsAnyClear: <bitmask> | [<pos>, …] } }',
    example: '{ flags: { $bitsAnyClear: [1, 3] } }',
    url: `${DOCS}/query/bitsAnyClear/`,
  },
  {
    name: '$bitsAnySet',
    class: 'evaluation',
    validIn: MATCH,
    description: 'Matches numeric or binary values where any of the given bit positions are set (1).',
    syntax: '{ field: { $bitsAnySet: <bitmask> | [<pos>, …] } }',
    example: '{ flags: { $bitsAnySet: [0, 2] } }',
    url: `${DOCS}/query/bitsAnySet/`,
  },
  // array
  {
    name: '$all',
    class: 'array',
    validIn: MATCH,
    description: 'Matches arrays that contain all the listed elements, in any order.',
    syntax: '{ field: { $all: [<v1>, <v2>, …] } }',
    example: '{ tags: { $all: ["mongo", "database"] } }',
    url: `${DOCS}/query/all/`,
  },
  {
    name: '$elemMatch',
    class: 'array',
    validIn: MATCH,
    description:
      'Matches arrays that contain at least one element matching all of ' +
      'the specified sub-conditions. Required when multiple conditions ' +
      'must apply to the same element.',
    syntax: '{ field: { $elemMatch: <sub-query> } }',
    example: '{ scores: { $elemMatch: { $gte: 80, $lt: 90 } } }',
    url: `${DOCS}/query/elemMatch/`,
  },
  {
    name: '$size',
    class: 'array',
    validIn: MATCH,
    description:
      'Matches arrays with exactly the given number of elements. Does ' +
      'not support comparison — use $expr + $size (expression) for ranges.',
    syntax: '{ field: { $size: <n> } }',
    example: '{ comments: { $size: 0 } }',
    url: `${DOCS}/query/size/`,
  },
  // geo
  {
    name: '$geoWithin',
    class: 'geo',
    validIn: MATCH,
    description:
      'Matches documents with geospatial data that falls entirely within ' +
      'the specified shape.',
    syntax: '{ field: { $geoWithin: { $geometry: <GeoJSON polygon> } } }',
    example:
      '{\n' +
      '  location: {\n' +
      '    $geoWithin: {\n' +
      '      $geometry: { type: "Polygon", coordinates: [[[-74,40],[-74,41],[-73,41],[-73,40],[-74,40]]] }\n' +
      '    }\n' +
      '  }\n' +
      '}',
    url: `${DOCS}/query/geoWithin/`,
  },
  {
    name: '$geoIntersects',
    class: 'geo',
    validIn: MATCH,
    description:
      'Matches documents with geospatial data that intersects the given ' +
      'GeoJSON geometry.',
    syntax: '{ field: { $geoIntersects: { $geometry: <GeoJSON> } } }',
    example:
      '{ route: { $geoIntersects: { $geometry: { type: "Point", coordinates: [-73.99, 40.75] } } } }',
    url: `${DOCS}/query/geoIntersects/`,
  },
  {
    name: '$near',
    class: 'geo',
    validIn: MATCH,
    description:
      'Returns documents ordered by distance from the given point. ' +
      'Requires a 2dsphere or 2d index on the field.',
    syntax: '{ field: { $near: { $geometry: <GeoJSON point>, $maxDistance: <m>, $minDistance: <m> } } }',
    example:
      '{ location: { $near: { $geometry: { type: "Point", coordinates: [-73.99, 40.75] }, $maxDistance: 500 } } }',
    url: `${DOCS}/query/near/`,
  },
  {
    name: '$nearSphere',
    class: 'geo',
    validIn: MATCH,
    description:
      'Like $near but always uses spherical geometry. Preferred for ' +
      '2dsphere indexes on GeoJSON fields.',
    syntax: '{ field: { $nearSphere: { $geometry: <GeoJSON point>, $maxDistance: <m> } } }',
    example:
      '{ location: { $nearSphere: { $geometry: { type: "Point", coordinates: [-73.99, 40.75] }, $maxDistance: 1000 } } }',
    url: `${DOCS}/query/nearSphere/`,
  },
  {
    name: '$geometry',
    class: 'geo',
    validIn: MATCH,
    description:
      'Specifies the GeoJSON geometry for a geospatial query. Used as a ' +
      'child of $geoWithin, $geoIntersects, $near, and $nearSphere.',
    syntax: '{ $geometry: { type: <geoType>, coordinates: <coords> } }',
    example: '{ $geometry: { type: "Point", coordinates: [-73.99, 40.75] } }',
    url: `${DOCS}/query/geometry/`,
  },
  {
    name: '$box',
    class: 'geo',
    validIn: MATCH,
    description:
      'Specifies a rectangle for $geoWithin using legacy coordinates. ' +
      'Requires a 2d index.',
    syntax: '{ $box: [[<x1>, <y1>], [<x2>, <y2>]] }',
    example: '{ location: { $geoWithin: { $box: [[-74, 40], [-73, 41]] } } }',
    url: `${DOCS}/query/box/`,
  },
  {
    name: '$center',
    class: 'geo',
    validIn: MATCH,
    description: 'Specifies a flat circle for $geoWithin using legacy coordinates.',
    syntax: '{ $center: [[<x>, <y>], <radius>] }',
    example: '{ location: { $geoWithin: { $center: [[-73.99, 40.75], 0.5] } } }',
    url: `${DOCS}/query/center/`,
  },
  {
    name: '$centerSphere',
    class: 'geo',
    validIn: MATCH,
    description:
      'Specifies a circle on a sphere for $geoWithin. Radius is in ' +
      'radians (divide kilometres by 6371 to convert).',
    syntax: '{ $centerSphere: [[<lng>, <lat>], <radiusInRadians>] }',
    example: '{ location: { $geoWithin: { $centerSphere: [[-73.99, 40.75], 0.0008] } } }',
    url: `${DOCS}/query/centerSphere/`,
  },
  {
    name: '$polygon',
    class: 'geo',
    validIn: MATCH,
    description: 'Specifies a polygon for $geoWithin using legacy coordinates.',
    syntax: '{ $polygon: [[<x1>, <y1>], [<x2>, <y2>], …] }',
    example: '{ location: { $geoWithin: { $polygon: [[-74, 40], [-73, 40], [-73, 41], [-74, 41]] } } }',
    url: `${DOCS}/query/polygon/`,
  },
  {
    name: '$minDistance',
    class: 'geo',
    validIn: MATCH,
    description:
      'Filters $near / $nearSphere results to points at least the given ' +
      'distance away. Distance is in metres for GeoJSON, radians for legacy.',
    syntax: '{ $minDistance: <meters> }',
    example: '{ location: { $near: { $geometry: { type: "Point", coordinates: [-73.99, 40.75] }, $minDistance: 100 } } }',
    url: `${DOCS}/query/minDistance/`,
  },
  {
    name: '$maxDistance',
    class: 'geo',
    validIn: MATCH,
    description:
      'Caps $near / $nearSphere results at the given distance. Distance ' +
      'is in metres for GeoJSON, radians for legacy coordinates.',
    syntax: '{ $maxDistance: <meters> }',
    example: '{ location: { $near: { $geometry: { type: "Point", coordinates: [-73.99, 40.75] }, $maxDistance: 500 } } }',
    url: `${DOCS}/query/maxDistance/`,
  },
];

// ─── Accumulators (group/setWindowFields) ─────────────────────────────────
const ACCUMULATORS: readonly OperatorDef[] = [
  {
    name: '$sum',
    class: 'accumulator',
    validIn: GROUP,
    description:
      'Returns the sum of numeric expressions across the group. Use ' +
      '{ $sum: 1 } to count documents.',
    syntax: '{ $sum: <expr> }',
    example: '{ totalAmount: { $sum: "$amount" } }',
    url: `${DOCS}/aggregation/sum/`,
  },
  {
    name: '$avg',
    class: 'accumulator',
    validIn: GROUP,
    description: 'Returns the average of numeric expressions across the group. Ignores non-numeric values.',
    syntax: '{ $avg: <expr> }',
    example: '{ avgScore: { $avg: "$score" } }',
    url: `${DOCS}/aggregation/avg/`,
  },
  {
    name: '$min',
    class: 'accumulator',
    validIn: GROUP,
    description: 'Returns the minimum value of the expression across the group.',
    syntax: '{ $min: <expr> }',
    example: '{ earliest: { $min: "$createdAt" } }',
    url: `${DOCS}/aggregation/min/`,
  },
  {
    name: '$max',
    class: 'accumulator',
    validIn: GROUP,
    description: 'Returns the maximum value of the expression across the group.',
    syntax: '{ $max: <expr> }',
    example: '{ highest: { $max: "$price" } }',
    url: `${DOCS}/aggregation/max/`,
  },
  {
    name: '$first',
    class: 'accumulator',
    validIn: GROUP,
    description:
      'Returns the value from the first document in the group. Order ' +
      'depends on a preceding $sort stage.',
    syntax: '{ $first: <expr> }',
    example: '{ firstName: { $first: "$name" } }',
    url: `${DOCS}/aggregation/first/`,
  },
  {
    name: '$last',
    class: 'accumulator',
    validIn: GROUP,
    description:
      'Returns the value from the last document in the group. Order ' +
      'depends on a preceding $sort stage.',
    syntax: '{ $last: <expr> }',
    example: '{ lastSeen: { $last: "$ts" } }',
    url: `${DOCS}/aggregation/last/`,
  },
  {
    name: '$firstN',
    class: 'accumulator',
    validIn: GROUP,
    description: 'Returns an array of the first N values in the group.',
    syntax: '{ $firstN: { input: <expr>, n: <n> } }',
    example: '{ firstThree: { $firstN: { input: "$name", n: 3 } } }',
    url: `${DOCS}/aggregation/firstN/`,
  },
  {
    name: '$lastN',
    class: 'accumulator',
    validIn: GROUP,
    description: 'Returns an array of the last N values in the group.',
    syntax: '{ $lastN: { input: <expr>, n: <n> } }',
    example: '{ lastThree: { $lastN: { input: "$name", n: 3 } } }',
    url: `${DOCS}/aggregation/lastN/`,
  },
  {
    name: '$top',
    class: 'accumulator',
    validIn: GROUP,
    description:
      'Returns the top-ranked value in each group, ranked by the sortBy ' +
      'specification. Used in $group.',
    syntax: '{ $top: { sortBy: { <field>: 1|-1 }, output: <expr> } }',
    example: '{ leader: { $top: { sortBy: { score: -1 }, output: "$name" } } }',
    url: `${DOCS}/aggregation/top/`,
  },
  {
    name: '$topN',
    class: 'accumulator',
    validIn: GROUP,
    description: 'Returns an array of the top-N ranked values in each group.',
    syntax: '{ $topN: { n: <n>, sortBy: { … }, output: <expr> } }',
    example: '{ topThree: { $topN: { n: 3, sortBy: { score: -1 }, output: "$name" } } }',
    url: `${DOCS}/aggregation/topN/`,
  },
  {
    name: '$bottom',
    class: 'accumulator',
    validIn: GROUP,
    description: 'Returns the bottom-ranked value in each group, ranked by the sortBy specification.',
    syntax: '{ $bottom: { sortBy: { <field>: 1|-1 }, output: <expr> } }',
    example: '{ slowest: { $bottom: { sortBy: { timeMs: 1 }, output: "$name" } } }',
    url: `${DOCS}/aggregation/bottom/`,
  },
  {
    name: '$bottomN',
    class: 'accumulator',
    validIn: GROUP,
    description: 'Returns an array of the bottom-N ranked values in each group.',
    syntax: '{ $bottomN: { n: <n>, sortBy: { … }, output: <expr> } }',
    example: '{ bottomThree: { $bottomN: { n: 3, sortBy: { score: 1 }, output: "$name" } } }',
    url: `${DOCS}/aggregation/bottomN/`,
  },
  {
    name: '$push',
    class: 'accumulator',
    validIn: GROUP,
    description:
      'Returns an array of all values of the expression for each document ' +
      'in the group, preserving duplicates and order.',
    syntax: '{ $push: <expr> }',
    example: '{ allTags: { $push: "$tag" } }',
    url: `${DOCS}/aggregation/push/`,
  },
  {
    name: '$addToSet',
    class: 'accumulator',
    validIn: GROUP,
    description:
      'Returns an array of unique values of the expression across the ' +
      'group. Order is not guaranteed.',
    syntax: '{ $addToSet: <expr> }',
    example: '{ uniqueTags: { $addToSet: "$tag" } }',
    url: `${DOCS}/aggregation/addToSet/`,
  },
  {
    name: '$count',
    class: 'accumulator',
    validIn: GROUP,
    description:
      'Returns the count of documents in the group. Equivalent to ' +
      '{ $sum: 1 } but reads more clearly.',
    syntax: '{ $count: { } }',
    example: '{ total: { $count: {} } }',
    url: `${DOCS}/aggregation/count-accumulator/`,
  },
  {
    name: '$mergeObjects',
    class: 'accumulator',
    validIn: GROUP,
    description:
      'Combines multiple documents into a single document, with later ' +
      'values overriding earlier ones for the same keys.',
    syntax: '{ $mergeObjects: <expr> }',
    example: '{ merged: { $mergeObjects: "$attrs" } }',
    url: `${DOCS}/aggregation/mergeObjects/`,
  },
  {
    name: '$stdDevPop',
    class: 'accumulator',
    validIn: GROUP,
    description: 'Returns the population standard deviation of the expression values.',
    syntax: '{ $stdDevPop: <expr> }',
    example: '{ scoreStdDev: { $stdDevPop: "$score" } }',
    url: `${DOCS}/aggregation/stdDevPop/`,
  },
  {
    name: '$stdDevSamp',
    class: 'accumulator',
    validIn: GROUP,
    description: 'Returns the sample standard deviation of the expression values.',
    syntax: '{ $stdDevSamp: <expr> }',
    example: '{ scoreStdDev: { $stdDevSamp: "$score" } }',
    url: `${DOCS}/aggregation/stdDevSamp/`,
  },
  {
    name: '$covariancePop',
    class: 'accumulator',
    validIn: GROUP,
    description: 'Returns the population covariance of two numeric expressions. Window-function only.',
    syntax: '{ $covariancePop: [<expr1>, <expr2>] }',
    example: '{ cov: { $covariancePop: ["$x", "$y"] } }',
    url: `${DOCS}/aggregation/covariancePop/`,
  },
  {
    name: '$covarianceSamp',
    class: 'accumulator',
    validIn: GROUP,
    description: 'Returns the sample covariance of two numeric expressions. Window-function only.',
    syntax: '{ $covarianceSamp: [<expr1>, <expr2>] }',
    example: '{ cov: { $covarianceSamp: ["$x", "$y"] } }',
    url: `${DOCS}/aggregation/covarianceSamp/`,
  },
  {
    name: '$percentile',
    class: 'accumulator',
    validIn: GROUP,
    description:
      'Returns values at the specified percentiles. Uses approximate ' +
      'methods to control memory.',
    syntax: '{ $percentile: { input: <expr>, p: [<p1>, <p2>, …], method: "approximate" } }',
    example: '{ pctl: { $percentile: { input: "$score", p: [0.5, 0.9, 0.99], method: "approximate" } } }',
    url: `${DOCS}/aggregation/percentile/`,
  },
  {
    name: '$median',
    class: 'accumulator',
    validIn: GROUP,
    description: 'Returns the approximate median of numeric expressions.',
    syntax: '{ $median: { input: <expr>, method: "approximate" } }',
    example: '{ medianScore: { $median: { input: "$score", method: "approximate" } } }',
    url: `${DOCS}/aggregation/median/`,
  },
  {
    name: '$accumulator',
    class: 'accumulator',
    validIn: GROUP,
    description:
      'Defines a custom accumulator with JavaScript init/accumulate/merge/' +
      'finalize functions. Requires server-side scripting.',
    syntax: '{ $accumulator: { init: <fn>, accumulate: <fn>, accumulateArgs: [<expr>], merge: <fn>, finalize: <fn>, lang: "js" } }',
    example:
      '{\n' +
      '  total: {\n' +
      '    $accumulator: {\n' +
      '      init: "function() { return 0 }",\n' +
      '      accumulate: "function(s, v) { return s + v }",\n' +
      '      accumulateArgs: ["$amount"],\n' +
      '      merge: "function(a, b) { return a + b }",\n' +
      '      lang: "js"\n' +
      '    }\n' +
      '  }\n' +
      '}',
    url: `${DOCS}/aggregation/accumulator/`,
  },
  {
    name: '$function',
    class: 'accumulator',
    validIn: GROUP,
    description:
      'Invokes a user-defined JavaScript function over the group. ' +
      'Requires server-side scripting.',
    syntax: '{ $function: { body: <fn>, args: [<expr>, …], lang: "js" } }',
    example: '{ double: { $function: { body: "function(x) { return x * 2 }", args: ["$value"], lang: "js" } } }',
    url: `${DOCS}/aggregation/function/`,
  },
  {
    name: '$expMovingAvg',
    class: 'accumulator',
    validIn: GROUP,
    description:
      'Returns the exponential moving average for a numeric expression. ' +
      'Window-function only. Specify N or alpha.',
    syntax: '{ $expMovingAvg: { input: <expr>, N: <n> } }',
    example: '{ ema: { $expMovingAvg: { input: "$price", N: 10 } } }',
    url: `${DOCS}/aggregation/expMovingAvg/`,
  },
  {
    name: '$derivative',
    class: 'accumulator',
    validIn: GROUP,
    description: 'Returns the derivative (rate of change) of an expression across a window.',
    syntax: '{ $derivative: { input: <expr>, unit: <unit> } }',
    example: '{ slope: { $derivative: { input: "$temp", unit: "minute" } } }',
    url: `${DOCS}/aggregation/derivative/`,
  },
  {
    name: '$integral',
    class: 'accumulator',
    validIn: GROUP,
    description: 'Returns the integral of an expression across a window. Window-function only.',
    syntax: '{ $integral: { input: <expr>, unit: <unit> } }',
    example: '{ area: { $integral: { input: "$rate", unit: "hour" } } }',
    url: `${DOCS}/aggregation/integral/`,
  },
  {
    name: '$shift',
    class: 'accumulator',
    validIn: GROUP,
    description:
      'Returns the value from a document offset from the current document ' +
      'by the given number of positions. Window-function only.',
    syntax: '{ $shift: { output: <expr>, by: <int>, default: <expr> } }',
    example: '{ prev: { $shift: { output: "$price", by: -1, default: null } } }',
    url: `${DOCS}/aggregation/shift/`,
  },
  {
    name: '$denseRank',
    class: 'accumulator',
    validIn: GROUP,
    description:
      'Returns the dense rank of the current document within the window. ' +
      'Rank increments by one per unique sort key, with no gaps.',
    syntax: '{ $denseRank: { } }',
    example: '{ rank: { $denseRank: {} } }',
    url: `${DOCS}/aggregation/denseRank/`,
  },
  {
    name: '$rank',
    class: 'accumulator',
    validIn: GROUP,
    description:
      'Returns the rank of the current document within the window. Ties ' +
      'share a rank; subsequent ranks skip positions.',
    syntax: '{ $rank: { } }',
    example: '{ rank: { $rank: {} } }',
    url: `${DOCS}/aggregation/rank/`,
  },
  {
    name: '$documentNumber',
    class: 'accumulator',
    validIn: GROUP,
    description: 'Returns the 1-based position of the current document within the window.',
    syntax: '{ $documentNumber: { } }',
    example: '{ rowNum: { $documentNumber: {} } }',
    url: `${DOCS}/aggregation/documentNumber/`,
  },
  {
    name: '$linearFill',
    class: 'accumulator',
    validIn: GROUP,
    description:
      'Fills null / missing values with linearly interpolated values based ' +
      'on surrounding non-null values. Window-function only.',
    syntax: '{ $linearFill: <expr> }',
    example: '{ temp: { $linearFill: "$temperature" } }',
    url: `${DOCS}/aggregation/linearFill/`,
  },
  {
    name: '$locf',
    class: 'accumulator',
    validIn: GROUP,
    description:
      'Last-Observation-Carried-Forward — fills null / missing values with ' +
      'the most recent non-null value. Window-function only.',
    syntax: '{ $locf: <expr> }',
    example: '{ level: { $locf: "$waterLevel" } }',
    url: `${DOCS}/aggregation/locf/`,
  },
];

// ─── Expression operators — rich content for 25 most common ───────────────
// The rest get only a `name` + `class` + `summary`; summaries come from the
// EXPRESSION_SUMMARIES map below.
const RICH_EXPRESSIONS: readonly OperatorDef[] = [
  {
    name: '$cond',
    class: 'expression',
    validIn: PROJECT_EXPR,
    summary: 'Ternary if-then-else expression',
    description:
      'Ternary expression: evaluates the boolean <if>, returns <then> when ' +
      'true, else <else>. The object form { if, then, else } is also valid.',
    syntax: '{ $cond: [<if>, <then>, <else>] }',
    example: '{ isAdult: { $cond: [{ $gte: ["$age", 18] }, true, false] } }',
    url: `${DOCS}/aggregation/cond/`,
  },
  {
    name: '$ifNull',
    class: 'expression',
    validIn: PROJECT_EXPR,
    summary: 'Return fallback when null/missing',
    description:
      'Evaluates expressions left-to-right and returns the first non-null, ' +
      'non-missing value. Useful for default values.',
    syntax: '{ $ifNull: [<expr1>, <expr2>, …, <fallback>] }',
    example: '{ displayName: { $ifNull: ["$nickname", "$name", "Anonymous"] } }',
    url: `${DOCS}/aggregation/ifNull/`,
  },
  {
    name: '$switch',
    class: 'expression',
    validIn: PROJECT_EXPR,
    summary: 'Multi-branch case expression',
    description:
      'Evaluates a series of case / then branches and returns the first ' +
      'matching result. Falls back to the default when no case matches.',
    syntax: '{ $switch: { branches: [{ case: <expr>, then: <expr> }, …], default: <expr> } }',
    example:
      '{\n' +
      '  tier: {\n' +
      '    $switch: {\n' +
      '      branches: [\n' +
      '        { case: { $gte: ["$spent", 1000] }, then: "gold" },\n' +
      '        { case: { $gte: ["$spent", 100] }, then: "silver" }\n' +
      '      ],\n' +
      '      default: "bronze"\n' +
      '    }\n' +
      '  }\n' +
      '}',
    url: `${DOCS}/aggregation/switch/`,
  },
  {
    name: '$let',
    class: 'expression',
    validIn: PROJECT_EXPR,
    summary: 'Bind variables for an expression',
    description:
      'Binds variables for use in the contained expression. Referenced ' +
      'inside via $$<varName>.',
    syntax: '{ $let: { vars: { <name>: <expr>, … }, in: <expr> } }',
    example:
      '{ total: { $let: { vars: { net: { $subtract: ["$price", "$discount"] } }, in: { $multiply: ["$$net", "$qty"] } } } }',
    url: `${DOCS}/aggregation/let/`,
  },
  {
    name: '$concat',
    class: 'expression',
    validIn: PROJECT_EXPR,
    summary: 'Concatenate strings',
    description:
      'Concatenates strings and returns the result. If any expression ' +
      'resolves to null or missing, the result is null.',
    syntax: '{ $concat: [<expr1>, <expr2>, …] }',
    example: '{ fullName: { $concat: ["$firstName", " ", "$lastName"] } }',
    url: `${DOCS}/aggregation/concat/`,
  },
  {
    name: '$substr',
    class: 'expression',
    validIn: PROJECT_EXPR,
    summary: 'Substring by byte offset (legacy)',
    description:
      'Returns a substring of a string. Deprecated in favour of $substrCP ' +
      '(code-point) and $substrBytes (byte).',
    syntax: '{ $substr: [<string>, <start>, <length>] }',
    example: '{ prefix: { $substr: ["$code", 0, 3] } }',
    url: `${DOCS}/aggregation/substr/`,
  },
  {
    name: '$toLower',
    class: 'expression',
    validIn: PROJECT_EXPR,
    summary: 'Lowercase a string',
    description: 'Converts a string to lowercase. Non-string inputs return null.',
    syntax: '{ $toLower: <expr> }',
    example: '{ emailLower: { $toLower: "$email" } }',
    url: `${DOCS}/aggregation/toLower/`,
  },
  {
    name: '$toUpper',
    class: 'expression',
    validIn: PROJECT_EXPR,
    summary: 'Uppercase a string',
    description: 'Converts a string to uppercase. Non-string inputs return null.',
    syntax: '{ $toUpper: <expr> }',
    example: '{ codeUpper: { $toUpper: "$code" } }',
    url: `${DOCS}/aggregation/toUpper/`,
  },
  {
    name: '$split',
    class: 'expression',
    validIn: PROJECT_EXPR,
    summary: 'Split string into array',
    description:
      'Splits a string by a delimiter and returns the resulting array. ' +
      'Returns an empty array when the delimiter is absent.',
    syntax: '{ $split: [<string>, <delimiter>] }',
    example: '{ parts: { $split: ["$tags", ","] } }',
    url: `${DOCS}/aggregation/split/`,
  },
  {
    name: '$trim',
    class: 'expression',
    validIn: PROJECT_EXPR,
    summary: 'Trim whitespace from a string',
    description:
      'Removes whitespace (or specified characters) from both ends of a ' +
      'string. Use $ltrim / $rtrim for one-sided trimming.',
    syntax: '{ $trim: { input: <string>, chars: <chars> } }',
    example: '{ clean: { $trim: { input: "$name" } } }',
    url: `${DOCS}/aggregation/trim/`,
  },
  {
    name: '$add',
    class: 'expression',
    validIn: PROJECT_EXPR,
    summary: 'Sum numbers or add to a date',
    description:
      'Returns the sum of numeric expressions. When one argument is a ' +
      'date and the others are numbers, returns a date offset in ms.',
    syntax: '{ $add: [<expr1>, <expr2>, …] }',
    example: '{ total: { $add: ["$price", "$tax"] } }',
    url: `${DOCS}/aggregation/add/`,
  },
  {
    name: '$subtract',
    class: 'expression',
    validIn: PROJECT_EXPR,
    summary: 'Subtract numbers or dates',
    description:
      'Subtracts two expressions. When both are dates, returns the delta ' +
      'in milliseconds; when one is a date and one a number, returns a date.',
    syntax: '{ $subtract: [<expr1>, <expr2>] }',
    example: '{ net: { $subtract: ["$revenue", "$cost"] } }',
    url: `${DOCS}/aggregation/subtract/`,
  },
  {
    name: '$multiply',
    class: 'expression',
    validIn: PROJECT_EXPR,
    summary: 'Multiply numbers',
    description: 'Multiplies numbers together and returns the result.',
    syntax: '{ $multiply: [<expr1>, <expr2>, …] }',
    example: '{ total: { $multiply: ["$price", "$qty"] } }',
    url: `${DOCS}/aggregation/multiply/`,
  },
  {
    name: '$divide',
    class: 'expression',
    validIn: PROJECT_EXPR,
    summary: 'Divide numbers',
    description: 'Divides the first expression by the second. Errors on divide-by-zero.',
    syntax: '{ $divide: [<numerator>, <denominator>] }',
    example: '{ avg: { $divide: ["$total", "$count"] } }',
    url: `${DOCS}/aggregation/divide/`,
  },
  {
    name: '$round',
    class: 'expression',
    validIn: PROJECT_EXPR,
    summary: 'Round to a number of places',
    description: 'Rounds a number to the specified decimal place (default 0). Uses banker\'s rounding.',
    syntax: '{ $round: [<number>, <place>] }',
    example: '{ rounded: { $round: ["$price", 2] } }',
    url: `${DOCS}/aggregation/round/`,
  },
  {
    name: '$dateToString',
    class: 'expression',
    validIn: PROJECT_EXPR,
    summary: 'Format a date as a string',
    description: 'Converts a date to a formatted string. Format uses %Y-%m-%d-style specifiers.',
    syntax: '{ $dateToString: { date: <expr>, format: <string>, timezone: <tz> } }',
    example: '{ day: { $dateToString: { date: "$createdAt", format: "%Y-%m-%d" } } }',
    url: `${DOCS}/aggregation/dateToString/`,
  },
  {
    name: '$dateFromString',
    class: 'expression',
    validIn: PROJECT_EXPR,
    summary: 'Parse a string to a date',
    description: 'Parses a string into a Date using the given format. Returns null on parse failure unless onError is set.',
    syntax: '{ $dateFromString: { dateString: <expr>, format: <string>, timezone: <tz> } }',
    example: '{ d: { $dateFromString: { dateString: "$raw", format: "%Y-%m-%d" } } }',
    url: `${DOCS}/aggregation/dateFromString/`,
  },
  {
    name: '$dateAdd',
    class: 'expression',
    validIn: PROJECT_EXPR,
    summary: 'Add interval to a date',
    description: 'Adds a number of time units to a date. Supports year, quarter, month, week, day, hour, minute, second, millisecond.',
    syntax: '{ $dateAdd: { startDate: <expr>, unit: <unit>, amount: <int>, timezone: <tz> } }',
    example: '{ expiresAt: { $dateAdd: { startDate: "$createdAt", unit: "day", amount: 30 } } }',
    url: `${DOCS}/aggregation/dateAdd/`,
  },
  {
    name: '$dateDiff',
    class: 'expression',
    validIn: PROJECT_EXPR,
    summary: 'Difference between two dates',
    description: 'Returns the integer difference between two dates in the specified unit.',
    syntax: '{ $dateDiff: { startDate: <expr>, endDate: <expr>, unit: <unit>, timezone: <tz> } }',
    example: '{ ageDays: { $dateDiff: { startDate: "$createdAt", endDate: "$$NOW", unit: "day" } } }',
    url: `${DOCS}/aggregation/dateDiff/`,
  },
  {
    name: '$map',
    class: 'expression',
    validIn: PROJECT_EXPR,
    summary: 'Transform each array element',
    description: 'Applies an expression to each element of an array and returns a new array. The current element is $$this by default.',
    syntax: '{ $map: { input: <array>, as: <var>, in: <expr> } }',
    example: '{ prices: { $map: { input: "$items", as: "it", in: "$$it.price" } } }',
    url: `${DOCS}/aggregation/map/`,
  },
  {
    name: '$filter',
    class: 'expression',
    validIn: PROJECT_EXPR,
    summary: 'Filter array elements by condition',
    description: 'Selects a subset of an array based on a predicate expression. The current element is $$this by default.',
    syntax: '{ $filter: { input: <array>, as: <var>, cond: <expr> } }',
    example: '{ active: { $filter: { input: "$items", as: "it", cond: { $eq: ["$$it.status", "active"] } } } }',
    url: `${DOCS}/aggregation/filter/`,
  },
  {
    name: '$reduce',
    class: 'expression',
    validIn: PROJECT_EXPR,
    summary: 'Fold an array into a single value',
    description: 'Applies an expression to each array element in sequence, threading an accumulator ($$value) through.',
    syntax: '{ $reduce: { input: <array>, initialValue: <expr>, in: <expr> } }',
    example: '{ total: { $reduce: { input: "$amounts", initialValue: 0, in: { $add: ["$$value", "$$this"] } } } }',
    url: `${DOCS}/aggregation/reduce/`,
  },
  {
    name: '$size',
    class: 'expression',
    validIn: PROJECT_EXPR,
    summary: 'Return array length',
    description: 'Returns the number of elements in an array. Errors if the argument is not an array.',
    syntax: '{ $size: <array expr> }',
    example: '{ itemCount: { $size: "$items" } }',
    url: `${DOCS}/aggregation/size/`,
  },
  {
    name: '$toString',
    class: 'expression',
    validIn: PROJECT_EXPR,
    summary: 'Convert value to string',
    description: 'Converts a value to a string. Useful for building human-readable labels from ObjectIds, dates, and numbers.',
    syntax: '{ $toString: <expr> }',
    example: '{ idStr: { $toString: "$_id" } }',
    url: `${DOCS}/aggregation/toString/`,
  },
  {
    name: '$toInt',
    class: 'expression',
    validIn: PROJECT_EXPR,
    summary: 'Convert value to integer',
    description: 'Converts a value to a 32-bit integer. Errors on values that cannot be represented; use $convert with onError for a fallback.',
    syntax: '{ $toInt: <expr> }',
    example: '{ qty: { $toInt: "$qtyString" } }',
    url: `${DOCS}/aggregation/toInt/`,
  },
];

// ─── Expression summaries ─────────────────────────────────────────────────
// Every expression op gets a summary (≤ 60 chars). Ops listed in
// RICH_EXPRESSIONS use the rich description; the rest get summary-only.
const EXPRESSION_SUMMARIES: Record<string, string> = {
  // arithmetic
  $abs: 'Absolute value',
  $ceil: 'Round up to integer',
  $exp: 'Raise e to the power',
  $floor: 'Round down to integer',
  $ln: 'Natural log',
  $log: 'Log in a given base',
  $log10: 'Base-10 logarithm',
  $mod: 'Modulo (remainder)',
  $pow: 'Raise to a power',
  $sqrt: 'Square root',
  $trunc: 'Truncate toward zero',
  // array
  $arrayElemAt: 'Element at array index',
  $arrayToObject: 'Convert pairs to object',
  $concatArrays: 'Concatenate arrays',
  $first: 'First array element',
  $firstN: 'First N array elements',
  $in: 'Check array membership',
  $indexOfArray: 'Index of element in array',
  $isArray: 'Test whether value is an array',
  $last: 'Last array element',
  $lastN: 'Last N array elements',
  $maxN: 'Top N maximum values',
  $minN: 'Top N minimum values',
  $objectToArray: 'Object to key/value pairs',
  $range: 'Generate a sequence of integers',
  $reverseArray: 'Reverse an array',
  $slice: 'Sub-range of an array',
  $sortArray: 'Sort an array',
  $zip: 'Zip arrays element-wise',
  // boolean
  $and: 'Logical AND',
  $or: 'Logical OR',
  $not: 'Logical NOT',
  // comparison
  $cmp: 'Three-way compare',
  $eq: 'Equal',
  $gt: 'Greater than',
  $gte: 'Greater than or equal',
  $lt: 'Less than',
  $lte: 'Less than or equal',
  $ne: 'Not equal',
  // data size
  $binarySize: 'Binary data byte size',
  $bsonSize: 'BSON-encoded document size',
  // date
  $dateFromParts: 'Build date from components',
  $dateSubtract: 'Subtract interval from date',
  $dateToParts: 'Date to components object',
  $dateTrunc: 'Truncate date to a unit',
  $dayOfMonth: 'Day of month (1–31)',
  $dayOfWeek: 'Day of week (1–7)',
  $dayOfYear: 'Day of year (1–366)',
  $hour: 'Hour of day (0–23)',
  $isoDayOfWeek: 'ISO day of week (1–7)',
  $isoWeek: 'ISO week number',
  $isoWeekYear: 'ISO week-numbering year',
  $millisecond: 'Milliseconds (0–999)',
  $minute: 'Minutes (0–59)',
  $month: 'Month (1–12)',
  $second: 'Seconds (0–59)',
  $toDate: 'Convert to Date',
  $week: 'Week of year',
  $year: 'Calendar year',
  // literal / variable
  $literal: 'Return expression as literal',
  $getField: 'Read a dynamic field',
  $setField: 'Set a dynamic field',
  $rand: 'Random float in [0, 1)',
  $sampleRate: 'Randomly select fraction of docs',
  // object
  $mergeObjects: 'Merge objects left-to-right',
  // set
  $allElementsTrue: 'All elements are truthy',
  $anyElementTrue: 'Any element is truthy',
  $setDifference: 'Set difference',
  $setEquals: 'Set equality (order-free)',
  $setIntersection: 'Set intersection',
  $setIsSubset: 'Subset test',
  $setUnion: 'Set union',
  // string
  $indexOfBytes: 'Byte index of substring',
  $indexOfCP: 'Code-point index of substring',
  $ltrim: 'Trim left-side whitespace',
  $regexFind: 'First regex match',
  $regexFindAll: 'All regex matches',
  $regexMatch: 'Regex match boolean',
  $replaceAll: 'Replace all substrings',
  $replaceOne: 'Replace first substring',
  $rtrim: 'Trim right-side whitespace',
  $strLenBytes: 'Byte length of string',
  $strLenCP: 'Code-point length of string',
  $strcasecmp: 'Case-insensitive string compare',
  $substrBytes: 'Substring by byte offset',
  $substrCP: 'Substring by code-point offset',
  // text search
  $meta: 'Access query metadata',
  // trigonometry
  $sin: 'Sine',
  $cos: 'Cosine',
  $tan: 'Tangent',
  $asin: 'Arcsine',
  $acos: 'Arccosine',
  $atan: 'Arctangent',
  $atan2: 'Two-argument arctangent',
  $asinh: 'Hyperbolic arcsine',
  $acosh: 'Hyperbolic arccosine',
  $atanh: 'Hyperbolic arctangent',
  $sinh: 'Hyperbolic sine',
  $cosh: 'Hyperbolic cosine',
  $tanh: 'Hyperbolic tangent',
  $degreesToRadians: 'Degrees to radians',
  $radiansToDegrees: 'Radians to degrees',
  // type
  $convert: 'Convert with on-error fallback',
  $isNumber: 'Test whether value is numeric',
  $toBool: 'Convert to boolean',
  $toDecimal: 'Convert to Decimal128',
  $toDouble: 'Convert to 64-bit float',
  $toLong: 'Convert to 64-bit integer',
  $toObjectId: 'Convert to ObjectId',
  $type: 'Return BSON type string',
};

const RICH_EXPRESSION_NAMES = new Set(RICH_EXPRESSIONS.map((e) => e.name));

// Full list of expression operator names (matches pre-X04 catalog).
const EXPRESSION_NAMES: readonly string[] = [
  // arithmetic
  '$abs', '$add', '$ceil', '$divide', '$exp', '$floor', '$ln', '$log', '$log10',
  '$mod', '$multiply', '$pow', '$round', '$sqrt', '$subtract', '$trunc',
  // array
  '$arrayElemAt', '$arrayToObject', '$concatArrays', '$filter', '$first',
  '$firstN', '$in', '$indexOfArray', '$isArray', '$last', '$lastN', '$map',
  '$maxN', '$minN', '$objectToArray', '$range', '$reduce', '$reverseArray',
  '$size', '$slice', '$sortArray', '$zip',
  // boolean
  '$and', '$or', '$not',
  // comparison
  '$cmp', '$eq', '$gt', '$gte', '$lt', '$lte', '$ne',
  // conditional
  '$cond', '$ifNull', '$switch',
  // data size
  '$binarySize', '$bsonSize',
  // date
  '$dateAdd', '$dateDiff', '$dateFromParts', '$dateFromString', '$dateSubtract',
  '$dateToParts', '$dateToString', '$dateTrunc', '$dayOfMonth', '$dayOfWeek',
  '$dayOfYear', '$hour', '$isoDayOfWeek', '$isoWeek', '$isoWeekYear',
  '$millisecond', '$minute', '$month', '$second', '$toDate', '$week', '$year',
  // literal / variable
  '$literal', '$let', '$getField', '$setField', '$rand', '$sampleRate',
  // object
  '$mergeObjects',
  // set
  '$allElementsTrue', '$anyElementTrue', '$setDifference', '$setEquals',
  '$setIntersection', '$setIsSubset', '$setUnion',
  // string
  '$concat', '$indexOfBytes', '$indexOfCP', '$ltrim', '$regexFind',
  '$regexFindAll', '$regexMatch', '$replaceAll', '$replaceOne', '$rtrim',
  '$split', '$strLenBytes', '$strLenCP', '$strcasecmp', '$substr',
  '$substrBytes', '$substrCP', '$toLower', '$toString', '$toUpper', '$trim',
  // text search
  '$meta',
  // trigonometry
  '$sin', '$cos', '$tan', '$asin', '$acos', '$atan', '$atan2',
  '$asinh', '$acosh', '$atanh', '$sinh', '$cosh', '$tanh',
  '$degreesToRadians', '$radiansToDegrees',
  // type
  '$convert', '$isNumber', '$toBool', '$toDecimal', '$toDouble', '$toInt',
  '$toLong', '$toObjectId', '$type',
];

const EXPRESSIONS: readonly OperatorDef[] = [
  ...RICH_EXPRESSIONS,
  ...EXPRESSION_NAMES.filter((n) => !RICH_EXPRESSION_NAMES.has(n)).map((name) => ({
    name,
    class: 'expression' as const,
    validIn: PROJECT_EXPR,
    summary: EXPRESSION_SUMMARIES[name],
  })),
];

// ─── Update operators ─────────────────────────────────────────────────────
const UPDATES: readonly OperatorDef[] = [
  {
    name: '$set',
    class: 'update',
    validIn: UPDATE,
    description:
      'Sets the value of one or more fields. Creates fields that do not ' +
      'exist. Replaces an existing field\'s value entirely — use $inc for ' +
      'relative numeric updates.',
    syntax: '{ $set: { <field>: <value>, … } }',
    example: '{ $set: { status: "shipped", shippedAt: new Date() } }',
    url: `${DOCS}/update/set/`,
  },
  {
    name: '$unset',
    class: 'update',
    validIn: UPDATE,
    description: 'Removes one or more fields from a document. Values in the spec are ignored.',
    syntax: '{ $unset: { <field>: "", … } }',
    example: '{ $unset: { password: "", internalNote: "" } }',
    url: `${DOCS}/update/unset/`,
  },
  {
    name: '$inc',
    class: 'update',
    validIn: UPDATE,
    description:
      'Increments a numeric field by the given amount. Negative values ' +
      'decrement. Creates the field with the value if it doesn\'t exist.',
    syntax: '{ $inc: { <field>: <number>, … } }',
    example: '{ $inc: { views: 1, stock: -1 } }',
    url: `${DOCS}/update/inc/`,
  },
  {
    name: '$mul',
    class: 'update',
    validIn: UPDATE,
    description: 'Multiplies a numeric field by the given value. Creates the field with 0 when missing.',
    syntax: '{ $mul: { <field>: <number>, … } }',
    example: '{ $mul: { price: 1.1 } }',
    url: `${DOCS}/update/mul/`,
  },
  {
    name: '$rename',
    class: 'update',
    validIn: UPDATE,
    description: 'Renames one or more fields. If the target name already exists, it is overwritten.',
    syntax: '{ $rename: { <from>: <to>, … } }',
    example: '{ $rename: { "addr": "address", "nm": "name" } }',
    url: `${DOCS}/update/rename/`,
  },
  {
    name: '$min',
    class: 'update',
    validIn: UPDATE,
    description:
      'Updates a field only if the specified value is less than the ' +
      'current one. Creates the field when missing.',
    syntax: '{ $min: { <field>: <value>, … } }',
    example: '{ $min: { lowScore: 82 } }',
    url: `${DOCS}/update/min/`,
  },
  {
    name: '$max',
    class: 'update',
    validIn: UPDATE,
    description:
      'Updates a field only if the specified value is greater than the ' +
      'current one. Creates the field when missing.',
    syntax: '{ $max: { <field>: <value>, … } }',
    example: '{ $max: { highScore: 99 } }',
    url: `${DOCS}/update/max/`,
  },
  {
    name: '$currentDate',
    class: 'update',
    validIn: UPDATE,
    description:
      'Sets a field to the current date. Use true for Date, or { $type: ' +
      '"timestamp" } for BSON Timestamp.',
    syntax: '{ $currentDate: { <field>: true | { $type: "date" | "timestamp" }, … } }',
    example: '{ $currentDate: { updatedAt: true } }',
    url: `${DOCS}/update/currentDate/`,
  },
  {
    name: '$setOnInsert',
    class: 'update',
    validIn: UPDATE,
    description:
      'Assigns values only when an upsert operation inserts a new ' +
      'document. Ignored when the update modifies an existing document.',
    syntax: '{ $setOnInsert: { <field>: <value>, … } }',
    example: '{ $setOnInsert: { createdAt: new Date() } }',
    url: `${DOCS}/update/setOnInsert/`,
  },
  {
    name: '$push',
    class: 'update',
    validIn: UPDATE,
    description:
      'Appends a value to an array field. Supports $each, $position, ' +
      '$slice, and $sort modifiers for richer inserts.',
    syntax: '{ $push: { <field>: <value> | { $each: [<v>, …], $slice: <n>, $sort: <spec> } } }',
    example: '{ $push: { tags: { $each: ["beta", "v2"], $slice: -10 } } }',
    url: `${DOCS}/update/push/`,
  },
  {
    name: '$pop',
    class: 'update',
    validIn: UPDATE,
    description: 'Removes the first (-1) or last (1) element of an array.',
    syntax: '{ $pop: { <field>: 1 | -1 } }',
    example: '{ $pop: { queue: -1 } }',
    url: `${DOCS}/update/pop/`,
  },
  {
    name: '$pull',
    class: 'update',
    validIn: UPDATE,
    description: 'Removes all array elements matching a specified query or value.',
    syntax: '{ $pull: { <field>: <value> | <query> } }',
    example: '{ $pull: { tags: { $in: ["obsolete", "beta"] } } }',
    url: `${DOCS}/update/pull/`,
  },
  {
    name: '$pullAll',
    class: 'update',
    validIn: UPDATE,
    description: 'Removes all instances of the listed values from an array.',
    syntax: '{ $pullAll: { <field>: [<v1>, <v2>, …] } }',
    example: '{ $pullAll: { tags: ["obsolete", "beta"] } }',
    url: `${DOCS}/update/pullAll/`,
  },
  {
    name: '$addToSet',
    class: 'update',
    validIn: UPDATE,
    description: 'Appends a value to an array only if the value is not already present. Use $each to add multiple values.',
    syntax: '{ $addToSet: { <field>: <value> | { $each: [<v1>, <v2>, …] } } }',
    example: '{ $addToSet: { tags: { $each: ["alpha", "beta"] } } }',
    url: `${DOCS}/update/addToSet/`,
  },
  {
    name: '$bit',
    class: 'update',
    validIn: UPDATE,
    description: 'Performs bitwise AND, OR, or XOR on an integer field.',
    syntax: '{ $bit: { <field>: { and | or | xor: <int> } } }',
    example: '{ $bit: { flags: { or: 4 } } }',
    url: `${DOCS}/update/bit/`,
  },
];

/**
 * The catalog may contain entries that share a name across classes (e.g.,
 * `$eq` is both a query op and an expression op, `$set` is both a stage and
 * an update op). That's intentional — ranking uses the class badge, and
 * Phase B's context filter keeps the right one.
 */
// ─── Symbols and English names for the query operators (ADR 0004) ───────────

/**
 * ADR 0004's "symbolic operators in the Query Builder" scope note, as data.
 *
 * `symbol` is what the Query Builder's operator box resolves *from*; `label`
 * is the English name shown beside the operator in the suggestion popover.
 * The box keeps showing `$gt` after a resolve, so `node.op` always holds a
 * real operator and neither `printFilter` nor `isCompilableOp` changes.
 *
 * `aliases` are the other spellings a user arrives with: `==` and `<>` out of
 * habit, and `≥` / `≤` / `≠` out of a paste from a document. They resolve to
 * the same operator but are never displayed — one canonical symbol per row.
 *
 * The set is the operators the builder can actually compile
 * (`isCompilableOp`), plus nothing: an operator the row would flag as needing
 * a raw clause is not made easier to reach by naming it.
 */
const QUERY_SYMBOLS: Record<
  string,
  { label: string; symbol?: string; aliases?: readonly string[] }
> = {
  $eq: { label: 'equals', symbol: '=', aliases: ['=='] },
  $ne: { label: 'not equal to', symbol: '!=', aliases: ['<>', '≠'] },
  $gt: { label: 'greater than', symbol: '>' },
  $gte: { label: 'greater than or equal to', symbol: '>=', aliases: ['≥'] },
  $lt: { label: 'less than', symbol: '<' },
  $lte: { label: 'less than or equal to', symbol: '<=', aliases: ['≤'] },
  $in: { label: 'is one of' },
  $nin: { label: 'is none of' },
  $all: { label: 'contains all of' },
  $exists: { label: 'field is present' },
  $regex: { label: 'matches pattern' },
  $type: { label: 'has BSON type' },
  $mod: { label: 'divides with remainder' },
  $size: { label: 'array length is' },
  $bitsAllClear: { label: 'all bits clear' },
  $bitsAnyClear: { label: 'any bit clear' },
  $bitsAllSet: { label: 'all bits set' },
  $bitsAnySet: { label: 'any bit set' },
};

const SYMBOL_TO_OPERATOR: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(QUERY_SYMBOLS).flatMap(([name, e]) =>
    [...(e.symbol ? [e.symbol] : []), ...(e.aliases ?? [])].map((s) => [s, name]),
  ),
);

/**
 * The operator an exactly-typed symbol means, or `null` for anything else.
 *
 * Exact match on the trimmed text, never a prefix: `>` is a prefix of `>=`, so
 * a per-keystroke lookup would convert `>` to `$gt` before the user reaches
 * the `=`. Callers resolve on blur instead — the same commit point X14 uses.
 *
 * Returns `null` for text that is already an operator, so re-running it over
 * a resolved value is a no-op.
 */
export function resolveOperatorSymbol(text: string): string | null {
  return SYMBOL_TO_OPERATOR[text.trim()] ?? null;
}

export const OPERATORS: readonly OperatorDef[] = [
  ...STAGES,
  ...QUERY.map((op) => {
    const named = QUERY_SYMBOLS[op.name];
    return named ? { ...op, label: named.label, symbol: named.symbol } : op;
  }),
  ...ACCUMULATORS,
  ...EXPRESSIONS,
  ...UPDATES,
];

/** Short (≤5 char) class badge for the popover. */
export const CLASS_BADGE: Record<OperatorClass, string> = {
  stage: 'stage',
  query: 'query',
  logical: 'logic',
  element: 'elem',
  evaluation: 'eval',
  array: 'array',
  geo: 'geo',
  accumulator: 'acc',
  expression: 'expr',
  update: 'update',
};

/** Longer class label for the footer "Class: …" text in the doc panel. */
export const CLASS_LABEL: Record<OperatorClass, string> = {
  stage: 'stage operator',
  query: 'query operator',
  logical: 'logical operator',
  element: 'element operator',
  evaluation: 'evaluation operator',
  array: 'array operator',
  geo: 'geospatial operator',
  accumulator: 'accumulator',
  expression: 'expression operator',
  update: 'update operator',
};

/**
 * Badge background + text colour per class. Callers call `classColor` to get
 * the dark-mode-aware pair. The raw map is exported for tests.
 */
export const CLASS_COLOR: Record<OperatorClass, { bg: string; text: string }> = {
  stage:       { bg: 'rgba(61,57,132,0.15)',   text: '#3D3984' },
  query:       { bg: 'rgba(26,80,138,0.15)',   text: '#1A508A' },
  logical:     { bg: 'rgba(107,58,138,0.15)',  text: '#6B3A8A' },
  element:     { bg: 'rgba(138,107,64,0.15)',  text: '#8A6B40' },
  evaluation:  { bg: 'rgba(26,104,104,0.15)',  text: '#1A6868' },
  array:       { bg: 'rgba(138,60,90,0.15)',   text: '#8A3C5A' },
  geo:         { bg: 'rgba(90,100,26,0.15)',   text: '#5A641A' },
  accumulator: { bg: 'rgba(90,58,138,0.15)',   text: '#5A3A8A' },
  expression:  { bg: 'rgba(64,90,138,0.15)',   text: '#405A8A' },
  update:      { bg: 'rgba(138,50,50,0.15)',   text: '#8A3232' },
};

/**
 * Brighten an `rgba(…, 0.15)` badge colour for dark mode. The 0.15 → 0.25
 * bump lifts the swatch against a dark surface. Shared by `classColor` and
 * stage-pill colouring in StageAccordion / PipelineOutline.
 */
export function brightenBadgeForDark(
  base: { bg: string; text: string },
  dark: boolean,
): { bg: string; text: string } {
  if (!dark) return base;
  return { bg: base.bg.replace('0.15', '0.25').replace('0.18', '0.28'), text: base.text };
}

/** Dark-mode-aware class colour. */
export function classColor(
  cls: OperatorClass,
  dark: boolean,
): { bg: string; text: string } {
  return brightenBadgeForDark(CLASS_COLOR[cls], dark);
}

/** Summary lookup for stage ops (used by AddStagePill / StageAccordion). */
export function stageOperatorSummary(name: string): string | undefined {
  return STAGES.find((s) => s.name === name)?.summary;
}

// Build a name → entries lookup once so `findOperatorDocs` / `hasOperatorDocs`
// are O(1) rather than O(catalog size) per call. The catalog is a module
// constant, so the map is computed once at import.
const OPERATORS_BY_NAME: ReadonlyMap<string, readonly OperatorDef[]> = (() => {
  const m = new Map<string, OperatorDef[]>();
  for (const op of OPERATORS) {
    const bucket = m.get(op.name);
    if (bucket) bucket.push(op);
    else m.set(op.name, [op]);
  }
  return m;
})();

/**
 * Resolve the catalog entry for an operator name, preferring an entry whose
 * `class` matches `prefClass` when provided. Falls back to a description-
 * bearing entry, then to the first entry with that name. Returns null when
 * the operator is unknown.
 */
export function findOperatorDocs(
  name: string,
  prefClass?: OperatorClass,
): OperatorDef | null {
  const matches = OPERATORS_BY_NAME.get(name);
  if (!matches || matches.length === 0) return null;
  if (prefClass) {
    const byClass = matches.find((op) => op.class === prefClass);
    if (byClass) return byClass;
  }
  const withDescription = matches.find((op) => op.description && op.description.length > 0);
  return withDescription ?? matches[0] ?? null;
}

/** True when the named operator has a renderable doc body (description). */
export function hasOperatorDocs(name: string, prefClass?: OperatorClass): boolean {
  return !!findOperatorDocs(name, prefClass)?.description;
}
