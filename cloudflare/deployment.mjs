import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runTerraform, TERRAFORM_ROOTS } from './terraform-state.mjs';

export { terraformEnv } from './terraform-state.mjs';

const { parseConfigFileTextToJson } = createRequire(import.meta.url)('typescript');

const configPath = 'wrangler.deploy.json';
const routingVarsPath = '.wrangler/deploy/routing.tfvars.json';
const readyPath = '.wrangler/deploy/ready.json';

export const createDeploymentConfig = (base, deployment) => {
  for (const key of ['account_id', 'zone_id']) {
    if (!/^[a-f0-9]{32}$/.test(deployment[key] ?? '')) {
      throw new Error(`Invalid Terraform output: ${key}`);
    }
  }
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      deployment.database_id ?? '',
    ) ||
    deployment.database_id === '00000000-0000-0000-0000-000000000000'
  ) {
    throw new Error('Terraform must supply a provisioned D1 database ID');
  }
  for (const key of ['domain_name', 'worker_name', 'database_name', 'bucket_name']) {
    if (typeof deployment[key] !== 'string' || !deployment[key]) {
      throw new Error(`Missing Terraform output: ${key}`);
    }
  }
  if (
    !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(deployment.domain_name) ||
    deployment.domain_name === 'example.com'
  ) {
    throw new Error('Use a provisioned domain instead of the local example.com configuration');
  }
  if (
    typeof deployment.private_access !== 'boolean' ||
    typeof deployment.inbox_blacklist !== 'string'
  ) {
    throw new Error('Terraform must supply private_access and inbox_blacklist');
  }
  for (const key of ['email_ttl_days', 'cookie_ttl_days']) {
    if (!Number.isSafeInteger(deployment[key]) || deployment[key] < 1) {
      throw new Error(`Invalid Terraform output: ${key}`);
    }
  }
  for (const key of ['routes', 'route', 'addresses', 'env']) {
    if (key in base) {
      throw new Error(
        `${key} must not be set in the local Wrangler config; Terraform owns routing`,
      );
    }
  }
  return {
    ...base,
    account_id: deployment.account_id,
    name: deployment.worker_name,
    workers_dev: true,
    vars: {
      ...base.vars,
      DOMAIN_NAME: deployment.domain_name,
      EMAIL_TTL_DAYS: String(deployment.email_ttl_days),
      COOKIE_TTL_DAYS: String(deployment.cookie_ttl_days),
      PRIVATE_ACCESS: String(deployment.private_access),
      INBOX_BLACKLIST: deployment.inbox_blacklist,
    },
    d1_databases: [
      {
        binding: 'DB',
        database_name: deployment.database_name,
        database_id: deployment.database_id,
        migrations_dir: 'cloudflare/migrations',
      },
    ],
    r2_buckets: [{ binding: 'EMAILS', bucket_name: deployment.bucket_name }],
  };
};

const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    stdio: 'inherit',
    ...options,
  });
const terraform = runTerraform;

const configure = async () => {
  const deployment = JSON.parse(
    await terraform('storage', ['output', '-json', 'deployment'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    }),
  );
  const base = parseWranglerConfig(await readFile('wrangler.jsonc', 'utf8'));
  const config = createDeploymentConfig(base, deployment);
  await mkdir('.wrangler/deploy', { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  await writeFile(routingVarsPath, `${JSON.stringify({ deployment }, null, 2)}\n`);
  return deployment;
};

export const parseWranglerConfig = (text) => {
  const parsed = parseConfigFileTextToJson('wrangler.jsonc', text);
  if (parsed.error) {
    throw new Error('Cannot parse wrangler.jsonc');
  }
  return parsed.config;
};

export const deploymentFingerprint = (deployment) =>
  createHash('sha256').update(JSON.stringify(deployment)).digest('hex');

export const deployWorker = (config, token, execute = run, dryRun = false) => {
  const args = ['wrangler', '--config', configPath];
  const options = { env: { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false' } };
  if (dryRun) {
    execute('yarn', [...args, 'deploy', '--dry-run'], options);
    return;
  }
  if (
    (config.vars.PRIVATE_ACCESS !== 'false' || token !== undefined) &&
    !/^[a-zA-Z0-9]{20,50}$/.test(token ?? '')
  ) {
    throw new Error(
      'Set ACCESS_TOKEN to an alphanumeric token of 20-50 characters before deployment',
    );
  }
  execute('yarn', [...args, 'd1', 'migrations', 'apply', 'DB', '--remote'], options);
  execute('yarn', [...args, 'deploy'], options);
  if (token) {
    execute('yarn', [...args, 'secret', 'bulk'], {
      ...options,
      // The token is never a CLI argument, generated file, or Terraform input.
      input: JSON.stringify({ ACCESS_TOKEN: token }),
      stdio: ['pipe', 'inherit', 'inherit'],
    });
  }
};

export const assertRoutingReady = (deployment, ready) => {
  if (ready?.fingerprint !== deploymentFingerprint(deployment)) {
    throw new Error(
      'Run yarn deploy successfully for the current storage/configuration before routing',
    );
  }
};

const main = async ([action, stack, operation, ...extra]) => {
  if (action === 'configure') {
    if (stack !== undefined) throw new Error('configure does not accept additional arguments');
    await configure();
    return;
  }
  if (action === 'deploy') {
    const dryRun = stack === '--dry-run';
    if ((stack !== undefined && !dryRun) || operation !== undefined) {
      throw new Error('deploy accepts only --dry-run');
    }
    const deployment = await configure();
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    if (!dryRun) await rm(readyPath, { force: true });
    deployWorker(config, process.env.ACCESS_TOKEN, run, dryRun);
    if (!dryRun) {
      await writeFile(
        readyPath,
        `${JSON.stringify({ fingerprint: deploymentFingerprint(deployment) })}\n`,
      );
    }
    return;
  }
  if (
    action === 'infra' &&
    Object.hasOwn(TERRAFORM_ROOTS, stack) &&
    ['init', 'plan', 'apply', 'import', 'state'].includes(operation)
  ) {
    if (stack === 'routing' && !['init', 'state'].includes(operation)) {
      const deployment = await configure();
      let ready;
      try {
        ready = JSON.parse(await readFile(readyPath, 'utf8'));
      } catch {
        throw new Error('Run yarn deploy successfully before planning/applying routing');
      }
      assertRoutingReady(deployment, ready);
      await terraform(stack, [operation, `-var-file=${resolve(routingVarsPath)}`, ...extra]);
    } else {
      await terraform(stack, [operation, ...extra]);
    }
    return;
  }
  throw new Error(
    'Use configure, deploy, or infra <state|storage|routing> <init|plan|apply|import|state>',
  );
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Cloudflare deployment failed'}\n`,
    );
    process.exitCode = 1;
  }
}
