// Build the respondent client bundle. Runs as part of `build`, after tsc, so the size budget
// is enforced on every build rather than by a test someone can skip — E §12.1 caps the client
// at 60 KB gzipped, and a budget that only CI checks is a budget that dies in a hotfix.
import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { mkdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

// Typecheck against DOM libs first — the server tsconfig excludes src/client (Node types and
// DOM types disagree about the world), and esbuild strips types without checking them.
execSync('npx tsc --noEmit -p tsconfig.client.json', { stdio: 'inherit' });

mkdirSync('dist/client', { recursive: true });
await build({
  entryPoints: ['src/client/main.ts'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2018'], // panel traffic includes old webviews; es2018 is the floor
  outfile: 'dist/client/client.js',
});
const bytes = statSync('dist/client/client.js').size;
const gz = gzipSync(readFileSync('dist/client/client.js')).length;
writeFileSync('dist/client/client.size.json', JSON.stringify({ bytes, gzip: gz }));
console.log(`client bundle: ${bytes} B raw, ${gz} B gzipped (budget: 61440)`);
if (gz > 60 * 1024) {
  console.error('CLIENT BUNDLE OVER BUDGET: E §12.1 caps it at 60 KB gzipped');
  process.exit(1);
}
