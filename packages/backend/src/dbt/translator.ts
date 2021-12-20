import { getLocationForJsonPath, parseWithPointers } from '@stoplight/yaml';
import {
    DbtColumnLightdashMetric,
    DbtMetric,
    DbtModelColumn,
    DbtModelNode,
    DbtRawModelNode,
    Dimension,
    DimensionType,
    Explore,
    ExploreError,
    FieldType,
    friendlyName,
    LineageGraph,
    LineageNodeDependency,
    Metric,
    MetricType,
    parseMetricType,
    Source,
    SupportedDbtAdapter,
    Table,
} from 'common';
import { DepGraph } from 'dependency-graph';
import * as fs from 'fs';
import { DbtError, MissingCatalogEntryError, ParseError } from '../errors';
import { compileExplore } from '../exploreCompiler';
import { WarehouseCatalog } from '../types';

const patchPathParts = (patchPath: string) => {
    const [project, ...rest] = patchPath.split('://');
    if (rest.length === 0) {
        throw new DbtError(
            'Could not parse dbt manifest. It looks like you might be using an old version of dbt. You must be using dbt version 0.20.0 or above.',
            {},
        );
    }
    return {
        project,
        path: rest.join('://'),
    };
};

const defaultSql = (columnName: string): string =>
    // eslint-disable-next-line no-useless-escape
    `\$\{TABLE\}.${columnName}`;

const getDataTruncSql = (
    adapterType: SupportedDbtAdapter,
    timeInterval: string,
    field: string,
) => {
    switch (adapterType) {
        case SupportedDbtAdapter.BIGQUERY:
            return `DATE_TRUNC('${field}', ${timeInterval.toUpperCase()})`;
        case SupportedDbtAdapter.REDSHIFT:
        case SupportedDbtAdapter.POSTGRES:
        case SupportedDbtAdapter.SNOWFLAKE:
        case SupportedDbtAdapter.SPARK:
            return `DATE_TRUNC('${timeInterval.toUpperCase()}', ${field})`;
        default:
            const never: never = adapterType;
            throw new ParseError(`Cannot recognise warehouse ${adapterType}`);
    }
};

const dateIntervals = ['DAY', 'WEEK', 'MONTH', 'YEAR'];

const convertDimension = (
    targetWarehouse: SupportedDbtAdapter,
    modelName: string,
    column: DbtModelColumn,
    source?: Source,
    timeInterval?: string,
): Dimension => {
    let type = column.meta.dimension?.type || column.data_type;
    if (type === undefined) {
        throw new MissingCatalogEntryError(
            `Could not automatically find type information for column "${column.name}" in dbt model "${modelName}". Check for this column in your warehouse or specify the type manually.`,
            {},
        );
    }
    let group: string | undefined;
    let name = column.meta.dimension?.name || column.name;
    let sql = column.meta.dimension?.sql || defaultSql(column.name);
    if (timeInterval) {
        if (timeInterval !== 'RAW') {
            sql = getDataTruncSql(
                targetWarehouse,
                timeInterval,
                defaultSql(column.name),
            );
        }
        name = `${column.name}_${timeInterval.toLowerCase()}`;
        group = column.name;
        if (dateIntervals.includes(timeInterval.toUpperCase())) {
            type = DimensionType.DATE;
        }
    }

    return {
        fieldType: FieldType.DIMENSION,
        name,
        sql,
        table: modelName,
        type,
        description: column.meta.dimension?.description || column.description,
        source,
        group,
        timeInterval,
    };
};

type ConvertMetricArgs = {
    modelName: string;
    columnName: string;
    name: string;
    metric: DbtColumnLightdashMetric;
    source?: Source;
};
const convertMetric = ({
    modelName,
    columnName,
    name,
    metric,
    source,
}: ConvertMetricArgs): Metric => ({
    fieldType: FieldType.METRIC,
    name,
    sql: metric.sql || defaultSql(columnName),
    table: modelName,
    type: metric.type,
    isAutoGenerated: false,
    description:
        metric.description ||
        `${friendlyName(metric.type)} of ${friendlyName(columnName)}`,
    source,
});

