import { createHmac } from 'crypto';
import type {
	ICredentialDataDecryptedObject,
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
} from 'n8n-workflow';

/**
 * Freebox OS API access with its own session handling.
 *
 * The box needs a session opened per app: GET login/ for a challenge,
 * password = hmac-sha1(app_token, challenge), POST login/session/. An expired
 * or invalid session is answered with HTTP 403 `auth_required`, which n8n's
 * credential preAuthentication can't handle (it only refreshes after a 401),
 * so this node opens and refreshes the session itself.
 */

export interface FreeboxCredentials {
	baseUrl: string;
	appId: string;
	appToken: string;
	ignoreSslIssues?: boolean;
}

type HttpRequester = (options: IHttpRequestOptions) => Promise<unknown>;

interface FreeboxResponse {
	statusCode: number;
	body: { success?: boolean; result?: unknown; error_code?: string; msg?: string; missing_right?: string };
}

/** A request's query string and body. `form` is sent form-encoded (downloads/add needs it). */
export interface FreeboxRequestOptions {
	qs?: IDataObject;
	body?: IDataObject;
	form?: Record<string, string>;
}

/** The session password: hex HMAC-SHA1 of the challenge, keyed by the app token. */
export function sessionPassword(appToken: string, challenge: string): string {
	return createHmac('sha1', appToken).update(challenge).digest('hex');
}

export class FreeboxApiError extends Error {
	constructor(
		readonly statusCode: number,
		readonly errorCode: string | undefined,
		message: string,
	) {
		super(message);
	}
}

// Kept for the life of the n8n process: one API base and one session per box
// and app, reused across executions until the box says it expired.
const apiBases = new Map<string, string>();
const sessions = new Map<string, string>();

export function clearFreeboxCache() {
	apiBases.clear();
	sessions.clear();
}

export function toCredentials(data: ICredentialDataDecryptedObject): FreeboxCredentials {
	return {
		baseUrl: String(data.baseUrl ?? 'http://mafreebox.freebox.fr').replace(/\/+$/, ''),
		appId: String(data.appId ?? ''),
		appToken: String(data.appToken ?? ''),
		ignoreSslIssues: data.ignoreSslIssues === true,
	};
}

async function raw(
	request: HttpRequester,
	credentials: FreeboxCredentials,
	method: IHttpRequestMethods,
	url: string,
	options: FreeboxRequestOptions & { session?: string } = {},
): Promise<FreeboxResponse> {
	const headers: IDataObject = {};
	if (options.session) headers['X-Fbx-App-Auth'] = options.session;
	if (options.form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
	const response = (await request({
		method,
		url,
		qs: options.qs,
		body: options.form ? new URLSearchParams(options.form).toString() : options.body,
		json: true,
		headers: Object.keys(headers).length ? headers : undefined,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
		skipSslCertificateValidation: credentials.ignoreSslIssues,
	})) as FreeboxResponse;
	return { statusCode: response.statusCode, body: response.body ?? {} };
}

function fail(response: FreeboxResponse, what: string): never {
	const { error_code: code, msg, missing_right: right } = response.body;
	// insufficient_rights: the app lacks a permission the user grants in Freebox OS.
	const hint = right
		? `. The app needs the "${right}" permission: grant it in Freebox OS under Paramètres de la Freebox > Gestion des accès > Applications`
		: '';
	throw new FreeboxApiError(
		response.statusCode,
		code,
		`${what}: ${msg ?? 'Freebox error'}${code ? ` (${code})` : ''}${hint}`,
	);
}

/** https://box/api/vN, from the box's own /api_version (cached). */
async function apiBase(request: HttpRequester, credentials: FreeboxCredentials): Promise<string> {
	const cached = apiBases.get(credentials.baseUrl);
	if (cached) return cached;
	const response = await raw(request, credentials, 'GET', `${credentials.baseUrl}/api_version`);
	const info = response.body as unknown as { api_base_url?: string; api_version?: string };
	if (response.statusCode !== 200 || !info.api_version) {
		throw new FreeboxApiError(response.statusCode, undefined, `No Freebox answered at ${credentials.baseUrl}/api_version`);
	}
	const major = info.api_version.split('.')[0];
	const base = `${credentials.baseUrl}${(info.api_base_url ?? '/api/').replace(/\/+$/, '')}/v${major}`;
	apiBases.set(credentials.baseUrl, base);
	return base;
}

async function openSession(request: HttpRequester, credentials: FreeboxCredentials, base: string): Promise<string> {
	const login = await raw(request, credentials, 'GET', `${base}/login/`);
	const challenge = (login.body.result as IDataObject | undefined)?.challenge;
	if (!login.body.success || typeof challenge !== 'string') fail(login, 'Getting a login challenge failed');
	const session = await raw(request, credentials, 'POST', `${base}/login/session/`, {
		body: { app_id: credentials.appId, password: sessionPassword(credentials.appToken, challenge) },
	});
	const token = (session.body.result as IDataObject | undefined)?.session_token;
	if (!session.body.success || typeof token !== 'string') {
		fail(session, 'Opening a Freebox session failed. Check the App ID and App Token, and that the app is still authorized on the box');
	}
	return token;
}

/**
 * Calls a Freebox API path (e.g. `lan/browser/pub/`) with a session, opening
 * or re-opening the session as needed. Returns the response's `result`;
 * empty lists come back without one, so that is returned as `undefined`.
 */
export async function freeboxApiRequest(
	request: HttpRequester,
	credentials: FreeboxCredentials,
	method: IHttpRequestMethods,
	path: string,
	options: FreeboxRequestOptions = {},
): Promise<unknown> {
	const base = await apiBase(request, credentials);
	const key = `${credentials.baseUrl}|${credentials.appId}`;
	for (let attempt = 0; attempt < 2; attempt++) {
		let session = sessions.get(key);
		if (!session) {
			session = await openSession(request, credentials, base);
			sessions.set(key, session);
		}
		const response = await raw(request, credentials, method, `${base}/${path}`, { ...options, session });
		if (response.body.success) return response.body.result;
		if (response.statusCode === 403 && response.body.error_code === 'auth_required' && attempt === 0) {
			sessions.delete(key); // expired: open a new one and retry once
			continue;
		}
		fail(response, `${method} ${path} failed`);
	}
	throw new FreeboxApiError(403, 'auth_required', 'The Freebox refused the new session');
}

/**
 * Adapts the legacy `helpers.request` (the only HTTP helper a credential test
 * gets) to the httpRequest-style requester used above.
 */
export function fromLegacyRequest(
	request: (options: object) => Promise<{ statusCode: number; body: unknown }>,
): HttpRequester {
	return async (options) => {
		const response = await request({
			method: options.method ?? 'GET',
			uri: options.url,
			qs: options.qs,
			body: options.body,
			headers: options.headers,
			json: true,
			resolveWithFullResponse: true,
			simple: false,
			rejectUnauthorized: !options.skipSslCertificateValidation,
		});
		return { statusCode: response.statusCode, body: response.body };
	};
}

/** freeboxApiRequest bound to a node execution's credentials and HTTP helper. */
export async function freeboxRequest(
	this: IExecuteFunctions,
	path: string,
	method: IHttpRequestMethods = 'GET',
	options: FreeboxRequestOptions = {},
): Promise<unknown> {
	const credentials = toCredentials(await this.getCredentials('freeboxApi'));
	return await freeboxApiRequest((request) => this.helpers.httpRequest(request), credentials, method, path, options);
}
