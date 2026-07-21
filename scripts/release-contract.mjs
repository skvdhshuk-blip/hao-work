import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const SCRIPT_LINE = /^\s*bun run ([\w:-]+)(?:\s|$)/gm;
const STEP_START = /(?=^ {6}- (?:name|uses):)/m;

const referencedBunScripts = (workflow) => {
  const references = [];
  for (const block of workflow.split(STEP_START)) {
    const workingDirectory = block.match(/^ {8}working-directory:\s*([^\s#]+)\s*$/m)?.[1] || '.';
    for (const match of block.matchAll(SCRIPT_LINE)) {
      references.push({ workingDirectory, script: match[1] });
    }
  }
  return references;
};

const validateWorkflowYaml = (label, workflow, errors) => {
  try {
    const parsed = parseYaml(workflow);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      errors.push(`${label} workflow must contain a YAML mapping`);
    }
  } catch (error) {
    errors.push(`${label} workflow is invalid YAML: ${error.message}`);
  }
};

export const validateReleaseContract = ({
  releaseWorkflow,
  ciWorkflow,
  rootPackage,
  electronPackage,
}) => {
  const errors = [];
  validateWorkflowYaml('release', releaseWorkflow, errors);
  validateWorkflowYaml('CI', ciWorkflow, errors);

  const rootScripts = rootPackage?.scripts || {};
  const scriptSets = new Map([
    ['.', new Set(Object.keys(rootScripts))],
    ['packages/electron', new Set(Object.keys(electronPackage?.scripts || {}))],
  ]);
  const references = referencedBunScripts(releaseWorkflow);

  for (const { workingDirectory, script } of references) {
    const scripts = scriptSets.get(workingDirectory);
    if (!scripts) {
      errors.push(`release workflow calls ${script} from an unvalidated working directory: ${workingDirectory}`);
    } else if (!scripts.has(script)) {
      errors.push(`release workflow calls missing ${workingDirectory} script: ${script}`);
    }
  }

  for (const required of [
    'test',
    'test:release-contract',
    'test:haocode',
    'test:bridge',
    'test:electron',
    'check',
    'release:prepare',
  ]) {
    if (!rootScripts[required]) errors.push(`root package is missing required quality script: ${required}`);
  }
  if (!String(rootScripts.check || '').includes('bun run test')) {
    errors.push('root check script must run the test suite');
  }
  if (!String(rootScripts['release:prepare'] || '').includes('bun run check')
    || !String(rootScripts['release:prepare'] || '').includes('bun run build')) {
    errors.push('release:prepare must run both check and build');
  }

  if (!/^ {2}quality-gate:\s*$/m.test(releaseWorkflow)) {
    errors.push('release workflow is missing the quality-gate job');
  }
  if (!/^ {2}create-release:\s*\n {4}needs: quality-gate\s*$/m.test(releaseWorkflow)) {
    errors.push('create-release must depend on quality-gate');
  }
  if (!releaseWorkflow.includes('run: bun run release:prepare')) {
    errors.push('release quality-gate must run release:prepare');
  }
  if (!ciWorkflow.includes('run: bun run release:prepare')) {
    errors.push('CI must run the same release:prepare gate');
  }
  if (!/^ {4}branches:\s*\n {6}- main\s*$/m.test(ciWorkflow)) {
    errors.push('CI must validate the main branch');
  }
  if (!/^ {2}pull_request:\s*$/m.test(ciWorkflow)) {
    errors.push('CI must validate pull requests');
  }
  if (!/^ {4}tags:\s*\n {6}- ['"]v\*['"]\s*$/m.test(ciWorkflow)) {
    errors.push('CI must validate v* release tags');
  }

  const bunVersion = String(rootPackage?.packageManager || '').match(/^bun@(.+)$/)?.[1];
  if (!bunVersion) {
    errors.push('root packageManager must pin a Bun version');
  } else {
    const versionLine = `bun-version: ${bunVersion}`;
    if (!ciWorkflow.includes(versionLine)) errors.push(`CI must pin ${versionLine}`);
    const qualityGate = releaseWorkflow.match(/^ {2}quality-gate:\s*$([\s\S]*?)(?=^ {2}\S)/m)?.[1] || '';
    if (!qualityGate.includes(versionLine)) errors.push(`release quality-gate must pin ${versionLine}`);
  }

  const productName = electronPackage?.build?.productName;
  if (!productName) {
    errors.push('Electron productName is missing');
  } else {
    const localArtifact = `APPIMAGE="dist/${productName}-\${VERSION}-linux-\${ARTIFACT_ARCH}.AppImage"`;
    const inventoryArtifact = `${productName}-\${version}-linux-x86_64.AppImage`;
    if (!releaseWorkflow.includes(localArtifact)) {
      errors.push(`Linux workflow artifact path does not match productName ${JSON.stringify(productName)}`);
    }
    if (!releaseWorkflow.includes(inventoryArtifact)) {
      errors.push('final release inventory does not use the current productName');
    }
    if (!releaseWorkflow.includes(`name: ${productName} v\${{ steps.get_version.outputs.version }}`)) {
      errors.push('draft release name does not use the current productName');
    }
  }

  for (const stale of [
    'prepare:opencode-cli',
    'verify:opencode-cli',
    'OpenChamber-',
    'name: OpenChamber v',
    'openchamber/openchamber-website',
  ]) {
    if (releaseWorkflow.includes(stale)) errors.push(`release workflow still contains stale reference: ${stale}`);
  }

  if (errors.length) {
    throw new Error(`Release workflow contract failed:\n- ${errors.join('\n- ')}`);
  }
  return { referencedScripts: references.length, productName, bunVersion };
};

const main = () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const read = (relative) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');
  const result = validateReleaseContract({
    releaseWorkflow: read('.github/workflows/release.yml'),
    ciWorkflow: read('.github/workflows/ci.yml'),
    rootPackage: JSON.parse(read('package.json')),
    electronPackage: JSON.parse(read('packages/electron/package.json')),
  });
  console.log(`[release-contract] verified ${result.referencedScripts} bun script references for ${result.productName} with Bun ${result.bunVersion}`);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