const generateTableLineage = (
    model: DbtModelNode,
    depGraph: DepGraph<LineageNodeDependency>,
): LineageGraph => {
    const modelFamily = [
        ...depGraph.dependantsOf(model.name),
        ...depGraph.dependenciesOf(model.name),
        model.name,
    ];
    return modelFamily.reduce<LineageGraph>(
        (prev, modelName) => ({
            ...prev,
            [modelName]: depGraph
                .directDependenciesOf(modelName)
                .map((d) => depGraph.getNodeData(d)),
        }),
        {},
    );
};

export const idPattern = /((.+)(?<!val)id$)/i;
export const extractEntityNameFromIdColumn = (
    columnName: string,
): string | null => {
    const match = idPattern.exec(columnName);
    if (match === null) {
        return match;
    }
    return (
        match[2]
            .toLowerCase()
            .split(/[^a-z]/)
            .filter((x) => x)
            .join('_') || null
    );
};

const autoGenerateMetrics = ({
    name: modelName,
    columns,
}: Pick<DbtModelNode, 'name' | 'columns'>): Record<string, Metric> =>
    Object.keys(columns).reduce<Record<string, Metric>>(
        (previous, columnName) => {
            const entityName = extractEntityNameFromIdColumn(columnName);
            if (entityName === null) {
                return previous;
            }
            const metricName = `${entityName}_count`;
            const metric: Metric = {
                name: metricName,
                description: `Count of unique ${friendlyName(
                    entityName,
                )}s. Lightdash has created this metric automatically.`,
                fieldType: FieldType.METRIC,
                type: MetricType.COUNT_DISTINCT,
                isAutoGenerated: true,
                sql: defaultSql(columnName),
                table: modelName,
            };
            return { ...previous, [metricName]: metric };
        },
        {},
    );

const convertDbtMetricToLightdashMetric = (metric: DbtMetric): Metric => {
    let type: MetricType;
    try {
        type = parseMetricType(metric.type);
    } catch (e) {
        throw new ParseError(
            `Cannot parse metric '${metric.unique_id}: type ${metric.type} is not a valid Lightdash metric type`,
        );
    }
    return {
        fieldType: FieldType.METRIC,
        type,
        isAutoGenerated: false,
        name: metric.name,
        table: metric.model,
        sql: metric.sql ? defaultSql(metric.sql) : defaultSql(metric.name),
        description: metric.description,
        source: undefined,
    };
};

export const convertTable = (
    adapterType: SupportedDbtAdapter,
    model: DbtModelNode,
    dbtMetrics: DbtMetric[],
): Omit<Table, 'lineageGraph'> => {
    const [dimensions, metrics]: [
        Record<string, Dimension>,
        Record<string, Metric>,
    ] = Object.values(model.columns).reduce(
        ([prevDimensions, prevMetrics], column) => {
            const columnMetrics = Object.fromEntries(
                Object.entries(column.meta.metrics || {}).map(
                    ([name, metric]) => [
                        name,
                        convertMetric({
                            modelName: model.name,
                            columnName: column.name,
                            name,
                            metric,
                        }),
                    ],
                ),
            );

            const dimension = convertDimension(adapterType, model.name, column);

            let extraDimensions = {};

            if (
                [DimensionType.DATE, DimensionType.TIMESTAMP].includes(
                    dimension.type,
                ) &&
                ((column.meta.dimension?.time_intervals &&
                    column.meta.dimension.time_intervals !== 'OFF') ||
                    !column.meta.dimension?.time_intervals)
            ) {
                let intervals: string[] = [];
                if (
                    column.meta.dimension?.time_intervals &&
                    Array.isArray(column.meta.dimension.time_intervals)
                ) {
                    intervals = column.meta.dimension.time_intervals;
                } else {
                    if (dimension.type === DimensionType.TIMESTAMP) {
                        intervals = ['RAW'];
                    }
                    intervals = [...intervals, ...dateIntervals];
                }

                extraDimensions = intervals.reduce(
                    (acc, interval) => ({
                        ...acc,
                        [`${column.name}_${interval}`]: convertDimension(
                            adapterType,
                            model.name,
                            column,
                            undefined,
                            interval,
                        ),
                    }),
                    {},
                );
            }

            return [
                {
                    ...prevDimensions,
                    [column.name]: dimension,
                    ...extraDimensions,
                },
                { ...prevMetrics, ...columnMetrics },
            ];
        },
        [{}, {}],
    );

    const convertedDbtMetrics = Object.fromEntries(
        dbtMetrics.map((metric) => [
            metric.name,
            convertDbtMetricToLightdashMetric(metric),
        ]),
    );
    const allMetrics = { ...convertedDbtMetrics, ...metrics }; // Model-level metric names take priority

    const enrichedMetrics =
        Object.keys(allMetrics).length > 0
            ? allMetrics
            : autoGenerateMetrics(model);

    return {
        name: model.name,
        database: model.database,
        schema: model.schema,
        sqlTable: model.relation_name,
        description: model.description || `${model.name} table`,
        dimensions,
        metrics: enrichedMetrics,
    };
};

