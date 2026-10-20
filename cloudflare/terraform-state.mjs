import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AwsClient } from 'aws4fetch';

export const TERRAFORM_ROOTS = {
  state: 'infra/cloudflare/state',
  storage: 'infra/cloudflare/storage',
  routing: 'infra/cloudflare/routing',
};
const configFile = '.terraform-state.json';
const generatedDirectory = '.wrangler/terraform-state';

export const stateConfig = (saved = {}, env = process.env) => {
  const config = {
    account_id: env.CLOUDFLARE_ACCOUNT_ID ?? saved.account_id,
    bucket: env.TF_STATE_BUCKET ?? saved.bucket ?? 'dispose-me-cf-terraform-state',
    key_prefix: env.TF_STATE_PREFIX ?? saved.key_prefix ?? 'dispose-me-cf',
  };
  if (!/^[a-f0-9]{32}$/.test(config.account_id ?? '') || /^0+$/.test(config.account_id)) {
    throw new Error('Set CLOUDFLARE_ACCOUNT_ID or account_id in .terraform-state.json');
  }
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucket)) {
    throw new Error('TF_STATE_BUCKET must be a valid 3-63 character R2 bucket name');
  }
  if (!config.key_prefix.split('/').every((part) => /^[a-zA-Z0-9_-]+$/.test(part))) {
    throw new Error(
      'TF_STATE_PREFIX must contain nonempty alphanumeric/hyphen/underscore path segments',
    );
  }
  return config;
};

