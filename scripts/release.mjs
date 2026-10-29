import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const usage = 'Usage: yarn release <major|minor|patch|X.Y.Z> [--no-push]';
const args = process.argv.slice(2);
const noPush = args.includes('--no-push');
const release = args.find((argument) => !argument.startsWith('--'));

if (!release || args.some((argument) => argument !== release && argument !== '--no-push')) {
  throw new Error(usage);
}

const run = (command, commandArgs, options = {}) => {
  const result = spawnSync(command, commandArgs, {
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  });

  if (result.status !== 0) {
    if (options.capture) {
      process.stderr.write(result.stderr);
    }
    throw new Error(`${command} ${commandArgs.join(' ')} failed`);
  }

  return options.capture ? result.stdout.trim() : '';
};

const packageSource = await readFile('package.json', 'utf8');
const packageManifest = JSON.parse(packageSource);
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const currentMatch = packageManifest.version?.match(versionPattern);

if (!currentMatch) {
  throw new Error(`Current version ${packageManifest.version} is not a stable SemVer version`);
}

const status = run('git', ['status', '--porcelain'], { capture: true });
if (status) {
  throw new Error('The working tree must be clean before creating a release');
}

const branch = run('git', ['branch', '--show-current'], { capture: true });
if (!branch) {
  throw new Error('Releases must be created from a branch, not a detached HEAD');
}

if (!noPush) {
  run('git', ['remote', 'get-url', 'origin'], { capture: true });
}

const current = currentMatch.slice(1).map(Number);
let nextVersion;

if (versionPattern.test(release)) {
  nextVersion = release;
} else {
  const [major, minor, patch] = current;
  const increments = {
    major: `${major + 1}.0.0`,
    minor: `${major}.${minor + 1}.0`,
    patch: `${major}.${minor}.${patch + 1}`,
  };
  nextVersion = increments[release];
}

if (!nextVersion) {
  throw new Error(usage);
}

if (nextVersion === packageManifest.version) {
  throw new Error(`Version ${nextVersion} is already current`);
}

const tag = `v${nextVersion}`;
const existingTag = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`]);
if (existingTag.status === 0) {
  throw new Error(`Tag ${tag} already exists`);
}

packageManifest.version = nextVersion;
await writeFile('package.json', `${JSON.stringify(packageManifest, null, 2)}\n`);

try {
  run('yarn', ['check']);
} catch (error) {
  await writeFile('package.json', packageSource);
  throw error;
}

run('git', ['add', 'package.json']);
run('git', ['commit', '-m', `REL: ${tag}`]);
run('git', ['tag', '--annotate', tag, '--message', tag]);

if (noPush) {
  console.log(`Prepared ${tag} locally. Push it with: git push origin ${branch} --follow-tags`);
} else {
  run('git', ['push', 'origin', branch, '--follow-tags']);
  console.log(`Published ${tag}; GitHub Actions will create the release asset.`);
}