const modelGraph = (
    allModels: DbtModelNode[],
): DepGraph<LineageNodeDependency> => {
    const depGraph = new DepGraph<LineageNodeDependency>();
    allModels.forEach((model) => {
        const [type, project, name] = model.unique_id.split('.');
        if (type === 'model') {
            depGraph.addNode(name, { type, name });
        }
        // Only use models, seeds, and sources for graph.
        model.depends_on.nodes.forEach((nodeId) => {
            const [nodeType, nodeProject, nodeName] = nodeId.split('.');
            if (
                nodeType === 'model' ||
                nodeType === 'seed' ||
                nodeType === 'source'
            ) {
                depGraph.addNode(nodeName, { type: nodeType, name: nodeName });
                depGraph.addDependency(model.name, nodeName);
            }
        });
    });
    return depGraph;
};

const translateDbtModelsToTableLineage = (
    models: DbtModelNode[],
): Record<string, Pick<Table, 'lineageGraph'>> => {
    const graph = modelGraph(models);
    return models.reduce<Record<string, Pick<Table, 'lineageGraph'>>>(
        (previousValue, currentValue) => ({
            ...previousValue,
            [currentValue.name]: {
                lineageGraph: generateTableLineage(currentValue, graph),
            },
        }),
        {},
    );
};

