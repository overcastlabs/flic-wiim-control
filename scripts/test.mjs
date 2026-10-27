import { rm, readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { build, transform } from 'esbuild';

const testOutputDirectory = '.test-dist';
const configSource = await readFile('config-header.ts', 'utf8');
const { code: configHeader } = await transform(configSource, {
  loader: 'ts',
  target: 'es2020',
});
const testEntries = (await readdir('tests'))
  .filter((file) => file.endsWith('.test.ts'))
  .map((file) => `tests/${file}`);

await rm(testOutputDirectory, { recursive: true, force: true });

try {
  await build({
    entryPoints: testEntries,
    outdir: testOutputDirectory,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    banner: { js: configHeader.trim() },
  });

  const compiledTests = (await readdir(testOutputDirectory))
    .filter((file) => file.endsWith('.test.js'))
    .map((file) => `${testOutputDirectory}/${file}`);
  const result = spawnSync(process.execPath, ['--test', ...compiledTests], {
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  }
} finally {
  await rm(testOutputDirectory, { recursive: true, force: true });
}
