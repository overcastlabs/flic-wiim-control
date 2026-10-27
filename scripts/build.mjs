import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { build, transform } from 'esbuild';

const external = ['dgram', 'flicapp', 'http', 'net', 'network', 'tls'];
const packageManifest = JSON.parse(await readFile('package.json', 'utf8'));
const configSource = await readFile('config-header.ts', 'utf8');
const { code: configHeader } = await transform(configSource, {
  loader: 'ts',
  target: 'es2020',
});

if (!packageManifest.flicHub?.name || !packageManifest.version) {
  throw new Error('package.json must define flicHub.name and version');
}

const moduleManifest = {
  name: packageManifest.flicHub.name,
  version: packageManifest.version,
};

await mkdir('dist', { recursive: true });

const buildApplication = (outfile, minify) =>
  build({
    entryPoints: ['src/main.ts'],
    outfile,
    bundle: true,
    minify,
    format: 'cjs',
    platform: 'neutral',
    target: 'es2020',
    charset: 'utf8',
    legalComments: 'none',
    external,
    banner: {
      js: `'use strict';\n\n${configHeader.trim()}`,
    },
  });

await Promise.all([
  buildApplication('dist/main.js', true),
  buildApplication('dist/main.debug.js', false),
  writeFile('dist/module.json', `${JSON.stringify(moduleManifest, null, 2)}\n`),
]);

console.log('Built dist/main.js and dist/main.debug.js');
