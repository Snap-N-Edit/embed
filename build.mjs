import { build } from 'esbuild';
import { mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', '..', 'apps', 'web', 'public', 'embed');

await build({
  entryPoints: [path.join(here, 'src', 'loader.ts')],
  bundle: true, format: 'iife', target: ['es2020'], minify: true, sourcemap: false,
  outfile: path.join(here, 'dist', 'embed.iife.js'),
  // Only type imports from these; nothing runtime must land in the bundle.
  external: ['react', '@snapnedit/shared', '@snapnedit/editor-core'],
});
mkdirSync(publicDir, { recursive: true });
copyFileSync(path.join(here, 'dist', 'embed.iife.js'), path.join(publicDir, 'v1.js'));
console.log('embed loader → apps/web/public/embed/v1.js');
