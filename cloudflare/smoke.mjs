import { strict as assert } from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const wrangler = 'node_modules/wrangler/bin/wrangler.js';
process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false';
const token = 'cloudflareintegrationtesttoken';
const base = 'http://127.0.0.1:8788';
const state = '.wrangler/integration';
const command = (...args) =>
  execFileSync(process.execPath, [wrangler, ...args, '--persist-to', state], { stdio: 'inherit' });
command('d1', 'migrations', 'apply', 'DB', '--local');
// This database belongs only to the smoke test, including interrupted runs.
command('d1', 'execute', 'DB', '--local', '--command', 'DELETE FROM messages');
const server = spawn(
  process.execPath,
  [
    wrangler,
    'dev',
    '--port',
    '8788',
    '--ip',
    '127.0.0.1',
    '--var',
    `ACCESS_TOKEN:${token}`,
    '--var',
    'DOMAIN_NAME:example.com',
    '--var',
    'PRIVATE_ACCESS:true',
    '--var',
    'EMAIL_TTL_DAYS:1',
    '--var',
    'INBOX_BLACKLIST:admin',
    '--persist-to',
    state,
    '--test-scheduled',
  ],
  { stdio: 'inherit' },
);

const raw = [
  'From: Sender <sender@example.net>',
  'To: Visible <visible@example.com>',
  'Message-ID: <cloudflare-integration@example.net>',
  'Subject: Cloudflare integration attachment test',
  'Date: Tue, 13 Oct 2026 12:00:00 +0000',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="test-boundary"',
  '',
  '--test-boundary',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Hello from Cloudflare integration testing.',
  '--test-boundary',
  'Content-Type: application/octet-stream',
  'Content-Disposition: attachment; filename="hello.bin"',
  'Content-Transfer-Encoding: base64',
  '',
  'AAEC//4=',
  '--test-boundary--',
  '',
].join('\r\n');

const request = (path, options = {}) =>
  fetch(`${base}${path}`, {
    ...options,
    headers: { 'x-api-key': token, ...options.headers },
  });
const deliver = (to, content = raw) =>
  fetch(`${base}/cdn-cgi/local/email?from=sender@example.net&to=${encodeURIComponent(to)}`, {
    method: 'POST',
    body: content,
  });

