import type { IExecuteSingleFunctions, IN8nHttpFullResponse } from 'n8n-workflow';
import { applyOutputMode, outputList, outputSingle, simplifiedWithIncludes } from '../actions/output';

const record = {
	id: 'a1',
	name: 'Example',
	'sort-name': 'Example',
	country: 'US',
	'life-span': { begin: '1987' },
	tags: [{ name: 'grunge' }],
};
const simplified = ['id', 'name', 'country', 'score'];

// Resolves dotted paths like n8n does (lodash get), e.g. 'options.include'.
function ctx(params: Record<string, unknown>) {
	return {
		getNodeParameter: (name: string, fallback: unknown) => {
			const value = name
				.split('.')
				.reduce<unknown>((obj, key) => (obj as Record<string, unknown> | undefined)?.[key], params);
			return value === undefined ? fallback : value;
		},
	} as unknown as IExecuteSingleFunctions;
}

describe('applyOutputMode', () => {
	it('returns the raw object in raw mode', () => {
		expect(applyOutputMode(record, 'raw', [], simplified)).toBe(record);
	});

	it('keeps only the simplified fields that exist', () => {
		expect(applyOutputMode(record, 'simple', [], simplified)).toEqual({
			id: 'a1',
			name: 'Example',
			country: 'US',
		});
	});

	it('always includes the ID in selected-fields mode', () => {
		expect(applyOutputMode(record, 'fields', ['life-span'], simplified)).toEqual({
			id: 'a1',
			'life-span': { begin: '1987' },
		});
	});

	it('returns just the ID when no fields are selected', () => {
		expect(applyOutputMode(record, 'fields', [], simplified)).toEqual({ id: 'a1' });
	});
});

describe('postReceive hooks', () => {
	it('outputSingle trims each item and defaults to simplified', async () => {
		const result = await outputSingle(simplified).call(ctx({}), [{ json: record }]);
		expect(result).toEqual([{ json: { id: 'a1', name: 'Example', country: 'US' } }]);
	});

	it('outputList emits one item per entity in the list key', async () => {
		const response = { body: { count: 2, offset: 0, records: [record, { ...record, id: 'a2' }] } };
		const result = await outputList('records', simplified).call(
			ctx({ output: 'fields', fields: ['name'] }),
			[{ json: {} }],
			response as unknown as IN8nHttpFullResponse,
		);
		expect(result.map((i) => i.json)).toEqual([
			{ id: 'a1', name: 'Example' },
			{ id: 'a2', name: 'Example' },
		]);
	});

	it('outputList returns no items when the list key is missing', async () => {
		const result = await outputList('records', simplified).call(
			ctx({}),
			[{ json: {} }],
			{ body: { count: 0 } } as unknown as IN8nHttpFullResponse,
		);
		expect(result).toEqual([]);
	});

	it('outputList keeps included keys in Simplified mode, from a dotted parameter path', async () => {
		const response = { body: { records: [{ ...record, rating: { value: 4 } }] } };
		const result = await outputList('records', simplified, {
			parameter: 'options.include',
			responseKeys: { ratings: 'rating' },
		}).call(ctx({ options: { include: ['tags', 'ratings'] } }), [{ json: {} }], response as unknown as IN8nHttpFullResponse);
		expect(result[0].json).toEqual({
			id: 'a1',
			name: 'Example',
			country: 'US',
			tags: [{ name: 'grunge' }],
			rating: { value: 4 },
		});
	});

	it('outputSingle without include options ignores any include parameter', async () => {
		const result = await outputSingle(simplified).call(ctx({ include: ['tags'] }), [{ json: record }]);
		expect(result[0].json).not.toHaveProperty('tags');
	});
});

describe('simplifiedWithIncludes', () => {
	it('adds mapped and unmapped include keys once', () => {
		expect(simplifiedWithIncludes(['id', 'name'], ['tags', 'url-rels', 'artist-rels'], {
			'url-rels': 'relations',
			'artist-rels': 'relations',
		})).toEqual(['id', 'name', 'tags', 'relations']);
	});
});
