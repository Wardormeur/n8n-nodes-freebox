import { createHmac } from 'crypto';
import type { IExecuteFunctions, IHttpRequestOptions } from 'n8n-workflow';

import {
	accessOverride,
	downloadForm,
	filterCalls,
	macFromDevice,
	OPERATIONS,
	RESOURCES,
	withoutWifiSecrets,
} from '../actions/operations';
import { Freebox } from '../Freebox.node';
import {
	clearFreeboxCache,
	freeboxApiRequest,
	FreeboxApiError,
	fromLegacyRequest,
	sessionPassword,
	type FreeboxCredentials,
} from '../transport';

const credentials: FreeboxCredentials = {
	baseUrl: 'http://box.test',
	appId: 'fr.test.app',
	appToken: 'app-token',
};

/** A fake Freebox: api_version, login challenge, sessions, one API path. */
function fakeBox(options: { expireFirstSession?: boolean; result?: unknown } = {}) {
	const calls: string[] = [];
	let sessionsOpened = 0;
	let validSession = '';
	const request = async (o: IHttpRequestOptions) => {
		const path = o.url.replace('http://box.test', '');
		calls.push(`${o.method} ${path}`);
		if (path === '/api_version') return { statusCode: 200, body: { api_version: '16.1', api_base_url: '/api/' } };
		if (path === '/api/v16/login/') return { statusCode: 200, body: { success: true, result: { challenge: `c${sessionsOpened}` } } };
		if (path === '/api/v16/login/session/') {
			const body = o.body as { app_id: string; password: string };
			if (body.app_id !== 'fr.test.app' || body.password !== sessionPassword('app-token', `c${sessionsOpened}`)) {
				return { statusCode: 403, body: { success: false, error_code: 'invalid_token', msg: 'Erreur' } };
			}
			sessionsOpened++;
			validSession = `s${sessionsOpened}`;
			return { statusCode: 200, body: { success: true, result: { session_token: validSession } } };
		}
		const session = (o.headers as Record<string, string> | undefined)?.['X-Fbx-App-Auth'];
		if (session !== validSession || (options.expireFirstSession && session === 's1')) {
			return { statusCode: 403, body: { success: false, error_code: 'auth_required', msg: 'Invalid session' } };
		}
		return { statusCode: 200, body: 'result' in options ? { success: true, result: options.result } : { success: true } };
	};
	return { request, calls, opened: () => sessionsOpened };
}

beforeEach(() => clearFreeboxCache());

describe('sessionPassword', () => {
	it('is the hex HMAC-SHA1 of the challenge keyed by the app token', () => {
		const expected = createHmac('sha1', 'dyNYgfK0Ya6FWGqq83sBHa7TwzWo+pg4fDFUJHShcjVYzTfaRrZzm93p7OTAfH/0')
			.update('VzhbtpR4r8CLaJle2QgJBEkyd8JPb0zL')
			.digest('hex');
		expect(sessionPassword('dyNYgfK0Ya6FWGqq83sBHa7TwzWo+pg4fDFUJHShcjVYzTfaRrZzm93p7OTAfH/0', 'VzhbtpR4r8CLaJle2QgJBEkyd8JPb0zL')).toBe(expected);
		expect(expected).toMatch(/^[0-9a-f]{40}$/);
	});
});

describe('freeboxApiRequest', () => {
	it('discovers the API version, opens a session and returns the result', async () => {
		const box = fakeBox({ result: { uptime: '3 jours' } });
		await expect(freeboxApiRequest(box.request, credentials, 'GET', 'system/')).resolves.toEqual({ uptime: '3 jours' });
		expect(box.calls).toEqual(['GET /api_version', 'GET /api/v16/login/', 'POST /api/v16/login/session/', 'GET /api/v16/system/']);
	});

	it('reuses the session and the API base on later requests', async () => {
		const box = fakeBox({ result: [] });
		await freeboxApiRequest(box.request, credentials, 'GET', 'downloads/');
		await freeboxApiRequest(box.request, credentials, 'GET', 'downloads/');
		expect(box.opened()).toBe(1);
		expect(box.calls.filter((c) => c === 'GET /api_version')).toHaveLength(1);
	});

	it('re-opens the session once when the box answers 403 auth_required', async () => {
		const box = fakeBox({ expireFirstSession: true, result: { ok: true } });
		await expect(freeboxApiRequest(box.request, credentials, 'GET', 'system/')).resolves.toEqual({ ok: true });
		expect(box.opened()).toBe(2);
	});

	it('returns undefined for an empty list (the box omits result)', async () => {
		const box = fakeBox();
		await expect(freeboxApiRequest(box.request, credentials, 'GET', 'contact/')).resolves.toBeUndefined();
	});

	it('explains a wrong app token', async () => {
		const box = fakeBox();
		const error = await freeboxApiRequest(box.request, { ...credentials, appToken: 'wrong' }, 'GET', 'system/').catch((e) => e);
		expect(error).toBeInstanceOf(FreeboxApiError);
		expect(error.message).toMatch(/Opening a Freebox session failed.*invalid_token/);
	});

	it('reports a missing box', async () => {
		const request = async () => ({ statusCode: 404, body: {} });
		await expect(freeboxApiRequest(request, credentials, 'GET', 'system/')).rejects.toThrow(/No Freebox answered/);
	});
});

