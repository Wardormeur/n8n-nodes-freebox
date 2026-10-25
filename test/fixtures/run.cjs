// Runs the self-checking fixture workflows (built with checks.cjs) in the
// local n8n and reports PASS/FAIL per file; exits 1 if any failed.
//
//   npm run test:fixtures                        every *.json in this folder
//   npm run test:fixtures -- safe-writes.json    only these
//
// Requires a global `n8n` CLI, this package built and linked into
// ~/.n8n/custom, a credential of each type the fixtures use, and no n8n
// server running on this machine (its task runner port would clash).
// Credentials written as "auto" are replaced by the first local credential
// of that type. Each workflow is imported (overwriting the same ID) and
// executed with `n8n execute`, which exits 1 when a check's Stop and Error
// node fires.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n8n-fixtures-'));

// One command string: `n8n` is a .cmd shim on Windows, so it needs a shell.
function n8n(args) {
	return spawnSync(['n8n', ...args].join(' '), { shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function localCredentials() {
	const file = path.join(workDir, 'creds.json');
	n8n(['export:credentials', '--all', `--output="${file}"`]);
	const list = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
	fs.rmSync(file, { force: true });
	return list.map((c) => ({ id: c.id, name: c.name, type: c.type }));
}

function resolveCredentials(workflow, credentials) {
	for (const node of workflow.nodes) {
		for (const [type, value] of Object.entries(node.credentials ?? {})) {
			if (value !== 'auto') continue;
			const found = credentials.find((c) => c.type === type);
			if (!found) throw new Error(`No ${type} credential in the local n8n instance - create one first.`);
			node.credentials[type] = { id: found.id, name: found.name };
		}
	}
}

// The error is the last line that isn't a stack frame or a Node.js warning.
const lastLine = (text) =>
	text
		.trim()
		.split(/\r?\n/)
		.filter((line) => line.trim() && !/^\s+at |^\(node:\d+\)|^\(Use `node --trace/.test(line))
		.pop() ?? '';

// Seconds between fixtures, so back-to-back runs stay under the API's rate limit.
const PAUSE_SECONDS = Number(process.env.FIXTURE_PAUSE_SECONDS ?? 5);
const pause = (seconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);

const files = process.argv.slice(2).length
	? process.argv.slice(2).map((f) => path.resolve(__dirname, f))
	: fs.readdirSync(__dirname).filter((f) => f.endsWith('.json')).map((f) => path.join(__dirname, f));

if (!files.length) {
	console.error(`No fixture workflows in ${__dirname}: write test/fixtures/build.cjs with checks.cjs and run it.`);
	process.exit(1);
}

let failed = 0;
try {
	const credentials = localCredentials();
	for (const [index, file] of files.entries()) {
		if (index > 0) pause(PAUSE_SECONDS);
		const workflow = JSON.parse(fs.readFileSync(file, 'utf8'));
		resolveCredentials(workflow, credentials);
		const imported = path.join(workDir, 'workflow.json');
		fs.writeFileSync(imported, JSON.stringify([workflow]));
		const importRun = n8n(['import:workflow', `--input="${imported}"`]);
		if (importRun.status !== 0) throw new Error(`import of ${path.basename(file)} failed:\n${importRun.stdout}${importRun.stderr}`);
		const started = Date.now();
		const run = n8n(['execute', '--id', workflow.id]);
		const seconds = ((Date.now() - started) / 1000).toFixed(1);
		if (run.status === 0) {
			console.log(`PASS  ${path.basename(file)} (${seconds} s)`);
		} else {
			failed++;
			console.log(`FAIL  ${path.basename(file)} (${seconds} s)\n      ${lastLine(`${run.stdout}\n${run.stderr}`).slice(0, 600)}`);
		}
	}
} catch (error) {
	console.error(error.message);
	failed++;
} finally {
	fs.rmSync(workDir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
