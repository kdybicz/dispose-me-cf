import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { relative, resolve } from 'node:path';

import { glob } from 'glob';

const { Template } = createRequire(import.meta.url)('ejs');
const root = resolve('service/views');
const entries = [];
for (const file of (await glob('service/views/**/*.ejs')).sort()) {
  const name = relative(root, resolve(file)).replace(/\.ejs$/, '');
  const template = new Template(await readFile(file, 'utf8'), {
    compileDebug: false,
    _with: false,
    localsName: 'locals',
    destructuredLocals: [
      'req',
      'query',
      'url',
      'assetDomain',
      'email',
      'emails',
      'token',
      'process',
    ],
  });
  // EJS 6 no longer exposes client compilation. Compile during the build, then
  // emit its generated function body with explicit escape/include parameters.
  template.compile();
  entries.push(`${JSON.stringify(name)}: function(locals, escapeFn, include) {${template.source}}`);
}
await mkdir('cloudflare/generated/public/assets/css', { recursive: true });
await writeFile(
  'cloudflare/generated/templates.js',
  `export const templates = {${entries.join(',\n')}};\n`,
);
await copyFile(
  'service/assets/css/output.css',
  'cloudflare/generated/public/assets/css/output.css',
);