const readConfig = async () => {
  try {
    return stateConfig(JSON.parse(await readFile(configFile, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return stateConfig();
    throw error;
  }
};

export const backendConfig = (config, stack) => {
  if (!Object.hasOwn(TERRAFORM_ROOTS, stack)) throw new Error('Unknown Terraform stack');
  return {
    bucket: config.bucket,
    key: `${config.key_prefix}/${stack}.tfstate`,
    region: 'auto',
    endpoints: { s3: `https://${config.account_id}.r2.cloudflarestorage.com` },
    use_path_style: true,
    use_lockfile: true,
    skip_credentials_validation: true,
    skip_region_validation: true,
    skip_requesting_account_id: true,
    skip_metadata_api_check: true,
    skip_s3_checksum: true,
  };
};

export const stateCredentials = async (config, env = process.env, request = fetch) => {
  if (env.R2_ACCESS_KEY_ID || env.R2_SECRET_ACCESS_KEY) {
    if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
      throw new Error('Set both R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY');
    }
    return { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY };
  }
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error('Set Cloudflare API credentials or an R2 state-bucket key pair');
  const path = token.startsWith('cfat_')
    ? `/accounts/${config.account_id}/tokens/verify`
    : '/user/tokens/verify';
  const response = await request(`https://api.cloudflare.com/client/v4${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const verified = await response.json();
  if (!response.ok || !verified.success || verified.result?.status !== 'active') {
    throw new Error(`Unable to verify the R2-capable deployment token (HTTP ${response.status})`);
  }
  // Cloudflare documents token ID + SHA-256(token value) as S3-compatible credentials.
  return {
    accessKeyId: verified.result.id,
    secretAccessKey: createHash('sha256').update(token).digest('hex'),
  };
};

export const terraformEnv = (env = process.env, credentials) => {
  const result = { ...env, TF_WORKSPACE: 'default' };
  if (credentials) {
    Object.assign(result, {
      AWS_ACCESS_KEY_ID: credentials.accessKeyId,
      AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
      AWS_REGION: 'auto',
      AWS_DEFAULT_REGION: 'auto',
      AWS_EC2_METADATA_DISABLED: 'true',
    });
    for (const name of [
      'AWS_PROFILE',
      'AWS_DEFAULT_PROFILE',
      'AWS_SESSION_TOKEN',
      'AWS_WEB_IDENTITY_TOKEN_FILE',
      'AWS_ROLE_ARN',
    ])
      delete result[name];
  }
  return result;
};

const fingerprint = (backend) => createHash('sha256').update(JSON.stringify(backend)).digest('hex');

export const runTerraform = async (stack, args, options = {}) => {
  const config = await readConfig();
  const backend = backendConfig(config, stack);
  const credentials = await stateCredentials(config);
  await mkdir(generatedDirectory, { recursive: true });
  const backendPath = resolve(`${generatedDirectory}/${stack}.backend.json`);
  const markerPath = `${generatedDirectory}/${stack}.initialized.json`;
  await writeFile(backendPath, `${JSON.stringify(backend, null, 2)}\n`, { mode: 0o600 });
  const [operation, ...rest] = args;
  const command = [operation, ...rest];
  if (operation === 'init') {
    command.splice(1, 0, `-backend-config=${backendPath}`);
  } else {
    let marker;
    try {
      marker = JSON.parse(await readFile(markerPath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (marker?.fingerprint !== fingerprint(backend)) {
      throw new Error(
        `Initialize the current R2 backend with yarn infra ${stack} init; use -migrate-state when moving existing state`,
      );
    }
  }
  if (stack === 'state' && ['plan', 'apply', 'import'].includes(operation)) {
    const variablesPath = resolve(`${generatedDirectory}/state.tfvars.json`);
    await writeFile(
      variablesPath,
      JSON.stringify({ account_id: config.account_id, state_bucket_name: config.bucket }),
      { mode: 0o600 },
    );
    command.splice(1, 0, `-var-file=${variablesPath}`);
  }
  const result = execFileSync('terraform', [`-chdir=${TERRAFORM_ROOTS[stack]}`, ...command], {
    stdio: 'inherit',
    ...options,
    env: terraformEnv(process.env, credentials),
  });
  if (operation === 'init') {
    await writeFile(markerPath, JSON.stringify({ fingerprint: fingerprint(backend) }), {
      mode: 0o600,
    });
  }
  return result;
};

export const verifyConditionalWrites = async (config, credentials, request) => {
  const client = new AwsClient({ ...credentials, service: 's3', region: 'auto' });
  const send = request ?? ((url, options) => client.fetch(url, options));
  const nonce = randomUUID();
  const url = `https://${config.account_id}.r2.cloudflarestorage.com/${config.bucket}/${config.key_prefix}/.locking-probe-${nonce}`;
  const payloads = [`${nonce}:first`, `${nonce}:second`];
  let ownsObject = false;
  let cleanupFailed = false;
  try {
    const responses = await Promise.all(
      payloads.map((body) =>
        send(url, {
          method: 'PUT',
          headers: { 'If-None-Match': '*', 'Content-Type': 'text/plain' },
          body,
        }),
      ),
    );
    ownsObject = responses.some((response) => response.ok);
    if (
      responses.filter((response) => response.ok).length !== 1 ||
      responses.filter((response) => response.status === 412).length !== 1
    ) {
      throw new Error('R2 conditional writes did not enforce exclusive lock creation');
    }
    const stored = await send(url, { method: 'GET' });
    if (!stored.ok || !payloads.includes(await stored.text()))
      throw new Error('Lock probe data did not match');
  } finally {
    if (ownsObject) {
      const response = await send(url, { method: 'DELETE' });
      cleanupFailed = !response.ok;
    }
  }
  if (cleanupFailed) throw new Error('Unable to remove the temporary lock probe');
};

export const bootstrapState = async () => {
  const config = await readConfig();
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token)
    throw new Error('CLOUDFLARE_API_TOKEN with R2 Storage Edit is needed to bootstrap the bucket');
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const base = `https://api.cloudflare.com/client/v4/accounts/${config.account_id}/r2/buckets`;
  let response = await fetch(`${base}/${config.bucket}`, { headers });
  if (response.status === 404) {
    response = await fetch(base, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: config.bucket, storageClass: 'Standard' }),
    });
  }
  if (!response.ok)
    throw new Error(
      `State bucket setup failed (HTTP ${response.status}); check account, R2 activation, and permissions`,
    );
  const bucket = await response.json();
  if (!bucket.success) throw new Error('State bucket setup failed');
  for (const type of ['managed', 'custom']) {
    const access = await fetch(`${base}/${config.bucket}/domains/${type}`, { headers });
    const body = await access.json();
    if (
      !access.ok ||
      !body.success ||
      body.result?.enabled ||
      body.result?.domains?.some((domain) => domain.enabled)
    ) {
      throw new Error('The Terraform state bucket must have public domain access disabled');
    }
  }
  const lifecycleResponse = await fetch(`${base}/${config.bucket}/lifecycle`, { headers });
  const lifecycle = await lifecycleResponse.json();
  if (
    !lifecycleResponse.ok ||
    !lifecycle.success ||
    lifecycle.result?.rules?.some((rule) => rule.enabled && rule.deleteObjectsTransition)
  ) {
    throw new Error('Use a state bucket without object-expiration rules');
  }
  await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  const credentials = await stateCredentials(config);
  await verifyConditionalWrites(config, credentials);
  process.stdout.write(
    'R2 state bucket is private, has no state-expiration policy, and enforces conditional locks.\n',
  );
  await runTerraform('state', ['init', '-input=false']);
  let resources = '';
  try {
    resources = String(
      await runTerraform('state', ['state', 'list'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  } catch (error) {
    if (!String(error.stderr).includes('No state file was found')) throw error;
  }
  if (!resources.split('\n').includes('cloudflare_r2_bucket.terraform_state')) {
    await runTerraform('state', [
      'import',
      'cloudflare_r2_bucket.terraform_state',
      `${config.account_id}/${config.bucket}/default`,
    ]);
  }
  process.stdout.write(
    `Terraform state is stored in R2 bucket ${config.bucket}, prefix ${config.key_prefix}.\n`,
  );
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2)
      throw new Error('state:bootstrap accepts no additional arguments');
    await bootstrapState();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'R2 state bootstrap failed'}\n`,
    );
    process.exitCode = 1;
  }
}
