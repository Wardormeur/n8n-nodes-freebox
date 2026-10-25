import { NodeOperationError } from 'n8n-workflow';
import type { IDataObject, IExecuteFunctions, INodeProperties, INodePropertyOptions } from 'n8n-workflow';

import { freeboxRequest } from '../transport';

/** One operation: its request and how its output is trimmed. */
export interface OperationDef {
	resource: string;
	value: string;
	name: string;
	action: string;
	description: string;
	/** Returns one object, or a list (one output item per entry). */
	run: (ctx: IExecuteFunctions, itemIndex: number) => Promise<IDataObject | IDataObject[]>;
	list?: boolean;
	/** Output = Simplified keeps these keys; omit for small responses (no Output parameter). */
	simplified?: string[];
	/** Extra keys selectable in Output = Selected Fields. */
	extraFields?: string[];
	/** Operation-specific parameters. */
	properties?: INodeProperties[];
}

export const RESOURCES: INodePropertyOptions[] = [
	{ name: 'Call', value: 'call' },
	{ name: 'Connection', value: 'connection' },
	{ name: 'Contact', value: 'contact' },
	{ name: 'DHCP Lease', value: 'dhcpLease' },
	{ name: 'Device', value: 'device' },
	{ name: 'Download', value: 'download' },
	{ name: 'Parental Control', value: 'parentalControl' },
	{ name: 'Player', value: 'player' },
	{ name: 'System', value: 'system' },
	{ name: 'Voicemail', value: 'voicemail' },
	{ name: 'Wi-Fi', value: 'wifi' },
];

const asList = (result: unknown): IDataObject[] => (Array.isArray(result) ? (result as IDataObject[]) : []);
const asObject = (result: unknown): IDataObject => (result && typeof result === 'object' ? (result as IDataObject) : {});
const param = <T>(ctx: IExecuteFunctions, name: string, i: number, fallback: T) =>
	ctx.getNodeParameter(name, i, fallback) as T;
/** A numeric ID parameter; an expression that resolved to nothing must not reach the URL. */
const idParam = (ctx: IExecuteFunctions, name: string, i: number): number => {
	const raw = ctx.getNodeParameter(name, i, undefined);
	const value = Number(raw);
	if (raw === undefined || raw === null || String(raw).trim() === '' || !Number.isInteger(value) || value < 0) {
		throw new NodeOperationError(ctx.getNode(), `"${name}" must be a numeric ID`, { itemIndex: i });
	}
	return value;
};
/** Writes often answer without a result: say it worked, with what was done. */
const done = (result: unknown, details: IDataObject): IDataObject =>
	result && typeof result === 'object' && !Array.isArray(result) ? (result as IDataObject) : { success: true, ...details };

/** A MAC address from a MAC or a device ID such as `ether-aa:bb:cc:dd:ee:ff`. */
export function macFromDevice(value: string): string {
	return value.trim().replace(/^ether-/i, '');
}

/** downloads/add form: one URL or a newline-separated list, an optional folder (sent base64). */
export function downloadForm(urls: string, folder: string, filename: string): Record<string, string> {
	const list = urls
		.split(/[\r\n]+/)
		.map((url) => url.trim())
		.filter(Boolean);
	const form: Record<string, string> =
		list.length > 1 ? { download_url_list: list.join('\n') } : { download_url: list[0] ?? '' };
	if (folder.trim()) form.download_dir = Buffer.from(folder.trim(), 'utf8').toString('base64');
	if (filename.trim() && list.length === 1) form.filename = filename.trim();
	return form;
}

/** Parental control override: a mode until a time (0 = until changed), or back to the schedule. */
export function accessOverride(mode: string, minutes: number, now = Date.now()): IDataObject {
	if (mode === 'schedule') return { override: false };
	return {
		override: true,
		override_mode: mode,
		override_until: minutes > 0 ? Math.floor(now / 1000) + Math.round(minutes * 60) : 0,
	};
}

const deviceIdProperty: INodeProperties = {
	displayName: 'Device ID',
	name: 'deviceId',
	type: 'string',
	required: true,
	default: '',
	placeholder: 'e.g. ether-aa:bb:cc:dd:ee:ff',
	description: 'The `id` of a device from Get Many',
};

