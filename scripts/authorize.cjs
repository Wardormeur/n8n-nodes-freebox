// One-time Freebox app authorization. Run from a computer on the Freebox's
// network (the box refuses token requests from outside: denied_from_external_ip):
//   node scripts/authorize.cjs
// The Freebox display then asks to accept "n8n"; press the right arrow to
// accept. The app_token is saved to .env (gitignored) as FREEBOX_APP_TOKEN,
// with FREEBOX_APP_ID. Grant the app its permissions afterwards in Freebox OS:
// Parametres de la Freebox > Gestion des acces > Applications.
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = process.env.FREEBOX_URL || 'http://mafreebox.freebox.fr';
const APP_ID = 'fr.wardormeur.n8n';
const envFile = path.join(__dirname, '..', '.env');

async function api(method, url, body) {
	const res = await fetch(`${BASE}/api/v8/${url}`, {
		method,
		headers: { 'Content-Type': 'application/json' },
		body: body ? JSON.stringify(body) : undefined,
	});
	const json = await res.json();
	if (!json.success) throw new Error(`${method} ${url}: ${json.error_code} ${json.msg ?? ''}`);
	return json.result;
}

function saveEnv(values) {
	const lines = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8').split(/\r?\n/) : [];
	const kept = lines.filter((l) => l && !Object.keys(values).some((k) => l.startsWith(`${k}=`)));
	for (const [k, v] of Object.entries(values)) kept.push(`${k}=${v}`);
	fs.writeFileSync(envFile, kept.join('\n') + '\n', { mode: 0o600 });
}

(async () => {
	const { app_token: appToken, track_id: trackId } = await api('POST', 'login/authorize/', {
		app_id: APP_ID,
		app_name: 'n8n',
		app_version: '0.1.0',
		device_name: os.hostname(),
	});
	console.log('Accept "n8n" on the Freebox display (right arrow). Waiting up to 2 minutes...');
	const deadline = Date.now() + 120000;
	for (;;) {
		const { status } = await api('GET', `login/authorize/${trackId}`);
		if (status === 'granted') break;
		if (status !== 'pending') throw new Error(`authorization ${status}`);
		if (Date.now() > deadline) throw new Error('timed out waiting for the button press');
		await new Promise((r) => setTimeout(r, 2000));
	}
	saveEnv({ FREEBOX_APP_ID: APP_ID, FREEBOX_APP_TOKEN: appToken });
	console.log(`Granted. Saved FREEBOX_APP_ID and FREEBOX_APP_TOKEN to ${envFile}.`);
	console.log('Next: Freebox OS > Parametres de la Freebox > Gestion des acces > Applications > n8n: tick the permissions the node needs.');
})().catch((e) => {
	console.error(e.message);
	process.exit(1);
});