const translateDbtModelTableSource = (
    model: DbtModelNode & { patch_path: string },
) => {
    const patchPath = model.patch_path;
    const modelPath = patchPathParts(patchPath).path;
    const schemaPath = `${model.root_path}/${modelPath}`;

    let ymlFile: string;
    try {
        ymlFile = fs.readFileSync(schemaPath, 'utf-8');
    } catch {
        throw new ParseError(
            `It was not possible to read the dbt schema ${schemaPath}`,
            {},
        );
    }

    const lines = ymlFile.split(/\r?\n/);
    const parsedFile = parseWithPointers<{ models: DbtModelNode[] }>(
        ymlFile.toString(),
    );

    if (!parsedFile.data) {
        throw new ParseError(
            `It was not possible to parse the dbt schema "${schemaPath}"`,
            {},
        );
    }

    const modelIndex = parsedFile.data.models.findIndex(
        (m: DbtModelNode) => m.name === model.name,
    );
    const modelRange = getLocationForJsonPath(parsedFile, [
        'models',
        modelIndex,
    ])?.range;

    if (!modelRange) {
        throw new ParseError(
            `It was not possible to find the dbt model "${model.name}" in ${schemaPath}`,
            {},
        );
    }

    const tableSource: Source = {
        path: patchPathParts(patchPath).path,
        range: modelRange,
        content: lines
            .slice(modelRange.start.line, modelRange.end.line + 1)
            .join('\r\n'),
    };
    const sources = Object.entries(model.columns).reduce<{
        dimensions: Record<string, Source>;
        metrics: Record<string, Source>;
    }>(
        (previousValue, [columnName, column], columnIndex) => {
            const columnRange = getLocationForJsonPath(parsedFile, [
                'models',
                modelIndex,
                'columns',
                columnIndex,
            ])?.range;
            if (!columnRange) {
                throw new ParseError(
                    `It was not possible to find the column "${columnName}" for the model "${model.name}" in ${schemaPath}`,
                    {},
                );
            }
            const dimensionSource: Source = {
                path: patchPathParts(patchPath).path,
                range: columnRange,
                content: lines
                    .slice(columnRange.start.line, columnRange.end.line + 1)
                    .join('\r\n'),
            };
            const metrics = column.meta.metrics || {};
            const metricSources: Record<string, Source> = Object.keys(
                metrics,
            ).reduce<Record<string, Source>>(
                (previousMetricSources, metricName) => {
                    const metricRange = getLocationForJsonPath(parsedFile, [
                        'models',
                        modelIndex,
                        'columns',
                        columnIndex,
                        'meta',
                        'metrics',
                        metricName,
                    ])?.range;
                    if (!metricRange) {
                        throw new ParseError(
                            `It was not possible to find the metric "${metricName}" for the model "${model.name}" in ${schemaPath}`,
                            {},
                        );
                    }
                    const metricSource: Source = {
                        path: dimensionSource.path,
                        range: dimensionSource.range,
                        highlight: metricRange,
                        content: dimensionSource.content,
                    };
                    return {
                        ...previousMetricSources,
                        [metricName]: metricSource,
                    };
                },
                {},
            );
            return {
                dimensions: {
                    ...previousValue.dimensions,
                    [columnName]: dimensionSource,
                },
                metrics: { ...previousValue.metrics, ...metricSources },
            };
        },
        { dimensions: {}, metrics: {} },
    );
    return {
        source: tableSource,
        ...sources,
    };
};

export const convertExplores = async (
    models: DbtModelNode[],
    loadSources: boolean,
    adapterType: SupportedDbtAdapter,
    metrics: DbtMetric[],
): Promise<(Explore | ExploreError)[]> => {
    const tableLineage = translateDbtModelsToTableLineage(models);

    const [tables, exploreErrors] = models.reduce(
        ([accTables, accErrors], model) => {
            // If there are any errors compiling the table return an ExploreError
            try {
                // base dimensions and metrics
                const tableMetrics = metrics.filter(
                    (metric) => metric.model === model.name,
                );
                const table = convertTable(adapterType, model, tableMetrics);

                // add sources
                if (loadSources && model.patch_path !== null) {
                    const tableSource = translateDbtModelTableSource({
                        ...model,
                        patch_path: model.patch_path,
                    });
                    table.source = tableSource.source;
                    table.dimensions = Object.keys(table.dimensions).reduce<
                        Record<string, Dimension>
                    >((accDimensions, dimensionName) => {
                        const dimension: Dimension = {
                            ...table.dimensions[dimensionName],
                            source: tableSource.dimensions[dimensionName],
                        };
                        return { ...accDimensions, [dimensionName]: dimension };
                    }, {});
                    table.metrics = Object.keys(table.metrics).reduce<
                        Record<string, Metric>
                    >((accMetrics, metricName) => {
                        const metric: Metric = {
                            ...table.metrics[metricName],
                            source: tableSource.metrics[metricName],
                        };
                        return { ...accMetrics, [metricName]: metric };
                    }, {});
                }

                // add lineage
                const tableWithLineage: Table = {
                    ...table,
                    ...tableLineage[model.name],
                };

                return [[...accTables, tableWithLineage], accErrors];
            } catch (e) {
                const exploreError: ExploreError = {
                    name: model.name,
                    tags: model.tags,
                    errors: [
                        {
                            type: e.name,
                            message:
                                e.message ||
                                `Could not convert dbt model: "${model.name}" in to a Lightdash explore`,
                        },
                    ],
                };
                return [accTables, [...accErrors, exploreError]];
            }
        },
        [[], []] as [Table[], ExploreError[]],
    );
    const tableLookup: Record<string, Table> = tables.reduce(
        (prev, table) => ({ ...prev, [table.name]: table }),
        {},
    );
    const validModels = models.filter(
        (model) => tableLookup[model.name] !== undefined,
    );
    const explores: (Explore | ExploreError)[] = validModels.map((model) => {
        try {
            return compileExplore({
                name: model.name,
                tags: model.tags,
                baseTable: model.name,
                joinedTables: (
                    model.config?.meta?.joins || // Config block takes priority, then meta block
                    model.meta.joins ||
                    []
                ).map((join) => ({
                    table: join.join,
                    sqlOn: join.sql_on,
                })),
                tables: tableLookup,
                targetDatabase: adapterType,
            });
        } catch (e) {
            return {
                name: model.name,
                errors: [{ type: e.name, message: e.message }],
            };
        }
    });
    return [...explores, ...exploreErrors];
};

