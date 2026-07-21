import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateReleaseContract } from './release-contract.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');
const inputs = () => ({
  releaseWorkflow: read('.github/workflows/release.yml'),
  ciWorkflow: read('.github/workflows/ci.yml'),
  rootPackage: JSON.parse(read('package.json')),
  electronPackage: JSON.parse(read('packages/electron/package.json')),
});

test('release and CI workflows stay aligned with package scripts and branding', () => {
  validateReleaseContract(inputs());
});

test('rejects invalid workflow YAML before release', () => {
  assert.throws(() => validateReleaseContract({
    ...inputs(),
    releaseWorkflow: 'name: Release\njobs: [',
  }), /release workflow is invalid YAML/);
});

test('rejects workflow references to missing package scripts', () => {
  const current = inputs();
  assert.throws(() => validateReleaseContract({
    ...current,
    releaseWorkflow: current.releaseWorkflow.replace('bun run bundle:main', 'bun run missing:script'),
  }), /missing packages\/electron script: missing:script/);
});