describe('fromLegacyRequest', () => {
	it('maps httpRequest options to request-promise options', async () => {
		const seen: Array<Record<string, unknown>> = [];
		const requester = fromLegacyRequest(async (options) => {
			seen.push(options as Record<string, unknown>);
			return { statusCode: 200, body: { success: true } };
		});
		await requester({ method: 'POST', url: 'https://box/api', body: { a: 1 }, skipSslCertificateValidation: true });
		expect(seen[0]).toMatchObject({
			method: 'POST',
			uri: 'https://box/api',
			body: { a: 1 },
			json: true,
			resolveWithFullResponse: true,
			simple: false,
			rejectUnauthorized: false,
		});
	});
});

describe('withoutWifiSecrets', () => {
	it('drops the Wi-Fi password and WPS PIN, keeps the rest', () => {
		const bss = { id: 'aa', config: { ssid: 'Home', key: 'secret', encryption: 'wpa3' }, shared_bss_params: { key: 'secret', wps_pin: '1234' } };
		const clean = withoutWifiSecrets(bss);
		expect(JSON.stringify(clean)).not.toContain('secret');
		expect(JSON.stringify(clean)).not.toContain('1234');
		expect(clean).toMatchObject({ id: 'aa', config: { ssid: 'Home', encryption: 'wpa3' } });
		expect(bss.config.key).toBe('secret'); // the input isn't changed
	});
});

describe('filterCalls', () => {
	const calls = [
		{ id: 1, type: 'missed', new: true },
		{ id: 2, type: 'accepted', new: false },
		{ id: 3, type: 'missed', new: false },
		{ id: 4, type: 'outgoing', new: false },
	];
	it('filters by type and unread', () => {
		expect(filterCalls(calls, [], false)).toHaveLength(4);
		expect(filterCalls(calls, ['missed'], false).map((c) => c.id)).toEqual([1, 3]);
		expect(filterCalls(calls, ['missed'], true).map((c) => c.id)).toEqual([1]);
	});
});

