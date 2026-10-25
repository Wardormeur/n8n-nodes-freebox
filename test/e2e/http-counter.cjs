// Preloaded into the n8n process with NODE_OPTIONS=--require. Logs every
// outgoing http/https request as one JSON line to the file in E2E_HTTP_LOG,
// so an e2e check can count the real HTTP calls n8n's engine made, retries
// included. Inert when E2E_HTTP_LOG is unset.
//
// E2E_HTTP_HEADERS (optional, comma-separated, case-insensitive) adds those
// request headers to each line, e.g. "user-agent" to check that a credential
// is applied without exporting it decrypted. Don't list headers that carry
// secrets (Authorization, API keys): the log is a plain file.
const fs = require('fs');
const http = require('http');
const https = require('https');

const logFile = process.env.E2E_HTTP_LOG;
const wantedHeaders = (process.env.E2E_HTTP_HEADERS || '')
	.split(',')
	.map((h) => h.trim().toLowerCase())
	.filter(Boolean);

function pickHeaders(...sources) {
	const picked = {};
	for (const source of sources) {
		if (!source || typeof source !== 'object') continue;
		for (const [name, value] of Object.entries(source)) {
			if (wantedHeaders.includes(name.toLowerCase())) picked[name.toLowerCase()] = String(value);
		}
	}
	return picked;
}

function describe(protocol, args) {
	const [first, second] = args;
	const options = second && typeof second === 'object' ? second : undefined;
	let url;
	if (typeof first === 'string' || first instanceof URL) {
		url = new URL(String(first));
	} else {
		const host = first.hostname || first.host || 'localhost';
		url = new URL(`${protocol}//${host}${first.path || '/'}`);
	}
	const method = options?.method || (first && first.method) || 'GET';
	const entry = { t: Date.now(), pid: process.pid, method, host: url.hostname, path: url.pathname + url.search };
	if (wantedHeaders.length) {
		entry.headers = pickHeaders(first instanceof URL || typeof first === 'string' ? undefined : first.headers, options?.headers);
	}
	return entry;
}

if (logFile) {
	for (const [protocol, mod] of [
		['http:', http],
		['https:', https],
	]) {
		const original = mod.request;
		mod.request = function (...args) {
			try {
				fs.appendFileSync(logFile, JSON.stringify(describe(protocol, args)) + '\n');
			} catch {
				// never break the request because logging failed
			}
			return original.apply(this, args);
		};
	}
}
