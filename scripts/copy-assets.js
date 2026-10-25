// tsc only emits .js - copy the icons and codex files next to the compiled node.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const assetExt = new Set(['.svg', '.png', '.json']);

function copyAssets(srcDir) {
	for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
		const src = path.join(srcDir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== '__tests__') copyAssets(src);
		} else if (assetExt.has(path.extname(entry.name))) {
			const dest = path.join(root, 'dist', path.relative(root, src));
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			fs.copyFileSync(src, dest);
		}
	}
}

copyAssets(path.join(root, 'nodes'));