describe('write requests', () => {
	/** Runs one operation against a recorder that answers like the box. */
	async function send(resource: string, operation: string, parameters: Record<string, unknown>, answer: unknown = undefined) {
		const sent: IHttpRequestOptions[] = [];
		const request = async (o: IHttpRequestOptions) => {
			const path = o.url.replace('http://box.test', '');
			if (path === '/api_version') return { statusCode: 200, body: { api_version: '16.1', api_base_url: '/api/' } };
			if (path === '/api/v16/login/') return { statusCode: 200, body: { success: true, result: { challenge: 'c' } } };
			if (path === '/api/v16/login/session/') return { statusCode: 200, body: { success: true, result: { session_token: 's' } } };
			sent.push(o);
			return { statusCode: 200, body: answer === undefined ? { success: true } : { success: true, result: answer } };
		};
		const ctx = {
			getCredentials: async () => ({ ...credentials }),
			getNode: () => ({ name: 'Freebox', type: 'CUSTOM.freebox', typeVersion: 1 }),
			getNodeParameter: (name: string, _i: number, fallback: unknown) => (name in parameters ? parameters[name] : fallback),
			helpers: { httpRequest: request },
		} as unknown as IExecuteFunctions;
		const op = OPERATIONS.find((o) => o.resource === resource && o.value === operation)!;
		const output = await op.run(ctx, 0);
		const [call] = sent;
		return { method: call.method, path: call.url.replace('http://box.test/api/v16/', ''), body: call.body, headers: call.headers, output };
	}

	it('adds a download form-encoded, with the folder in base64', async () => {
		const call = await send('download', 'add', { urls: 'https://a.test/x.iso', addOptions: { folder: '/Freebox/Téléchargements/' } }, { id: 23 });
		expect(call).toMatchObject({ method: 'POST', path: 'downloads/add', output: { id: 23 } });
		expect(call.headers).toMatchObject({ 'Content-Type': 'application/x-www-form-urlencoded' });
		const form = new URLSearchParams(call.body as unknown as string);
		expect(form.get('download_url')).toBe('https://a.test/x.iso');
		expect(Buffer.from(form.get('download_dir')!, 'base64').toString('utf8')).toBe('/Freebox/Téléchargements/');
	});

	it('sends several URLs as one newline-separated list, without a file name', () => {
		expect(downloadForm('https://a.test/1\n\nhttps://a.test/2 ', '', 'ignored')).toEqual({
			download_url_list: 'https://a.test/1\nhttps://a.test/2',
		});
	});

	it('wakes a device by MAC or device ID', async () => {
		expect(macFromDevice(' ether-aa:bb:cc:dd:ee:ff ')).toBe('aa:bb:cc:dd:ee:ff');
		const call = await send('device', 'wake', { mac: 'ether-aa:bb:cc:dd:ee:ff' });
		expect(call).toMatchObject({ method: 'POST', path: 'lan/wol/pub/', body: { mac: 'aa:bb:cc:dd:ee:ff', password: '' } });
		expect(call.output).toEqual({ success: true, mac: 'aa:bb:cc:dd:ee:ff' });
	});

	it('pauses Wi-Fi for minutes (sent as seconds), keeping a band if asked', async () => {
		expect((await send('wifi', 'pause', { duration: 20 })).body).toEqual({ duration: 1200 });
		expect((await send('wifi', 'pause', { duration: 5, keep: '2d4g' })).body).toEqual({ duration: 300, keep: '2d4g' });
		expect((await send('wifi', 'resume', {})).body).toEqual({ duration: 0 });
	});

	it('marks calls and voicemail as read', async () => {
		expect(await send('call', 'markAsRead', { callId: 69 })).toMatchObject({ method: 'PUT', path: 'call/log/69', body: { new: false } });
		expect(await send('call', 'markAllAsRead', {})).toMatchObject({ method: 'POST', path: 'call/log/mark_all_as_read/' });
		expect(await send('voicemail', 'markAsRead', { voicemailId: '20221215_154135_r0334371508.au' })).toMatchObject({
			method: 'PUT',
			path: 'call/voicemail/20221215_154135_r0334371508.au',
			body: { read: true },
		});
	});

	it('updates a download with only the fields given', async () => {
		const call = await send('download', 'update', { downloadId: 16, updateFields: { status: 'stopped' } }, { id: 16, status: 'stopping' });
		expect(call).toMatchObject({ method: 'PUT', path: 'downloads/16', body: { status: 'stopped' } });
	});

	it('sets parental control overrides with an end time, or clears them', async () => {
		expect(accessOverride('denied', 30, 1_000_000_000_000)).toEqual({ override: true, override_mode: 'denied', override_until: 1_000_001_800 });
		expect(accessOverride('allowed', 0)).toEqual({ override: true, override_mode: 'allowed', override_until: 0 });
		const call = await send('parentalControl', 'setAccess', { profileId: 3, mode: 'schedule' });
		expect(call).toMatchObject({ method: 'PUT', path: 'network_control/3', body: { override: false } });
	});

	it('refuses an ID that resolved to nothing instead of calling the box', async () => {
		await expect(send('call', 'markAsRead', { callId: undefined })).rejects.toThrow(/"callId" must be a numeric ID/);
		await expect(send('download', 'update', { downloadId: '', updateFields: {} })).rejects.toThrow(/numeric ID/);
	});

	it('names the missing permission when the box refuses', async () => {
		const request = async (o: IHttpRequestOptions) => {
			const path = o.url.replace('http://box.test', '');
			if (path === '/api_version') return { statusCode: 200, body: { api_version: '16.1' } };
			if (path === '/api/v16/login/') return { statusCode: 200, body: { success: true, result: { challenge: 'c' } } };
			if (path === '/api/v16/login/session/') return { statusCode: 200, body: { success: true, result: { session_token: 's' } } };
			return { statusCode: 403, body: { success: false, error_code: 'insufficient_rights', missing_right: 'settings', msg: 'Refusé' } };
		};
		await expect(freeboxApiRequest(request, credentials, 'POST', 'lan/wol/pub/', { body: { mac: 'x' } })).rejects.toThrow(
			/POST lan\/wol\/pub\/ failed.*insufficient_rights.*"settings" permission/,
		);
	});
});

describe('node description', () => {
	const { description } = new Freebox();

	it('has an operation list for every resource, and only known operations', () => {
		for (const resource of RESOURCES) {
			const operation = description.properties.find(
				(p) => p.name === 'operation' && p.displayOptions?.show?.resource?.[0] === resource.value,
			);
			expect(operation?.options?.length).toBeGreaterThan(0);
		}
		expect(OPERATIONS.every((op) => RESOURCES.some((r) => r.value === op.resource))).toBe(true);
	});

	it('gives list operations Return All + Limit', () => {
		for (const op of OPERATIONS.filter((o) => o.list)) {
			const returnAll = description.properties.find(
				(p) => p.name === 'returnAll' && p.displayOptions?.show?.operation?.[0] === op.value && p.displayOptions?.show?.resource?.[0] === op.resource,
			);
			expect(returnAll).toBeDefined();
		}
	});
});
