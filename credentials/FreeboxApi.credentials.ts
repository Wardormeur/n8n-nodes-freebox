import type { ICredentialType, Icon, INodeProperties } from 'n8n-workflow';

// The app token comes from a one-time authorization accepted on the box's
// display (see the README: node scripts/authorize.cjs). Sessions are opened
// by the node itself; the credential test does the same (Freebox node,
// credentialTest freeboxApiTest).
export class FreeboxApi implements ICredentialType {
	name = 'freeboxApi';

	displayName = 'Freebox API';

	documentationUrl = 'https://dev.freebox.fr/sdk/os/login/';

	icon: Icon = {
		light: 'file:../nodes/Freebox/freebox.svg',
		dark: 'file:../nodes/Freebox/freebox.dark.svg',
	};

	properties: INodeProperties[] = [
		{
			displayName: 'Freebox URL',
			name: 'baseUrl',
			type: 'string',
			default: 'http://mafreebox.freebox.fr',
			description:
				'Local address, or https://<api_domain>:<https_port> for remote access (see the box\'s /api_version)',
		},
		{
			displayName: 'App ID',
			name: 'appId',
			type: 'string',
			default: 'n8n.community.freebox',
			required: true,
			description: 'The app_id used when the app was authorized on the box',
		},
		{
			displayName: 'App Token',
			name: 'appToken',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'The app_token returned when the app was authorized on the box',
		},
		{
			displayName: 'Ignore SSL Issues (Insecure)',
			name: 'ignoreSslIssues',
			type: 'boolean',
			default: false,
			description:
				"Whether to accept the box's HTTPS certificate, which is signed by Free's own authority rather than a public one",
		},
	];
}
