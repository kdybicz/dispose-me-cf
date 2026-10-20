import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import {
  backendConfig,
  stateConfig,
  stateCredentials,
  terraformEnv,
  verifyConditionalWrites,
} from './terraform-state.mjs';

const config = stateConfig({}, { CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef' });

test('bootstrap rejects unsupported flags before attempting provisioning', () => {
  // given / when
  const result = spawnSync(process.execPath, ['cloudflare/terraform-state.mjs', '--dry-run'], {
    encoding: 'utf8',
    env: { ...process.env, CLOUDFLARE_API_TOKEN: '' },
  });
  // then
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes('accepts no additional arguments'));
});

test('all stacks have independent R2 keys and lockfiles without credential discovery', () => {
  // given / when
  const backends = ['state', 'storage', 'routing'].map((stack) => backendConfig(config, stack));
  // then
  assert.equal(new Set(backends.map((backend) => backend.key)).size, 3);
  assert.ok(backends.every((backend) => backend.use_lockfile && backend.region === 'auto'));
  assert.ok(
    backends.every(
      (backend) =>
        backend.skip_credentials_validation &&
        backend.skip_requesting_account_id &&
        backend.skip_metadata_api_check,
    ),
  );
  assert.ok(
    backends.every((backend) => backend.endpoints.s3.endsWith('.r2.cloudflarestorage.com')),
  );
  assert.ok(backends.every((backend) => !('access_key' in backend) && !('secret_key' in backend)));
});

test('state configuration rejects placeholders and ambiguous state prefixes', () => {
  // given / when / then
  assert.throws(() => stateConfig({}, {}), /CLOUDFLARE_ACCOUNT_ID/);
  assert.throws(
    () => stateConfig({ ...config, account_id: '0'.repeat(32) }, {}),
    /CLOUDFLARE_ACCOUNT_ID/,
  );
  assert.throws(() => stateConfig({ ...config, key_prefix: '../other' }, {}), /TF_STATE_PREFIX/);
  assert.throws(() => stateConfig({ ...config, bucket: 'bad/bucket' }, {}), /TF_STATE_BUCKET/);
  assert.equal(
    stateConfig(config, { TF_STATE_PREFIX: 'production/app' }).key_prefix,
    'production/app',
  );
});

test('explicit R2 credentials avoid token introspection and reject an incomplete pair', async () => {
  // given / when
  const result = await stateCredentials(
    config,
    {
      R2_ACCESS_KEY_ID: 'state-key',
      R2_SECRET_ACCESS_KEY: 'state-secret',
    },
    () => {
      throw new Error('Unexpected API request');
    },
  );
  // then
  assert.deepEqual(result, { accessKeyId: 'state-key', secretAccessKey: 'state-secret' });
  await assert.rejects(
    () => stateCredentials(config, { R2_ACCESS_KEY_ID: 'incomplete' }),
    /Set both/,
  );
});

test('deployment token credentials are derived only after active-token verification', async () => {
  // given
  const token = 'cfut_unit_test_not_a_real_token';
  let endpoint;
  // when
  const result = await stateCredentials(config, { CLOUDFLARE_API_TOKEN: token }, async (url) => {
    endpoint = url;
    return Response.json({ success: true, result: { id: 'token-id', status: 'active' } });
  });
  // then
  assert.ok(endpoint.endsWith('/user/tokens/verify'));
  assert.equal(result.accessKeyId, 'token-id');
  assert.equal(result.secretAccessKey, createHash('sha256').update(token).digest('hex'));
  await assert.rejects(
    () =>
      stateCredentials(config, { CLOUDFLARE_API_TOKEN: token }, async () =>
        Response.json({ success: false }, { status: 403 }),
      ),
    /Unable to verify/,
  );
});

test('account-owned tokens use account verification instead of user verification', async () => {
  // given
  let endpoint;
  // when
  await stateCredentials(config, { CLOUDFLARE_API_TOKEN: 'cfat_test_only' }, async (url) => {
    endpoint = url;
    return Response.json({ success: true, result: { id: 'token-id', status: 'active' } });
  });
  // then
  assert.ok(endpoint.endsWith(`/accounts/${config.account_id}/tokens/verify`));
});

test('Terraform uses R2 credentials without inheriting unrelated sessions or profiles', () => {
  // given / when
  const env = terraformEnv(
    {
      AWS_PROFILE: 'old',
      AWS_SESSION_TOKEN: 'old-session',
      AWS_ACCESS_KEY_ID: 'old-key',
      TF_WORKSPACE: 'old-workspace',
    },
    {
      accessKeyId: 'r2-key',
      secretAccessKey: 'r2-secret',
    },
  );
  // then
  assert.equal(env.AWS_ACCESS_KEY_ID, 'r2-key');
  assert.equal(env.AWS_SECRET_ACCESS_KEY, 'r2-secret');
  assert.equal(env.AWS_REGION, 'auto');
  assert.equal(env.AWS_EC2_METADATA_DISABLED, 'true');
  assert.equal(env.TF_WORKSPACE, 'default');
  assert.ok(!('AWS_SESSION_TOKEN' in env) && !('AWS_PROFILE' in env));
});

test('lock probe accepts only one conditional writer and removes its temporary object', async () => {
  // given
  const objects = new Map();
  const request = async (url, options) => {
    if (options.method === 'PUT') {
      assert.equal(options.headers['If-None-Match'], '*');
      if (objects.has(url)) return new Response(null, { status: 412 });
      objects.set(url, options.body);
      return new Response(null, { status: 200 });
    }
    if (options.method === 'GET') return new Response(objects.get(url));
    objects.delete(url);
    return new Response(null, { status: 204 });
  };
  // when
  await verifyConditionalWrites(config, { accessKeyId: 'test', secretAccessKey: 'test' }, request);
  // then
  assert.equal(objects.size, 0);
});

test('lock probe rejects a backend that ignores exclusive-creation conditions', async () => {
  // given
  let removed = false;
  const request = async (_url, options) => {
    if (options.method === 'DELETE') removed = true;
    return new Response(null, { status: 200 });
  };
  // when / then
  await assert.rejects(
    () =>
      verifyConditionalWrites(config, { accessKeyId: 'test', secretAccessKey: 'test' }, request),
    /exclusive lock creation/,
  );
  assert.equal(removed, true);
});
