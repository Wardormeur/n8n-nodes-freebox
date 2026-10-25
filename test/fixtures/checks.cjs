// Builds fixture workflows that check themselves: after each step, an If node
// tests the step's output and a Stop and Error node ends the run with a
// message when the check fails. The workflow stays an ordinary n8n workflow:
// import it in the editor and run it there, or from the CLI with the skill's
// scripts/n8n-run.mjs, which exits 1 when the execution fails.
//
//   const { buildChain, check } = require('./checks.cjs');
//   buildChain({
//     id: 'xFixtureAll01', name: 'X fixture: all operations',
//     nodeType: 'CUSTOM.x', credentials: { xApi: 'auto' },
//     steps: [
//       { name: 'Get Many', parameters: {...}, check: [check.noError(), check.atLeast(1), check.hasKeys(['id'])] },
//       { name: 'Get', parameters: { id: "={{ $('Get Many').first().json.id }}" }, check: check.noError() },
//       { name: 'Refused', parameters: {...}, check: check.failsWith('insufficient_rights') },
//     ],
//   });
//
// A check is a JavaScript expression over `items`: the step's output items'
// json, as an array. Checks are about shape (counts, keys, error codes), not
// values: live API data changes.
const fs = require('fs');

const check = {
	/** No output item is an error item (from Continue On Fail or onError). */
	noError: () => ({ label: 'no error', expr: 'items.every((j) => !j.error)' }),
	/** At least n items. Lists the node outputs even when empty (alwaysOutputData) give one empty item. */
	atLeast: (n) => ({ label: `at least ${n} item(s)`, expr: `items.length >= ${n}` }),
	/** Exactly n items, e.g. a Limit. */
	count: (n) => ({ label: `exactly ${n} item(s)`, expr: `items.length === ${n}` }),
	/** Every item has these keys. */
	hasKeys: (keys) => ({
		label: `keys ${keys.join(', ')}`,
		expr: `items.every((j) => ${JSON.stringify(keys)}.every((k) => k in j))`,
	}),
	/** Every item has only these keys (e.g. Output = Selected Fields). */
	onlyKeys: (keys) => ({
		label: `only keys ${keys.join(', ')}`,
		expr: `items.every((j) => Object.keys(j).every((k) => ${JSON.stringify(keys)}.includes(k)))`,
	}),
	/** A key name that must not appear at any depth (secrets). */
	neverKey: (key) => ({
		label: `no "${key}" anywhere`,
		expr: `!JSON.stringify(items).includes(${JSON.stringify(`"${key}":`)})`,
	}),
	/** The step must fail with a message matching this text. Sets onError to continue on the step. */
	failsWith: (text) => ({
		label: `fails with "${text}"`,
		expr: `items.length === 1 && String(items[0].error ?? '').includes(${JSON.stringify(text)})`,
		expectsError: true,
	}),
	/** Any other expression over items. */
	expr: (label, expr) => ({ label, expr }),
};

const ifNode = (id, name, position, expr) => ({
	id,
	name,
	type: 'n8n-nodes-base.if',
	typeVersion: 2.3,
	position,
	executeOnce: true,
	parameters: {
		conditions: {
			options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 3 },
			conditions: [{ id: `${id}c`, leftValue: `={{ ${expr} }}`, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
			combinator: 'and',
		},
		options: {},
	},
});

// waitSeconds: a Wait node before each step after the first, for rate-limited
// APIs (under 65 s it stays in-process, so `n8n execute` handles it).
// settings: node settings for every step, e.g. { retryOnFail: true, maxTries: 3,
// waitBetweenTries: 5000 } for an API that answers 503 when busy; a step's own
// `settings` override them.
function buildChain({ id, name, nodeType, typeVersion = 1, credentials, steps, file, waitSeconds = 0, settings = {} }) {
	const nodes = [{ id: 'start', name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }];
	const connections = {};
	const link = (from, to, output = 0) => {
		connections[from] ??= { main: [] };
		while (connections[from].main.length <= output) connections[from].main.push([]);
		connections[from].main[output].push({ node: to, type: 'main', index: 0 });
	};
	let previous = 'Start';
	steps.forEach((step, index) => {
		const checks = [step.check ?? []].flat();
		const x = (index + 1) * 440;
		if (waitSeconds && index > 0) {
			const waitName = `Wait before ${step.name}`;
			nodes.push({
				id: `w${index}`,
				name: waitName,
				type: 'n8n-nodes-base.wait',
				typeVersion: 1.1,
				position: [x - 110, -200],
				executeOnce: true,
				parameters: { amount: waitSeconds },
			});
			link(previous, waitName);
			previous = waitName;
		}
		nodes.push({
			id: `s${index}`,
			name: step.name,
			type: nodeType,
			typeVersion,
			position: [x, 0],
			parameters: step.parameters,
			...(credentials ? { credentials } : {}),
			// Chained steps run once, so a list output doesn't fan out into the next step.
			executeOnce: true,
			// Lists can be legitimately empty.
			alwaysOutputData: true,
			...(checks.some((c) => c.expectsError) ? { onError: 'continueRegularOutput' } : {}),
			...settings,
			...step.settings,
		});
		link(previous, step.name);
		previous = step.name;
		if (!checks.length) return;
		const items = `$('${step.name}').all().map((i) => i.json)`;
		const expr = `((items) => ${checks.map((c) => `(${c.expr})`).join(' && ')})(${items})`;
		const checkName = `Check: ${step.name}`;
		const stopName = `Failed: ${step.name}`;
		nodes.push(ifNode(`c${index}`, checkName, [x + 220, 0], expr));
		nodes.push({
			id: `f${index}`,
			name: stopName,
			type: 'n8n-nodes-base.stopAndError',
			typeVersion: 1,
			position: [x + 220, 200],
			parameters: {
				// Names only the checks that failed, then the start of the output.
				errorMessage: `={{ ((items) => ${JSON.stringify(`${step.name}: expected `)} + [${checks
					.map((c) => `[${JSON.stringify(c.label)}, (${c.expr})]`)
					.join(', ')}].filter((pair) => !pair[1]).map((pair) => pair[0]).join(', ') + '; got ' + JSON.stringify(items).slice(0, 400))(${items}) }}`,
			},
		});
		link(step.name, checkName);
		link(checkName, stopName, 1);
		previous = checkName;
	});
	const workflow = { id, name, nodes, connections, settings: {} };
	if (file) fs.writeFileSync(file, JSON.stringify(workflow, null, '\t') + '\n');
	return workflow;
}

module.exports = { buildChain, check };
