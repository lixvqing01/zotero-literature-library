import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
await mkdir('test-output', { recursive: true });
await build({ entryPoints: ['tests/all.test.ts'], bundle: true, outfile: 'test-output/core.test.mjs', platform: 'node', format: 'esm', target: 'node22' });
await import('../test-output/core.test.mjs');
