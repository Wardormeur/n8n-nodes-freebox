import tseslint from 'typescript-eslint';
import { n8nCommunityNodesPlugin } from '@n8n/eslint-plugin-community-nodes';

export default tseslint.config(
	{ files: ['**/*.ts', 'package.json'] },
	// package.json rules parse it as a JS object expression, so it needs the TS parser
	{ files: ['package.json'], languageOptions: { parser: tseslint.parser } },
	...tseslint.configs.recommended.map((c) => ({ ...c, files: ['**/*.ts'] })),
	n8nCommunityNodesPlugin.configs.recommended,
);
