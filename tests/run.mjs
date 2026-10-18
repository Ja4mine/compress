// Bundles each test with esbuild (the obsidian module replaced by a stub) and runs it with node's test runner.
import esbuild from 'esbuild';
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const files = readdirSync('tests').filter((f) => f.endsWith('.test.ts')).map((f) => `tests/${f}`);
await esbuild.build({
  entryPoints: files, bundle: true, platform: 'node', format: 'esm', outdir: '.test-build', outExtension: { '.js': '.mjs' },
  alias: { obsidian: './tests/obsidian-stub.ts' }, logLevel: 'warning',
});
const r = spawnSync(process.execPath, ['--test', ...files.map((f) => f.replace(/^tests\//, '.test-build/').replace(/\.ts$/, '.mjs'))], { stdio: 'inherit' });
process.exit(r.status ?? 1);