const idProperty = (displayName: string, name: string, from: string): INodeProperties => ({
	displayName,
	name,
	type: 'number',
	required: true,
	default: 0,
	description: `The \`id\` of a ${from} from Get Many`,
});

/** Wi-Fi network configs carry the Wi-Fi password: never output it. */
export function withoutWifiSecrets(bss: IDataObject): IDataObject {
	const copy = JSON.parse(JSON.stringify(bss)) as IDataObject;
	for (const part of [copy.config, copy.shared_bss_params, copy.bss_params]) {
		if (part && typeof part === 'object') {
			delete (part as IDataObject).key;
			delete (part as IDataObject).wps_pin;
		}
	}
	return copy;
}

/** Call log filter: by type and unread, newest first as the box returns it. */
export function filterCalls(calls: IDataObject[], types: string[], unreadOnly: boolean): IDataObject[] {
	return calls.filter(
		(call) => (types.length === 0 || types.includes(String(call.type))) && (!unreadOnly || call.new === true),
	);
}

const deviceInterface: INodeProperties = {
	displayName: 'Network Interface',
	name: 'interface',
	type: 'string',
	default: 'pub',
	description: "The box's network interface to browse. `pub` is the home network.",
};

export const OPERATIONS: OperationDef[] = [
	// System
	{
		resource: 'system',
		value: 'get',
		name: 'Get',
		action: 'Get system status',
		description: 'Model, firmware, uptime, temperatures, fans and disk status',
		simplified: ['model_info', 'firmware_version', 'uptime', 'uptime_val', 'sensors', 'fans', 'disk_status', 'box_authenticated'],
		extraFields: ['board_name', 'mac', 'serial', 'usb3_enable', 'user_main_storage', 'user_storage_powered'],
		run: async (ctx) => asObject(await freeboxRequest.call(ctx, 'system/')),
	},
	// Connection
	{
		resource: 'connection',
		value: 'getStatus',
		name: 'Get Status',
		action: 'Get the internet connection status',
		description: 'State, IP addresses, current rates, bandwidth and traffic counters',
		simplified: ['state', 'type', 'media', 'ipv4', 'ipv6', 'rate_down', 'rate_up', 'bandwidth_down', 'bandwidth_up', 'bytes_down', 'bytes_up'],
		extraFields: ['ipv4_port_range'],
		run: async (ctx) => asObject(await freeboxRequest.call(ctx, 'connection/')),
	},
	{
		resource: 'connection',
		value: 'getLine',
		name: 'Get Line',
		action: 'Get the fiber or DSL line status',
		description: 'Optical (FTTH) or DSL line details, whichever the box uses',
		run: async (ctx) => {
			const status = asObject(await freeboxRequest.call(ctx, 'connection/'));
			const media = status.media === 'xdsl' ? 'xdsl' : 'ftth';
			return { media, ...asObject(await freeboxRequest.call(ctx, `connection/${media}/`)) };
		},
	},
	{
		resource: 'connection',
		value: 'getConfig',
		name: 'Get Configuration',
		action: 'Get the connection configuration',
		description: 'Remote access, ping, Wake-on-LAN, ad blocking and other connection settings',
		run: async (ctx) => asObject(await freeboxRequest.call(ctx, 'connection/config/')),
	},
	// Devices (LAN browser)
	{
		resource: 'device',
		value: 'getAll',
		name: 'Get Many',
		action: 'Get many devices',
		description: 'Devices the box has seen on the network, with their names, addresses and activity',
		list: true,
		simplified: ['id', 'primary_name', 'host_type', 'vendor_name', 'active', 'reachable', 'last_activity', 'last_time_reachable', 'l2ident', 'l3connectivities', 'access_point'],
		extraFields: ['names', 'persistent', 'first_activity', 'default_name', 'interface', 'info'],
		properties: [
			deviceInterface,
			{
				displayName: 'Active Only',
				name: 'activeOnly',
				type: 'boolean',
				default: false,
				description: 'Whether to return only devices that are currently active',
			},
		],
		run: async (ctx, i) => {
			const iface = encodeURIComponent(param(ctx, 'interface', i, 'pub'));
			const hosts = asList(await freeboxRequest.call(ctx, `lan/browser/${iface}/`));
			return param(ctx, 'activeOnly', i, false) ? hosts.filter((h) => h.active === true) : hosts;
		},
	},
	{
		resource: 'device',
		value: 'get',
		name: 'Get',
		action: 'Get a device',
		description: 'One device by its ID (e.g. ether-aa:bb:cc:dd:ee:ff)',
		simplified: ['id', 'primary_name', 'host_type', 'vendor_name', 'active', 'reachable', 'last_activity', 'last_time_reachable', 'l2ident', 'l3connectivities', 'access_point'],
		extraFields: ['names', 'persistent', 'first_activity', 'default_name', 'interface', 'info'],
		properties: [deviceInterface, deviceIdProperty],
		run: async (ctx, i) => {
			const iface = encodeURIComponent(param(ctx, 'interface', i, 'pub'));
			const id = encodeURIComponent(param(ctx, 'deviceId', i, '').trim());
			return asObject(await freeboxRequest.call(ctx, `lan/browser/${iface}/${id}/`));
		},
	},
	{
		resource: 'device',
		value: 'rename',
		name: 'Rename',
		action: 'Rename a device',
		description: 'Set the name the box shows for a device',
		properties: [
			deviceInterface,
			deviceIdProperty,
			{
				displayName: 'Name',
				name: 'name',
				type: 'string',
				required: true,
				default: '',
				description: 'The new name',
			},
		],
		run: async (ctx, i) => {
			const iface = encodeURIComponent(param(ctx, 'interface', i, 'pub'));
			const id = param(ctx, 'deviceId', i, '').trim();
			const body = { id, primary_name: param(ctx, 'name', i, '') };
			return asObject(await freeboxRequest.call(ctx, `lan/browser/${iface}/${encodeURIComponent(id)}/`, 'PUT', { body }));
		},
	},
	{
		resource: 'device',
		value: 'wake',
		name: 'Wake',
		action: 'Wake a device',
		description: 'Send a Wake-on-LAN packet to a device on the home network',
		properties: [
			deviceInterface,
			{
				displayName: 'MAC Address or Device ID',
				name: 'mac',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'e.g. aa:bb:cc:dd:ee:ff',
				description: "The device's MAC address, or its `id` from Get Many",
			},
			{
				displayName: 'SecureOn Password',
				name: 'wolPassword',
				type: 'string',
				typeOptions: { password: true },
				default: '',
				description: 'Only for devices set up with a Wake-on-LAN password',
			},
		],
		run: async (ctx, i) => {
			const iface = encodeURIComponent(param(ctx, 'interface', i, 'pub'));
			const mac = macFromDevice(param(ctx, 'mac', i, ''));
			const body = { mac, password: param(ctx, 'wolPassword', i, '') };
			return done(await freeboxRequest.call(ctx, `lan/wol/${iface}/`, 'POST', { body }), { mac });
		},
	},
	// Wi-Fi
	{
		resource: 'wifi',
		value: 'getState',
		name: 'Get State',
		action: 'Get the Wi-Fi state',
		description: 'Whether Wi-Fi is on, its state and power saving',
		run: async (ctx) => ({
			...asObject(await freeboxRequest.call(ctx, 'wifi/config/')),
			...asObject(await freeboxRequest.call(ctx, 'wifi/state/')),
		}),
	},
	{
		resource: 'wifi',
		value: 'getAccessPoints',
		name: 'Get Access Points',
		action: 'Get the Wi-Fi access points',
		description: 'Each radio (band), its channel and status',
		list: true,
		run: async (ctx) => asList(await freeboxRequest.call(ctx, 'wifi/ap/')),
	},
	{
		resource: 'wifi',
		value: 'getNetworks',
		name: 'Get Networks',
		action: 'Get the Wi-Fi networks',
		description: 'Each network (SSID) and its status. The Wi-Fi password is never returned.',
		list: true,
		run: async (ctx) => asList(await freeboxRequest.call(ctx, 'wifi/bss/')).map(withoutWifiSecrets),
	},
	{
		resource: 'wifi',
		value: 'pause',
		name: 'Pause',
		action: 'Pause Wi-Fi for a while',
		description: 'Turn Wi-Fi off for a set time, optionally keeping one band on. It comes back by itself.',
		properties: [
			{
				displayName: 'Duration (Minutes)',
				name: 'duration',
				type: 'number',
				typeOptions: { minValue: 1 },
				default: 10,
				description: 'How long Wi-Fi stays off',
			},
			{
				displayName: 'Keep Band On',
				name: 'keep',
				type: 'options',
				default: 'none',
				options: [
					{ name: 'None (All Bands Off)', value: 'none' },
					{ name: '2.4 GHz', value: '2d4g', description: 'Useful to pair devices that only support 2.4 GHz' },
					{ name: '5 GHz', value: '5g' },
					{ name: '6 GHz', value: '6g' },
				],
			},
		],
		run: async (ctx, i) => {
			const duration = Math.round(param(ctx, 'duration', i, 10) * 60);
			const keep = param(ctx, 'keep', i, 'none');
			const body: IDataObject = keep === 'none' ? { duration } : { duration, keep };
			return done(await freeboxRequest.call(ctx, 'wifi/temp_disable', 'POST', { body }), body);
		},
	},
	{
		resource: 'wifi',
		value: 'resume',
		name: 'Resume',
		action: 'Resume Wi-Fi',
		description: 'End a pause started with Pause',
		run: async (ctx) =>
			done(await freeboxRequest.call(ctx, 'wifi/temp_disable', 'POST', { body: { duration: 0 } }), { duration: 0 }),
	},
	{
		resource: 'wifi',
		value: 'setSchedule',
		name: 'Set Schedule',
		action: 'Turn the Wi-Fi schedule on or off',
		description: 'Whether Wi-Fi follows the on/off schedule set in Freebox OS',
		properties: [
			{
				displayName: 'Use Schedule',
				name: 'usePlanning',
				type: 'boolean',
				default: true,
				description: 'Whether Wi-Fi follows the schedule set in Freebox OS',
			},
		],
		run: async (ctx, i) => {
			const body = { use_planning: param(ctx, 'usePlanning', i, true) };
			const planning = asObject(await freeboxRequest.call(ctx, 'wifi/planning/', 'PUT', { body }));
			delete planning.mapping; // the half-hour slots of the week: noise in a workflow
			return planning;
		},
	},
	// DHCP
	{
		resource: 'dhcpLease',
		value: 'getAll',
		name: 'Get Many',
		action: 'Get many DHCP leases',
		description: 'IP addresses handed out by the box, with host names and MAC addresses',
		list: true,
		properties: [
			{
				displayName: 'Include Static Leases',
				name: 'includeStatic',
				type: 'boolean',
				default: true,
				description: 'Whether to add the static (reserved) leases to the dynamic ones',
			},
		],
		run: async (ctx, i) => {
			const dynamic = asList(await freeboxRequest.call(ctx, 'dhcp/dynamic_lease/'));
			if (!param(ctx, 'includeStatic', i, true)) return dynamic;
			const known = new Set(dynamic.map((lease) => lease.mac));
			const statics = asList(await freeboxRequest.call(ctx, 'dhcp/static_lease/'))
				.filter((lease) => !known.has(lease.mac))
				.map((lease) => ({ ...lease, is_static: true }));
			return [...dynamic, ...statics];
		},
	},
	// Downloads
	{
		resource: 'download',
		value: 'getAll',
		name: 'Get Many',
		action: 'Get many downloads',
		description: 'Downloads (torrents, HTTP, newsgroups) with their status and progress',
		list: true,
		simplified: ['id', 'name', 'type', 'status', 'size', 'rx_pct', 'tx_pct', 'rx_rate', 'tx_rate', 'eta', 'created_ts', 'error'],
		extraFields: ['rx_bytes', 'tx_bytes', 'download_dir', 'queue_pos', 'stop_ratio', 'io_priority', 'info_hash'],
		run: async (ctx) => asList(await freeboxRequest.call(ctx, 'downloads/')),
	},
	{
		resource: 'download',
		value: 'get',
		name: 'Get',
		action: 'Get a download',
		description: 'One download by ID',
		simplified: ['id', 'name', 'type', 'status', 'size', 'rx_pct', 'tx_pct', 'rx_rate', 'tx_rate', 'eta', 'created_ts', 'error'],
		extraFields: ['rx_bytes', 'tx_bytes', 'download_dir', 'queue_pos', 'stop_ratio', 'io_priority', 'info_hash'],
		properties: [
			{
				displayName: 'Download ID',
				name: 'downloadId',
				type: 'number',
				required: true,
				default: 0,
				description: 'The `id` of a download from Get Many',
			},
		],
		run: async (ctx, i) => asObject(await freeboxRequest.call(ctx, `downloads/${idParam(ctx, 'downloadId', i)}`)),
	},
	{
		resource: 'download',
		value: 'getStats',
		name: 'Get Statistics',
		action: 'Get download statistics',
		description: 'Task counts by state, current rates and throttling',
		run: async (ctx) => asObject(await freeboxRequest.call(ctx, 'downloads/stats')),
	},
	{
		resource: 'download',
		value: 'add',
		name: 'Add',
		action: 'Add a download',
		description: 'Download a URL (HTTP, FTP, magnet or .torrent link) to the box',
		properties: [
			{
				displayName: 'URLs',
				name: 'urls',
				type: 'string',
				typeOptions: { rows: 3 },
				required: true,
				default: '',
				placeholder: 'e.g. https://example.com/file.iso',
				description: 'One URL, or several on separate lines',
			},
			{
				displayName: 'Options',
				name: 'addOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'File Name',
						name: 'filename',
						type: 'string',
						default: '',
						description: 'Save under this name (one URL only)',
					},
					{
						displayName: 'Folder',
						name: 'folder',
						type: 'string',
						default: '',
						placeholder: 'e.g. /Freebox/Téléchargements/',
						description: "Where to save it on the box's storage. Defaults to the download folder set in Freebox OS.",
					},
				],
			},
		],
		run: async (ctx, i) => {
			const options = param<IDataObject>(ctx, 'addOptions', i, {});
			const form = downloadForm(param(ctx, 'urls', i, ''), String(options.folder ?? ''), String(options.filename ?? ''));
			return asObject(await freeboxRequest.call(ctx, 'downloads/add', 'POST', { form }));
		},
	},
	{
		resource: 'download',
		value: 'update',
		name: 'Update',
		action: 'Update a download',
		description: 'Pause, resume or retry a download, or change its priority',
		simplified: ['id', 'name', 'type', 'status', 'size', 'rx_pct', 'tx_pct', 'rx_rate', 'tx_rate', 'eta', 'created_ts', 'error'],
		extraFields: ['rx_bytes', 'tx_bytes', 'download_dir', 'queue_pos', 'stop_ratio', 'io_priority', 'info_hash'],
		properties: [
			idProperty('Download ID', 'downloadId', 'download'),
			{
				displayName: 'Update Fields',
				name: 'updateFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				options: [
					{
						displayName: 'Priority',
						name: 'io_priority',
						type: 'options',
						default: 'normal',
						options: [
							{ name: 'Low', value: 'low' },
							{ name: 'Normal', value: 'normal' },
							{ name: 'High', value: 'high' },
						],
					},
					{
						displayName: 'Status',
						name: 'status',
						type: 'options',
						default: 'stopped',
						options: [
							{ name: 'Pause', value: 'stopped' },
							{ name: 'Resume', value: 'downloading' },
							{ name: 'Retry', value: 'retry', description: 'Restart a download that failed' },
							{ name: 'Seed', value: 'seeding', description: 'Share a finished torrent again' },
						],
					},
				],
			},
		],
		run: async (ctx, i) => {
			const body = param<IDataObject>(ctx, 'updateFields', i, {});
			return asObject(await freeboxRequest.call(ctx, `downloads/${idParam(ctx, 'downloadId', i)}`, 'PUT', { body }));
		},
	},
	{
		resource: 'download',
		value: 'getSpeedMode',
		name: 'Get Speed Mode',
		action: 'Get the download speed mode',
		description: 'The current speed mode (normal, slow, hibernate) and whether it follows the schedule',
		run: async (ctx) => asObject(await freeboxRequest.call(ctx, 'downloads/throttling')),
	},
	{
		resource: 'download',
		value: 'setSpeedMode',
		name: 'Set Speed Mode',
		action: 'Set the download speed mode',
		description: 'Force normal, slow or paused (hibernate) download speed, or go back to the schedule',
		properties: [
			{
				displayName: 'Mode',
				name: 'throttling',
				type: 'options',
				default: 'schedule',
				options: [
					{ name: 'Follow Schedule', value: 'schedule' },
					{ name: 'Normal', value: 'normal' },
					{ name: 'Slow', value: 'slow' },
					{ name: 'Hibernate (All Paused)', value: 'hibernate' },
				],
			},
		],
		run: async (ctx, i) => {
			const body = { throttling: param(ctx, 'throttling', i, 'schedule') };
			return asObject(await freeboxRequest.call(ctx, 'downloads/throttling', 'PUT', { body }));
		},
	},
	// Calls
	{
		resource: 'call',
		value: 'getAll',
		name: 'Get Many',
		action: 'Get many calls',
		description: 'The call log, newest first',
		list: true,
		simplified: ['id', 'datetime', 'type', 'number', 'name', 'duration', 'new', 'contact_id'],
		properties: [
			{
				displayName: 'Filters',
				name: 'filters',
				type: 'collection',
				placeholder: 'Add Filter',
				default: {},
				options: [
					{
						displayName: 'Call Type',
						name: 'types',
						type: 'multiOptions',
						default: [],
						options: [
							{ name: 'Accepted', value: 'accepted' },
							{ name: 'Missed', value: 'missed' },
							{ name: 'Outgoing', value: 'outgoing' },
						],
					},
					{
						displayName: 'Unread Only',
						name: 'unreadOnly',
						type: 'boolean',
						default: false,
						description: 'Whether to return only calls not yet marked as read',
					},
				],
			},
		],
		run: async (ctx, i) => {
			const filters = param<IDataObject>(ctx, 'filters', i, {});
			const calls = asList(await freeboxRequest.call(ctx, 'call/log/'));
			return filterCalls(calls, (filters.types as string[] | undefined) ?? [], filters.unreadOnly === true);
		},
	},
	{
		resource: 'call',
		value: 'markAsRead',
		name: 'Mark as Read',
		action: 'Mark a call as read',
		description: 'Mark one call log entry as read',
		properties: [idProperty('Call ID', 'callId', 'call')],
		run: async (ctx, i) =>
			asObject(await freeboxRequest.call(ctx, `call/log/${idParam(ctx, 'callId', i)}`, 'PUT', { body: { new: false } })),
	},
	{
		resource: 'call',
		value: 'markAllAsRead',
		name: 'Mark All as Read',
		action: 'Mark all calls as read',
		description: 'Mark every call log entry as read',
		run: async (ctx) => done(await freeboxRequest.call(ctx, 'call/log/mark_all_as_read/', 'POST'), {}),
	},
	{
		resource: 'voicemail',
		value: 'getAll',
		name: 'Get Many',
		action: 'Get many voicemails',
		description: 'Voicemail messages (not the audio)',
		list: true,
		run: async (ctx) => asList(await freeboxRequest.call(ctx, 'call/voicemail/')),
	},
	{
		resource: 'voicemail',
		value: 'markAsRead',
		name: 'Mark as Read',
		action: 'Mark a voicemail as read',
		description: 'Mark one voicemail message as listened to',
		properties: [
			{
				displayName: 'Voicemail ID',
				name: 'voicemailId',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'e.g. 20221215_154135_r0334371508.au',
				description: 'The `id` of a voicemail from Get Many',
			},
		],
		run: async (ctx, i) => {
			const id = encodeURIComponent(param(ctx, 'voicemailId', i, '').trim());
			return asObject(await freeboxRequest.call(ctx, `call/voicemail/${id}`, 'PUT', { body: { read: true } }));
		},
	},
	// Contacts
	{
		resource: 'contact',
		value: 'getAll',
		name: 'Get Many',
		action: 'Get many contacts',
		description: "The box's address book",
		list: true,
		run: async (ctx) => asList(await freeboxRequest.call(ctx, 'contact/')),
	},
	{
		resource: 'contact',
		value: 'get',
		name: 'Get',
		action: 'Get a contact',
		description: 'One contact by ID, with phone numbers',
		properties: [
			{
				displayName: 'Contact ID',
				name: 'contactId',
				type: 'number',
				required: true,
				default: 0,
				description: 'The `id` of a contact from Get Many (or `contact_id` from a call)',
			},
		],
		run: async (ctx, i) => asObject(await freeboxRequest.call(ctx, `contact/${idParam(ctx, 'contactId', i)}`)),
	},
	// Parental control (per profile)
	{
		resource: 'parentalControl',
		value: 'getAll',
		name: 'Get Many',
		action: 'Get parental control for every profile',
		description: "Each profile's current internet access, its devices and next scheduled change",
		list: true,
		run: async (ctx) => asList(await freeboxRequest.call(ctx, 'network_control/')),
	},
	{
		resource: 'parentalControl',
		value: 'setAccess',
		name: 'Set Access',
		action: "Set a profile's internet access",
		description: "Allow or block a profile's internet access for a while, or go back to its schedule",
		properties: [
			{
				displayName: 'Profile ID',
				name: 'profileId',
				type: 'number',
				required: true,
				default: 0,
				description: 'The `profile_id` from Get Many',
			},
			{
				displayName: 'Access',
				name: 'mode',
				type: 'options',
				default: 'denied',
				options: [
					{ name: 'Block', value: 'denied' },
					{ name: 'Allow', value: 'allowed' },
					{ name: 'Follow Schedule', value: 'schedule', description: 'Remove the override' },
				],
			},
			{
				displayName: 'Duration (Minutes)',
				name: 'duration',
				type: 'number',
				typeOptions: { minValue: 0 },
				default: 60,
				description: 'How long the override lasts. 0 keeps it until changed.',
				displayOptions: { hide: { mode: ['schedule'] } },
			},
		],
		run: async (ctx, i) => {
			const mode = param<string>(ctx, 'mode', i, 'denied');
			const body = accessOverride(mode, mode === 'schedule' ? 0 : param(ctx, 'duration', i, 60));
			return asObject(await freeboxRequest.call(ctx, `network_control/${idParam(ctx, 'profileId', i)}`, 'PUT', { body }));
		},
	},
	// Freebox Player
	{
		resource: 'player',
		value: 'getAll',
		name: 'Get Many',
		action: 'Get many players',
		description: 'Freebox Players on the network and whether their API is reachable',
		list: true,
		run: async (ctx) => asList(await freeboxRequest.call(ctx, 'player/')),
	},
	{
		resource: 'player',
		value: 'mediaControl',
		name: 'Media Control',
		action: 'Control playback on a player',
		description: 'Play/pause, stop, previous or next on what the player is playing',
		properties: [
			idProperty('Player ID', 'playerId', 'player'),
			{
				displayName: 'Command',
				name: 'command',
				type: 'options',
				default: 'play_pause',
				options: [
					{ name: 'Play/Pause', value: 'play_pause' },
					{ name: 'Stop', value: 'stop' },
					{ name: 'Previous', value: 'prev' },
					{ name: 'Next', value: 'next' },
				],
			},
		],
		run: async (ctx, i) => {
			const cmd = param(ctx, 'command', i, 'play_pause');
			const path = `player/${idParam(ctx, 'playerId', i)}/api/v6/control/mediactrl/`;
			return done(await freeboxRequest.call(ctx, path, 'POST', { body: { cmd } }), { cmd });
		},
	},
	{
		resource: 'player',
		value: 'setVolume',
		name: 'Set Volume',
		action: "Set a player's volume",
		description: 'Set the volume, or mute or unmute',
		properties: [
			idProperty('Player ID', 'playerId', 'player'),
			{
				displayName: 'Volume',
				name: 'volume',
				type: 'number',
				typeOptions: { minValue: 0, maxValue: 100 },
				default: 30,
				description: 'From 0 to 100',
			},
			{
				displayName: 'Mute',
				name: 'mute',
				type: 'boolean',
				default: false,
				description: 'Whether to mute the player',
			},
		],
		run: async (ctx, i) => {
			const body = { volume: param(ctx, 'volume', i, 30), mute: param(ctx, 'mute', i, false) };
			const path = `player/${idParam(ctx, 'playerId', i)}/api/v6/control/volume/`;
			return done(await freeboxRequest.call(ctx, path, 'PUT', { body }), body);
		},
	},
];
