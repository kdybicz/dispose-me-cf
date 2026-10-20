import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const run = (args, env = process.env) => execFileSync('terraform', args, { stdio: 'inherit', env });
run(['fmt', '-check', '-recursive', 'infra/cloudflare']);
const pluginCache = resolve('.wrangler/terraform-validation/plugin-cache');
await mkdir(pluginCache, { recursive: true });
for (const stack of ['state', 'storage', 'routing']) {
  const directory = `-chdir=infra/cloudflare/${stack}`;
  // A normal .terraform directory may contain a live S3 backend even with -backend=false.
  // Validation gets its own metadata and never opens the deployment backend cache.
  const env = {
    ...process.env,
    TF_DATA_DIR: resolve(`.wrangler/terraform-validation/${stack}`),
    TF_PLUGIN_CACHE_DIR: pluginCache,
    TF_WORKSPACE: 'default',
    AWS_EC2_METADATA_DISABLED: 'true',
  };
  run([directory, 'init', '-backend=false', '-input=false', '-lockfile=readonly'], env);
  run([directory, 'validate'], env);
  run([directory, 'test'], env);
}