try {
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (server.exitCode !== null) {
      throw new Error(`Wrangler exited with code ${server.exitCode}`);
    }
    let response;
    try {
      response = await fetch(base);
    } catch {
      // Wait for the local runtime to start.
    }
    if (response) {
      assert.equal(response.status, 200, 'Worker home page must render');
      ready = true;
    }
    if (ready) break;
    await delay(500);
  }
  assert.ok(ready, 'Local Worker did not start');
  assert.equal((await fetch(`${base}/inbox?type=json`)).status, 403);
  assert.equal(
    (await request('/inbox?type=json', { headers: { 'x-api-key': 'incorrect' } })).status,
    403,
  );
  assert.equal((await fetch(`${base}/assets/css/output.css`)).status, 200);
  const invalidJsonInbox = await request('/inbox/admin?type=json');
  assert.equal(invalidJsonInbox.status, 422);
  assert.ok(invalidJsonInbox.headers.get('content-type')?.startsWith('application/json'));
  assert.ok(Array.isArray((await invalidJsonInbox.json()).errors));
  const invalidHtmlInbox = await request('/inbox/admin');
  assert.equal(invalidHtmlInbox.status, 422);
  assert.ok(invalidHtmlInbox.headers.get('content-type')?.startsWith('text/html'));
  assert.equal((await request('/inbox/ab?type=json')).status, 422);
  assert.equal((await request('/inbox/inboxsmoke?type=invalid')).status, 422);
  assert.equal((await request('/not-a-route?type=json')).status, 404);
  const invalidLogin = await fetch(base, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: 'incorrect', remember: 'on' }),
  });
  assert.equal(invalidLogin.status, 422);

  assert.equal((await deliver('inbox.smoke+bcc@example.com')).status, 200);
  assert.equal((await deliver('inboxsmoke@example.com')).status, 200);
  assert.equal((await deliver('otherinbox@example.com')).status, 200);
  const list = await (await request('/inbox/inboxsmoke?type=json')).json();
  assert.equal(list.emails.length, 1, 'Repeated delivery should be idempotent');
  assert.equal(list.emails[0].hasAttachments, true);
  const id = list.emails[0].id;
  const other = await (await request('/inbox/otherinbox?type=json')).json();
  assert.equal(other.emails[0].id, id, 'Recipient deliveries should share their raw email');
  const visible = await (await request('/inbox/visible?type=json')).json();
  assert.equal(visible.emails.length, 0, 'Header recipients must not create inbox entries');

  const html = await (await request('/inbox/inboxsmoke')).text();
  assert.ok(html.includes('Cloudflare integration attachment test'));
  assert.ok(html.includes('inboxsmoke@example.com'));
  const shown = await (await request(`/inbox/inboxsmoke/${id}`)).text();
  assert.ok(shown.includes('Hello from Cloudflare integration testing.'));
  assert.ok(shown.includes('hello.bin'));
  const json = await (await request(`/inbox/inboxsmoke/${id}?type=json`)).json();
  assert.equal(json.email.attachments[0].size, 5);
  assert.equal(await (await request(`/inbox/inboxsmoke/${id}/download`)).text(), raw);
  const attachment = await request(`/inbox/inboxsmoke/${id}/attachment?filename=hello.bin`);
  assert.deepEqual(Buffer.from(await attachment.arrayBuffer()), Buffer.from([0, 1, 2, 255, 254]));
  assert.equal((await request(`/inbox/unrelated/${id}?type=json`)).status, 404);
  assert.ok(
    (await (await request(`/inbox/inboxsmoke/feed/?x-api-key=${token}`)).text()).includes('<rss'),
  );
  assert.equal((await request('/inbox/inboxsmoke/latest?type=json')).status, 200);

  const login = await fetch(base, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token, remember: 'on' }),
  });
  assert.equal(login.status, 302);
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  assert.ok(
    login.headers
      .getSetCookie()
      .every(
        (value) =>
          value.includes('HttpOnly') &&
          value.includes('Secure') &&
          value.includes('SameSite=Strict'),
      ),
  );
  assert.equal(
    (await fetch(`${base}/inbox?type=json`, { headers: { Cookie: cookie } })).status,
    200,
  );
  assert.equal((await fetch(`${base}/inbox?type=json&x-api-key=${token}`)).status, 200);

  const rejected = await deliver('admin@example.com');
  assert.ok((await rejected.text()).includes('Recipient is not allowed'));
  const invalidRecipient = await deliver('bad%name@example.com');
  assert.ok((await invalidRecipient.text()).includes('Recipient is not allowed'));
  assert.equal((await request(`/inbox/inboxsmoke/${id}/delete`, { method: 'DELETE' })).status, 204);
  assert.equal((await request(`/inbox/inboxsmoke/${id}?type=json`)).status, 404);
  assert.equal((await request(`/inbox/otherinbox/${id}?type=json`)).status, 200);
  const legacyMessage = Buffer.concat([
    Buffer.from(
      'From: sender@example.net\r\nTo: otherinbox@example.com\r\n' +
        'Message-ID: <charset-test@example.net>\r\nSubject: Charset test\r\n' +
        'Content-Type: text/plain; charset=windows-1252\r\n\r\ncaf',
    ),
    Buffer.from([0xe9]),
  ]);
  assert.equal((await deliver('otherinbox@example.com', legacyMessage)).status, 200);
  const legacyList = await (await request('/inbox/otherinbox?type=json')).json();
  const legacyId = legacyList.emails.find((email) => email.subject === 'Charset test').id;
  const legacyDetails = await (await request(`/inbox/otherinbox/${legacyId}?type=json`)).json();
  assert.equal(legacyDetails.email.body, 'café\n');
  const legacyDownload = await request(`/inbox/otherinbox/${legacyId}/download`);
  assert.deepEqual(Buffer.from(await legacyDownload.arrayBuffer()), legacyMessage);
  command(
    'd1',
    'execute',
    'DB',
    '--local',
    '--command',
    "UPDATE messages SET ExpireAt = 1 WHERE Username = 'otherinbox'",
  );
  assert.equal((await request(`/inbox/otherinbox/${id}?type=json`)).status, 404);
  assert.equal((await (await request('/inbox/otherinbox?type=json')).json()).emails.length, 0);
  assert.equal((await fetch(`${base}/cdn-cgi/handler/scheduled`)).status, 200);
  const remaining = JSON.parse(
    execFileSync(
      process.execPath,
      [
        wrangler,
        'd1',
        'execute',
        'DB',
        '--local',
        '--persist-to',
        state,
        '--json',
        '--command',
        "SELECT COUNT(*) AS count FROM messages WHERE Username IN ('admin', 'inboxsmoke', 'otherinbox')",
      ],
      { encoding: 'utf8' },
    ),
  );
  assert.equal(
    remaining[0].results[0].count,
    0,
    'Blacklist, deletion, and cron should leave no rows',
  );
  process.stdout.write('Cloudflare local smoke test passed.\n');
} finally {
  server.kill('SIGTERM');
  await new Promise((resolve) => {
    if (server.exitCode !== null) resolve();
    else server.once('exit', resolve);
  });
}
