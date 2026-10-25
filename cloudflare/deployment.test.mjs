import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  assertRoutingReady,
  createDeploymentConfig,
  deploymentFingerprint,
  deployWorker,
  parseWranglerConfig,
  terraformEnv,
} from './deployment.mjs';

const deployment = {
  account_id: '0123456789abcdef0123456789abcdef',
  zone_id: 'abcdef0123456789abcdef0123456789',
  domain_name: 'app.example.net',
  worker_name: 'dispose-me-test-worker',
  database_id: '11111111-2222-3333-4444-555555555555',
  database_name: 'dispose-me-test-inbox',
  bucket_name: 'dispose-me-test-emails',
  email_ttl_days: 3,
  cookie_ttl_days: 14,
  private_access: true,
  inbox_blacklist: 'admin,abuse',
};
const base = {
  name: 'local-worker',
  main: 'cloudflare/worker.ts',
  vars: { DOMAIN_NAME: 'example.com', APP_VERSION: '0.1.0' },
  d1_databases: [{ database_id: '00000000-0000-0000-0000-000000000000' }],
  r2_buckets: [{ bucket_name: 'local-bucket' }],
};

test('Terraform output replaces local resource IDs and keeps retention consistent', () => {
  // given / when
  const config = createDeploymentConfig(base, deployment);
  // then
  assert.equal(config.account_id, deployment.account_id);
  assert.equal(config.name, deployment.worker_name);
  assert.equal(config.vars.DOMAIN_NAME, deployment.domain_name);
  assert.equal(config.vars.EMAIL_TTL_DAYS, '3');
  assert.equal(config.vars.PRIVATE_ACCESS, 'true');
  assert.equal(config.d1_databases[0].database_id, deployment.database_id);
  assert.equal(config.r2_buckets[0].bucket_name, deployment.bucket_name);
  assert.equal(config.vars.APP_VERSION, base.vars.APP_VERSION);
  assert.equal(base.name, 'local-worker');
});

test('production configuration preserves query redaction and useful observability settings', async () => {
  // given: use the checked-in configuration that normal deployments regenerate from.
  const local = parseWranglerConfig(
    await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'),
  );
  local.observability.logs = {
    enabled: true,
    invocation_logs: true,
    persist: true,
    head_sampling_rate: 0.25,
  };
  // when
  const first = createDeploymentConfig(local, deployment);
  const regenerated = createDeploymentConfig(local, deployment);
  // then
  assert.equal(first.observability.enabled, true);
  assert.equal(first.observability.redact_query_string, true);
  assert.deepEqual(first.observability.logs, local.observability.logs);
  assert.deepEqual(regenerated.observability, first.observability);
});

test('configuration generation rejects placeholders and competing routing owners', () => {
  // given / when / then
  assert.throws(
    () =>
      createDeploymentConfig(base, {
        ...deployment,
        database_id: base.d1_databases[0].database_id,
      }),
    /provisioned D1/,
  );
  assert.throws(
    () =>
      createDeploymentConfig(base, {
        ...deployment,
        domain_name: 'example.com',
      }),
    /provisioned domain/,
  );
  assert.throws(
    () => createDeploymentConfig({ ...base, addresses: ['*@example.net'] }, deployment),
    /Terraform owns routing/,
  );
  assert.throws(
    () => createDeploymentConfig(base, { ...deployment, email_ttl_days: 0 }),
    /email_ttl_days/,
  );
});

test('Wrangler JSONC comments and trailing commas are supported', () => {
  // given / when / then
  assert.deepEqual(parseWranglerConfig('{ // Local settings\n "name": "app", }'), { name: 'app' });
  assert.throws(() => parseWranglerConfig('{ broken json'), /Cannot parse/);
});

test('Terraform commands ignore inherited workspace selection', () => {
  // given
  const env = { TF_WORKSPACE: 'old-remote-workspace', CLOUDFLARE_API_TOKEN: 'test-api-token' };
  // when / then
  assert.equal(terraformEnv(env).TF_WORKSPACE, 'default');
  assert.equal(terraformEnv(env).CLOUDFLARE_API_TOKEN, env.CLOUDFLARE_API_TOKEN);
  assert.equal(env.TF_WORKSPACE, 'old-remote-workspace');
});

test('a failed migration prevents uploading Worker code or secrets', () => {
  // given
  const calls = [];
  const execute = (_command, args) => {
    calls.push(args);
    throw new Error('Migration failed');
  };
  // when / then
  assert.throws(
    () =>
      deployWorker(createDeploymentConfig(base, deployment), 'validtesttoken1234567890', execute),
    /Migration failed/,
  );
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('migrations'));
  assert.ok(calls[0].includes('--remote'));
});

test('missing private-access token prevents remote mutations', () => {
  // given
  let executed = false;
  // when / then
  assert.throws(
    () =>
      deployWorker(createDeploymentConfig(base, deployment), undefined, () => {
        executed = true;
      }),
    /Set ACCESS_TOKEN/,
  );
  assert.equal(executed, false);
});

test('secret is uploaded after code via stdin, without appearing in command arguments', () => {
  // given
  const calls = [];
  const token = 'validtesttoken1234567890';
  // when
  deployWorker(createDeploymentConfig(base, deployment), token, (command, args, options) =>
    calls.push({ command, args, options }),
  );
  // then
  assert.ok(calls[0].args.includes('migrations'));
  assert.ok(calls[1].args.includes('deploy'));
  assert.ok(calls[2].args.includes('bulk'));
  assert.equal(JSON.parse(calls[2].options.input).ACCESS_TOKEN, token);
  assert.ok(calls.every(({ args }) => !args.some((arg) => arg.includes(token))));
});

test('dry-run does not apply schema migrations, upload secrets, or require a token', () => {
  // given
  const calls = [];
  // when
  deployWorker(
    createDeploymentConfig(base, deployment),
    undefined,
    (_command, args) => calls.push(args),
    true,
  );
  // then
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('--dry-run'));
  assert.ok(!calls[0].includes('migrations'));
});

test('routing requires a successful deployment matching the current Terraform output', () => {
  // given
  const ready = { fingerprint: deploymentFingerprint(deployment) };
  // when / then
  assert.doesNotThrow(() => assertRoutingReady(deployment, ready));
  assert.throws(() => assertRoutingReady(deployment, undefined), /before routing/);
  assert.throws(
    () => assertRoutingReady({ ...deployment, email_ttl_days: 7 }, ready),
    /before routing/,
  );
});
