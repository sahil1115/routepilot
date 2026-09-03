#!/usr/bin/env node
/**
 * Copy the built core into the extension package.
 *
 * A `.vsix` is a self-contained archive: whatever the extension imports at
 * runtime has to be inside it. The extension therefore loads the core from
 * `extension/dist/`, its own copy, rather than reaching up into the repository
 * — a path that exists on a developer's machine and nowhere else.
 *
 * Run automatically by `npm run build:extension`. The copy is a build artifact
 * and is not committed.
 */

import { cp, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, 'dist');
const target = join(root, 'extension', 'dist');

const built = await stat(source).catch(() => null);
if (built === null) {
  console.error('No dist/ to copy. Run "npm run build" first.');
  process.exit(1);
}

await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
// Source maps are dropped: they are large and point at paths that exist only
// on the machine that built them. Declarations are kept, because the
// extension's own `tsc` typechecks against this copy — they are excluded from
// the `.vsix` by `.vscodeignore` instead, which is the right place for a
// packaging concern.
await cp(source, target, {
  recursive: true,
  filter: (path) => !path.endsWith('.map'),
});

// The extension package is CommonJS, and `extension/dist/` sits inside it, so
// without this marker Node reads the core's ESM files as CommonJS and every
// `import` statement is a syntax error. It works in the repository — where
// `dist/` lives under the root package's `"type": "module"` — and fails the
// moment the extension is installed from a `.vsix`, which is the worst place
// to find out. A nested package.json is the supported way to mark a subtree.
await writeFile(
  join(target, 'package.json'),
  `${JSON.stringify({ type: 'module' }, null, 2)}
`,
);

console.log('Copied dist/ -> extension/dist/ (marked as ESM)');
