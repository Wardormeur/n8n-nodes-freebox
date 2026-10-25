// Generates the self-checking fixture workflows (see checks.cjs):
//   all-operations.json  every read operation, chained Start -> op -> check -> op ...
//   safe-writes.json     writes that change nothing (set a value to its current value)
// Run one with
//   node <skill>/scripts/n8n-run.mjs test/fixtures/all-operations.json --count-http mafreebox.freebox.fr
// It exits 1, naming the step, when a check fails. They can also be imported
// and run in the n8n editor.
const path = require('path');
const { buildChain, check } = require('./checks.cjs');

const common = { nodeType: 'CUSTOM.freebox', credentials: { freeboxApi: 'auto' } };
const ok = (...more) => [check.noError(), ...more];

buildChain({
	...common,
	id: 'freeboxFixtureAll1',
	name: 'Freebox fixture: all operations',
	file: path.join(__dirname, 'all-operations.json'),
	steps: [
		{ name: 'System: Get', parameters: { resource: 'system', operation: 'get' }, check: ok(check.hasKeys(['model_info', 'firmware_version', 'uptime_val'])) },
		{ name: 'Connection: Get Status', parameters: { resource: 'connection', operation: 'getStatus' }, check: ok(check.hasKeys(['state', 'media', 'rate_down'])) },
		{ name: 'Connection: Get Line', parameters: { resource: 'connection', operation: 'getLine' }, check: ok(check.hasKeys(['media'])) },
		{ name: 'Connection: Get Configuration', parameters: { resource: 'connection', operation: 'getConfig' }, check: ok(check.count(1)) },
		{ name: 'Device: Get Many (active)', parameters: { resource: 'device', operation: 'getAll', activeOnly: true, returnAll: true }, check: ok(check.atLeast(1), check.hasKeys(['id', 'primary_name']), check.expr('all active', 'items.every((j) => j.active === true)')) },
		{ name: 'Device: Get Many (limit 3, fields)', parameters: { resource: 'device', operation: 'getAll', limit: 3, output: 'fields', fields: ['primary_name', 'active'] }, check: ok(check.count(3), check.onlyKeys(['id', 'primary_name', 'active'])) },
		{ name: 'Device: Get (first device)', parameters: { resource: 'device', operation: 'get', deviceId: "={{ $('Device: Get Many (limit 3, fields)').first().json.id }}" }, check: ok(check.count(1), check.hasKeys(['id', 'primary_name'])) },
		{ name: 'Wi-Fi: Get State', parameters: { resource: 'wifi', operation: 'getState' }, check: ok(check.hasKeys(['enabled'])) },
		{ name: 'Wi-Fi: Get Access Points', parameters: { resource: 'wifi', operation: 'getAccessPoints', returnAll: true }, check: ok(check.atLeast(1), check.hasKeys(['id', 'status'])) },
		{ name: 'Wi-Fi: Get Networks', parameters: { resource: 'wifi', operation: 'getNetworks', returnAll: true }, check: ok(check.atLeast(1), check.neverKey('key'), check.neverKey('wps_pin')) },
		{ name: 'DHCP Lease: Get Many', parameters: { resource: 'dhcpLease', operation: 'getAll', returnAll: true }, check: ok(check.atLeast(1), check.hasKeys(['mac', 'ip'])) },
		{ name: 'Download: Get Many', parameters: { resource: 'download', operation: 'getAll', returnAll: true }, check: ok() },
		{ name: 'Download: Get Statistics', parameters: { resource: 'download', operation: 'getStats' }, check: ok(check.hasKeys(['nb_tasks', 'throttling_mode'])) },
		{ name: 'Download: Get Speed Mode', parameters: { resource: 'download', operation: 'getSpeedMode' }, check: ok(check.hasKeys(['throttling', 'is_scheduled'])) },
		{ name: 'Call: Get Many (missed, 5)', parameters: { resource: 'call', operation: 'getAll', limit: 5, filters: { types: ['missed'] } }, check: ok(check.expr('at most 5, all missed', "items.length <= 5 && items.every((j) => !('type' in j) || j.type === 'missed')")) },
		{ name: 'Voicemail: Get Many', parameters: { resource: 'voicemail', operation: 'getAll', returnAll: true }, check: ok() },
		{ name: 'Contact: Get Many', parameters: { resource: 'contact', operation: 'getAll', returnAll: true }, check: ok() },
	],
});

// Writes that leave the box as it was. Writes needing a permission the app
// may not have (settings, parental, player) are left out: whether they pass
// depends on what the user granted.
buildChain({
	...common,
	id: 'freeboxFixtureWrites1',
	name: 'Freebox fixture: safe writes',
	file: path.join(__dirname, 'safe-writes.json'),
	steps: [
		{ name: 'Speed Mode: before', parameters: { resource: 'download', operation: 'getSpeedMode' }, check: ok(check.hasKeys(['throttling', 'is_scheduled'])) },
		{
			name: 'Speed Mode: set to current',
			parameters: {
				resource: 'download',
				operation: 'setSpeedMode',
				throttling: "={{ $('Speed Mode: before').first().json.is_scheduled ? 'schedule' : $('Speed Mode: before').first().json.throttling }}",
			},
			check: ok(
				check.expr(
					'same mode as before',
					"items[0].throttling === $('Speed Mode: before').first().json.throttling && items[0].is_scheduled === $('Speed Mode: before').first().json.is_scheduled",
				),
			),
		},
		{ name: 'Download: missing ID', parameters: { resource: 'download', operation: 'update', downloadId: '={{ undefined }}', updateFields: { status: 'stopped' } }, check: check.failsWith('must be a numeric ID') },
	],
});
console.log('wrote all-operations.json, safe-writes.json');
