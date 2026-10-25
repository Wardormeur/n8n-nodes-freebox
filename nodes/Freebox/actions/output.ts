import type {
	IDataObject,
	IExecuteSingleFunctions,
	IN8nHttpFullResponse,
	INodeExecutionData,
	INodeProperties,
	INodePropertyOptions,
} from 'n8n-workflow';

// The "Output" parameter required for usableAsTool nodes
// (Simplified / Raw / Selected Fields, ID always kept in Selected Fields mode).

export type OutputMode = 'simple' | 'raw' | 'fields';

type Show = { resource: string[]; operation: string[] };

const ID_FIELD = 'id';

export function buildOutputProperties(
	show: Show,
	fieldOptions: INodePropertyOptions[],
): INodeProperties[] {
	return [
		{
			displayName: 'Output',
			name: 'output',
			type: 'options',
			noDataExpression: true,
			options: [
				{
					name: 'Simplified',
					value: 'simple',
					description: 'Return a simplified version of the response',
				},
				{
					name: 'Raw',
					value: 'raw',
					description: 'Return the raw response exactly as received',
				},
				{
					name: 'Selected Fields',
					value: 'fields',
					description: 'Return only the specified top-level fields',
				},
			],
			default: 'simple',
			displayOptions: { show },
		},
		{
			displayName: 'Fields',
			name: 'fields',
			type: 'multiOptions',
			options: fieldOptions,
			default: [],
			description:
				'The fields to add to the output. The ID field is always included regardless of selection.',
			displayOptions: { show: { ...show, output: ['fields'] } },
		},
	];
}

/** Pure trimming logic behind the Output parameter. */
export function applyOutputMode(
	data: IDataObject,
	mode: OutputMode,
	selectedFields: string[],
	simplifiedFields: string[],
): IDataObject {
	if (mode === 'raw') {
		return data;
	}
	const keep = mode === 'fields' ? [ID_FIELD, ...selectedFields] : simplifiedFields;
	const result: IDataObject = {};
	for (const key of keep) {
		if (key in data) {
			result[key] = data[key];
		}
	}
	return result;
}

/**
 * For operations with an "Include"-style option (extra data the API adds on
 * request): without this, Simplified mode would drop the data the user just
 * asked for.
 */
export interface IncludeOptions {
	/** Parameter holding the selected values. A dotted path works, e.g. 'options.include'. */
	parameter: string;
	/** Selected value -> top-level response key it adds, when they differ (e.g. ratings -> rating). */
	responseKeys?: Record<string, string>;
}

/** Simplified fields plus the response keys of the includes the user selected. */
export function simplifiedWithIncludes(
	simplifiedFields: string[],
	selected: string[],
	responseKeys: Record<string, string> = {},
): string[] {
	const extra = selected.map((value) => responseKeys[value] ?? value);
	return [...new Set([...simplifiedFields, ...extra])];
}

function readOutputParameters(
	context: IExecuteSingleFunctions,
	simplifiedFields: string[],
	include?: IncludeOptions,
) {
	const selected = include ? (context.getNodeParameter(include.parameter, []) as string[]) : [];
	return {
		mode: context.getNodeParameter('output', 'simple') as OutputMode,
		fields: context.getNodeParameter('fields', []) as string[],
		simplified: simplifiedWithIncludes(simplifiedFields, selected, include?.responseKeys),
	};
}

/**
 * postReceive for a single-entity response (Get): trims each item's json.
 * Hooks run per item, so getNodeParameter takes no item index here.
 */
export function outputSingle(simplifiedFields: string[], include?: IncludeOptions) {
	return async function (
		this: IExecuteSingleFunctions,
		items: INodeExecutionData[],
	): Promise<INodeExecutionData[]> {
		const { mode, fields, simplified } = readOutputParameters(this, simplifiedFields, include);
		return items.map((item) => ({
			...item,
			json: applyOutputMode(item.json, mode, fields, simplified),
		}));
	};
}

/**
 * postReceive for a list response (Search, Get Many) wrapped by the API as
 * `{ <listKey>: [...], ... }`. Emits one item per entity.
 */
export function outputList(listKey: string, simplifiedFields: string[], include?: IncludeOptions) {
	return async function (
		this: IExecuteSingleFunctions,
		_items: INodeExecutionData[],
		response: IN8nHttpFullResponse,
	): Promise<INodeExecutionData[]> {
		const { mode, fields, simplified } = readOutputParameters(this, simplifiedFields, include);
		const entities = ((response.body as IDataObject)[listKey] as IDataObject[] | undefined) ?? [];
		return entities.map((entity) => ({
			json: applyOutputMode(entity, mode, fields, simplified),
		}));
	};
}
