// Seed the local n8n with a test credential from .env (or the environment),
// without the secret appearing in any committed file, command line or output.
// Fill in CONFIG, put the values in .env (listed in .gitignore), then run:
//   node scripts/seed-credential.cjs
//
// n8n import:credentials encrypts a plain `data` object into its store.
// Re-running overwrites the credential with the same ID.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---- fill in for your node ------------------------------------------------
const CONFIG = {
	// The credential class's `name`, e.g. 'discogsApi'.
	credentialType: 'freeboxApi',
	// Shown in n8n's Credentials list.
	displayName: 'Freebox API (test)',
	// Stable ID: re-running replaces this credential instead of adding one.
	id: 'freeboxTestCred01',
	// Credential field name (properties[].name) -> environment variable.
	// Written by scripts/authorize.cjs. The URL defaults to http://mafreebox.freebox.fr.
	fields: {
		appId: 'FREEBOX_APP_ID',
		appToken: 'FREEBOX_APP_TOKEN',
	},
};
// ---------------------------------------------------------------------------

const placeholders = JSON.stringify(CONFIG).match(/__[A-Za-z][A-Za-z0-9 _]*__/g);
if (placeholders) {
	console.error(`Fill in CONFIG in ${__filename} first: ${[...new Set(placeholders)].join(', ')}`);
	process.exit(1);
}

const envFile = path.join(__dirname, '..', '.env');
const dotenv = {};
if (fs.existsSync(envFile)) {
	for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
		const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
		if (match) dotenv[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
	}
}

const data = {};
const secrets = [];
for (const [field, variable] of Object.entries(CONFIG.fields)) {
	const value = process.env[variable] || dotenv[variable];
	if (!value) {
		console.error(`Set ${variable} in .env or the environment first.`);
		process.exit(1);
	}
	data[field] = value;
	secrets.push(value);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n8n-seed-'));
const file = path.join(dir, 'credentials.json');
try {
	fs.writeFileSync(
		file,
		JSON.stringify([{ id: CONFIG.id, name: CONFIG.displayName, type: CONFIG.credentialType, data }]),
		{ mode: 0o600 },
	);
	// One command string: n8n is a .cmd shim on Windows.
	const result = spawnSync(`n8n import:credentials --input="${file}"`, { shell: true, encoding: 'utf8' });
	let output = `${result.stdout}\n${result.stderr}`;
	for (const secret of secrets) output = output.split(secret).join('***');
	console.log(output.trim().split('\n').slice(-3).join('\n'));
	process.exitCode = result.status ?? 1;
} finally {
	fs.rmSync(dir, { recursive: true, force: true });
}
