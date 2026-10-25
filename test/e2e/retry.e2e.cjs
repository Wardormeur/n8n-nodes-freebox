// End-to-end check: counts the real HTTP calls n8n's engine makes for this
// node with Retry On Fail off and on. A mocked node interface can't do this,
// because the retry loop lives in n8n's WorkflowExecute, above the node.
//
// Requires: a global `n8n` CLI, this package built and linked into
// ~/.n8n/custom, and a credential of CONFIG.credentialType in that n8n
// instance. Run with `npm run test:e2e`.
//
// CONFIG.failingParameters must make the API answer a 4xx every time (e.g. an
// invalid ID). n8n retries every error whatever its status, and a 4xx can't
// succeed on a later try, so the call count is deterministic.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---- fill in for your node ------------------------------------------------
const CONFIG = {
	// Linked into ~/.n8n/custom, so n8n registers it as CUSTOM.<node name>.
	// (Installed from npm it would be <package-name>.<node name>.)
	nodeType: 'CUSTOM.freebox',
	credentialType: 'freeboxApi',
	apiHost: 'mafreebox.freebox.fr',
	// Only calls whose path starts with this are counted: the failing request
	// itself, not the api_version / login / session calls around it.
	apiPathPrefix: '/api/v16/downloads/',
	// Node parameters for one operation that always fails with a 4xx.
	// No download has this ID.
	failingParameters: {
		resource: 'download',
		operation: 'get',
		downloadId: 999999,
	},
	// Unique per package: importing a workflow with an existing ID overwrites it.
	workflowId: 'e2eFreeboxRetry01',
};
// ---------------------------------------------------------------------------

const placeholders = JSON.stringify(CONFIG).match(/__[A-Za-z.]+__/g);
if (placeholders) {
	console.error(`Fill in CONFIG in ${__filename} first: ${[...new Set(placeholders)].join(', ')}`);
	process.exit(1);
}

const counter = path.join(__dirname, 'http-counter.cjs').replace(/\\/g, '/');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n8n-e2e-'));

// One command string (paths are quoted by the callers): `n8n` is a .cmd shim
// on Windows, so it needs a shell, and Node deprecates args arrays with shell.
function n8n(args, env = {}) {
	return spawnSync(['n8n', ...args].join(' '), {
		shell: true,
		encoding: 'utf8',
		env: { ...process.env, ...env },
	});
}

function findCredential() {
	const file = path.join(workDir, 'creds.json');
	n8n(['export:credentials', '--all', `--output="${file}"`]);
	const credential = JSON.parse(fs.readFileSync(file, 'utf8')).find(
		(c) => c.type === CONFIG.credentialType,
	);
	fs.rmSync(file);
	if (!credential) {
		throw new Error(
			`No ${CONFIG.credentialType} credential in the local n8n instance - create one first.`,
		);
	}
	return { id: credential.id, name: credential.name };
}

function workflow(credential, retry) {
	return [
		{
			id: CONFIG.workflowId,
			name: 'e2e: retry HTTP count',
			active: false,
			settings: {},
			connections: { Manual: { main: [[{ node: 'Under Test', type: 'main', index: 0 }]] } },
			nodes: [
				{
					id: 'manual',
					name: 'Manual',
					type: 'n8n-nodes-base.manualTrigger',
					typeVersion: 1,
					position: [0, 0],
					parameters: {},
				},
				{
					id: 'underTest',
					name: 'Under Test',
					type: CONFIG.nodeType,
					typeVersion: 1,
					position: [200, 0],
					...retry,
					credentials: { [CONFIG.credentialType]: credential },
					parameters: CONFIG.failingParameters,
				},
			],
		},
	];
}

function countApiCalls(credential, retry) {
	const wfFile = path.join(workDir, 'workflow.json');
	const logFile = path.join(workDir, `http-${Date.now()}.log`);
	fs.writeFileSync(wfFile, JSON.stringify(workflow(credential, retry)));
	const imported = n8n(['import:workflow', `--input="${wfFile}"`]);
	if (imported.status !== 0) throw new Error(`import failed:\n${imported.stdout}${imported.stderr}`);

	n8n(['execute', '--id', CONFIG.workflowId], {
		NODE_OPTIONS: `--require "${counter}"`,
		E2E_HTTP_LOG: logFile,
	});

	const calls = fs.existsSync(logFile)
		? fs
				.readFileSync(logFile, 'utf8')
				.trim()
				.split('\n')
				.filter(Boolean)
				.map((line) => JSON.parse(line))
		: [];
	return calls.filter((c) => c.host === CONFIG.apiHost && c.path.startsWith(CONFIG.apiPathPrefix));
}

const scenarios = [
	{ name: 'Retry On Fail off', retry: { retryOnFail: false }, expected: 1 },
	{
		name: 'Retry On Fail, 3 tries',
		retry: { retryOnFail: true, maxTries: 3, waitBetweenTries: 1000 },
		expected: 3,
	},
];

(async () => {
	const credential = findCredential();
	let failed = 0;
	for (const scenario of scenarios) {
		const calls = countApiCalls(credential, scenario.retry);
		const ok = calls.length === scenario.expected;
		if (!ok) failed++;
		console.log(
			`${ok ? 'PASS' : 'FAIL'}  ${scenario.name}: ${calls.length} HTTP call(s), expected ${scenario.expected}`,
		);
		for (const c of calls) console.log(`        ${c.method} ${c.host}${c.path}`);
		// pause between scenarios to stay clear of the API's rate limit
		await new Promise((resolve) => setTimeout(resolve, 1500));
	}
	fs.rmSync(workDir, { recursive: true, force: true });
	process.exit(failed ? 1 : 0);
})().catch((error) => {
	console.error(error.message);
	process.exit(1);
});
