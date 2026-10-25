import { NodeApiError, NodeConnectionTypes } from 'n8n-workflow';
import type {
	ICredentialsDecrypted,
	ICredentialTestFunctions,
	IDataObject,
	IExecuteFunctions,
	INodeCredentialTestResult,
	INodeExecutionData,
	INodeProperties,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';

import { OPERATIONS, RESOURCES, type OperationDef } from './actions/operations';
import { applyOutputMode, buildOutputProperties, type OutputMode } from './actions/output';
import { FreeboxApiError, freeboxApiRequest, fromLegacyRequest, toCredentials } from './transport';

const fieldOptions = (op: OperationDef) =>
	[...new Set([...(op.simplified ?? []), ...(op.extraFields ?? [])])]
		.filter((key) => key !== 'id')
		.sort()
		.map((key) => ({
			name: key
				.split('_')
				.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
				.join(' ')
				.replace(/\bIpv(\d)\b/, 'IPv$1')
				.replace(/\bPct\b/, '%')
				.replace(/\bTs\b/, 'Timestamp'),
			value: key,
		}));

function operationProperties(): INodeProperties[] {
	const properties: INodeProperties[] = [];
	for (const resource of RESOURCES) {
		const ops = OPERATIONS.filter((op) => op.resource === resource.value);
		properties.push({
			displayName: 'Operation',
			name: 'operation',
			type: 'options',
			noDataExpression: true,
			displayOptions: { show: { resource: [resource.value as string] } },
			options: ops.map((op) => ({ name: op.name, value: op.value, action: op.action, description: op.description })),
			default: ops[0].value,
		});
	}
	for (const op of OPERATIONS) {
		const show = { resource: [op.resource], operation: [op.value] };
		for (const property of op.properties ?? []) {
			properties.push({ ...property, displayOptions: { show } });
		}
		if (op.list) {
			properties.push(
				{
					displayName: 'Return All',
					name: 'returnAll',
					type: 'boolean',
					default: false,
					description: 'Whether to return all results or only up to a given limit',
					displayOptions: { show },
				},
				{
					displayName: 'Limit',
					name: 'limit',
					type: 'number',
					default: 50,
					typeOptions: { minValue: 1 },
					description: 'Max number of results to return',
					displayOptions: { show: { ...show, returnAll: [false] } },
				},
			);
		}
		if (op.simplified) {
			properties.push(...buildOutputProperties(show, fieldOptions(op)));
		}
	}
	return properties;
}

export class Freebox implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Freebox',
		name: 'freebox',
		icon: { light: 'file:freebox.svg', dark: 'file:freebox.dark.svg' },
		group: ['input'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description:
			'Read and control a Freebox: devices, connection, Wi-Fi, downloads, calls, contacts, parental control and players',
		defaults: { name: 'Freebox' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'freeboxApi', required: true, testedBy: 'freeboxApiTest' }],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: RESOURCES,
				default: 'device',
			},
			...operationProperties(),
		],
	};

	methods = {
		credentialTest: {
			// Opens a real session: the box needs a challenge and an HMAC,
			// which a static credential test request can't do.
			async freeboxApiTest(
				this: ICredentialTestFunctions,
				credential: ICredentialsDecrypted,
			): Promise<INodeCredentialTestResult> {
				try {
					await freeboxApiRequest(
						// A credential test context only has the legacy `request` helper
						// (n8n-core CredentialTestContext); there is no httpRequest to use.
						// eslint-disable-next-line @n8n/community-nodes/no-deprecated-workflow-functions
						fromLegacyRequest((options) => this.helpers.request(options)),
						toCredentials(credential.data ?? {}),
						'GET',
						'system/',
					);
					return { status: 'OK', message: 'Connected to the Freebox' };
				} catch (error) {
					return { status: 'Error', message: (error as Error).message };
				}
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;
		const op = OPERATIONS.find((o) => o.resource === resource && o.value === operation);
		if (!op) throw new NodeApiError(this.getNode(), { message: `Unknown operation ${resource}: ${operation}` } as JsonObject);

		for (let i = 0; i < items.length; i++) {
			try {
				let result = await op.run(this, i);
				if (Array.isArray(result) && !this.getNodeParameter('returnAll', i, false)) {
					result = result.slice(0, this.getNodeParameter('limit', i, 50) as number);
				}
				if (op.simplified) {
					const mode = this.getNodeParameter('output', i, 'simple') as OutputMode;
					const fields = this.getNodeParameter('fields', i, []) as string[];
					const trim = (entry: IDataObject) => applyOutputMode(entry, mode, fields, op.simplified!);
					result = Array.isArray(result) ? result.map(trim) : trim(result);
				}
				returnData.push(
					...this.helpers.constructExecutionMetaData(this.helpers.returnJsonArray(result), {
						itemData: { item: i },
					}),
				);
			} catch (error) {
				const apiError =
					error instanceof FreeboxApiError
						? new NodeApiError(this.getNode(), { message: error.message, error_code: error.errorCode ?? '' } as JsonObject, {
								message: error.message,
								httpCode: String(error.statusCode),
							})
						: error;
				if (this.continueOnFail()) {
					returnData.push(
						...this.helpers.constructExecutionMetaData(
							this.helpers.returnJsonArray({ error: (apiError as Error).message }),
							{ itemData: { item: i } },
						),
					);
					continue;
				}
				throw apiError;
			}
		}
		return [returnData];
	}
}