export const normaliseModelDatabase = (
    model: DbtRawModelNode,
    targetWarehouse: SupportedDbtAdapter,
): DbtModelNode => {
    switch (targetWarehouse) {
        case SupportedDbtAdapter.POSTGRES:
        case SupportedDbtAdapter.BIGQUERY:
        case SupportedDbtAdapter.SNOWFLAKE:
        case SupportedDbtAdapter.REDSHIFT:
            if (model.database === null) {
                throw new ParseError(
                    `Cannot parse dbt model '${model.unique_id}' because the database field has null value.`,
                    {},
                );
            }
            return { ...model, database: model.database };
        case SupportedDbtAdapter.SPARK:
            return { ...model, database: 'SPARK' };
        default:
            const never: never = targetWarehouse;
            throw new ParseError(
                `Cannot recognise warehouse ${targetWarehouse}`,
                {},
            );
    }
};

export const attachTypesToModels = (
    models: DbtModelNode[],
    warehouseCatalog: WarehouseCatalog,
    throwOnMissingCatalogEntry: boolean = true,
): DbtModelNode[] => {
    // Check that all models appear in the warehouse
    models.forEach(({ database, schema, name }) => {
        if (
            (!(database in warehouseCatalog) ||
                !(schema in warehouseCatalog[database]) ||
                !(name in warehouseCatalog[database][schema])) &&
            throwOnMissingCatalogEntry
        ) {
            throw new MissingCatalogEntryError(
                `Model "${name}" was expected in your target warehouse at "${database}.${schema}.${name}". Does the table exist in your target data warehouse?`,
                {},
            );
        }
    });

    const getType = (
        { database, schema, name }: DbtModelNode,
        columnName: string,
    ): DimensionType | undefined => {
        if (
            database in warehouseCatalog &&
            schema in warehouseCatalog[database] &&
            name in warehouseCatalog[database][schema] &&
            columnName in warehouseCatalog[database][schema][name]
        ) {
            return warehouseCatalog[database][schema][name][columnName];
        }

        if (throwOnMissingCatalogEntry) {
            throw new MissingCatalogEntryError(
                `Column "${columnName}" from model "${name}" does not exist.\n "${columnName}.${name}" was not found in your target warehouse at ${database}.${schema}.${name}. Try rerunning dbt to update your warehouse.`,
                {},
            );
        }
        return undefined;
    };

    // Update the dbt models with type info
    return models.map((model) => ({
        ...model,
        columns: Object.fromEntries(
            Object.entries(model.columns).map(([column_name, column]) => [
                column_name,
                { ...column, data_type: getType(model, column_name) },
            ]),
        ),
    }));
};

export const getSchemaStructureFromDbtModels = (
    dbtModels: DbtModelNode[],
): { database: string; schema: string; table: string; columns: string[] }[] =>
    dbtModels.map(({ database, schema, name, columns }) => ({
        database,
        schema,
        table: name,
        columns: Object.keys(columns),
    }));
