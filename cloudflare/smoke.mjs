import { strict as assert } from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { inlineMessage, largePng } from '../test/fixtures/inline.ts';

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

  // given: synthetic related MIME, including multi-megabyte images and hostile HTML
  const inlineDelivery = await deliver('inlineinbox@example.com', inlineMessage);
  assert.equal(inlineDelivery.status, 200, await inlineDelivery.text());
  assert.equal((await deliver('inlineother@example.com', inlineMessage)).status, 200);
  const inlineList = await (await request('/inbox/inlineinbox?type=json')).json();
  const inlineId = inlineList.emails[0].id;
  const inlineBase = `/inbox/inlineinbox/${inlineId}`;
  const inlineResponse = await request(`${inlineBase}?type=json`);
  const inlineJsonText = await inlineResponse.text();
  const inlineEmail = JSON.parse(inlineJsonText).email;
  assert.equal(inlineEmail.inlineParts.length, 5);
  assert.equal(inlineEmail.inlineParts[0].contentId, 'large@fixture');
  assert.equal(inlineEmail.inlineParts[0].size, largePng.length);
  assert.equal(inlineEmail.inlineParts[0].content, undefined);
  assert.equal(inlineEmail.inlineParts[3].url, undefined);
  assert.ok(inlineJsonText.length < 5000, 'JSON must not embed image bytes');
  const imagePath = inlineEmail.inlineParts[0].url;
  // when / then: authorization, membership, content restrictions and raw preservation
  assert.equal((await fetch(`${base}${imagePath}`)).status, 403);
  assert.equal((await request(imagePath, { headers: { 'x-api-key': 'wrong' } })).status, 403);
  assert.equal((await request(`/inbox/unrelated/${inlineId}/inline/0`)).status, 404);
  assert.equal((await request(`/inbox/admin/${inlineId}/inline/0`)).status, 422);
  assert.equal((await request(`${inlineBase}/inline/3`)).status, 404);
  assert.equal((await request(`${inlineBase}/inline/99`)).status, 404);
  assert.equal((await request(`${inlineBase}/inline/-1`)).status, 422);
  const image = await request(imagePath);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal(image.headers.get('content-disposition'), 'inline');
  assert.equal(image.headers.get('cache-control'), 'no-store');
  assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(image.headers.get('referrer-policy'), 'no-referrer');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), largePng);
  assert.equal(await (await request(`${inlineBase}/download`)).text(), inlineMessage);
  assert.deepEqual(
    Buffer.from(
      await (await request(`${inlineBase}/attachment?filename=fixture.bin`)).arrayBuffer(),
    ),
    Buffer.from([0, 1, 255]),
  );
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const unexpectedRequests = [];
    const imageRequests = [];
    page.on('request', (req) => {
      if (!req.url().startsWith(base)) unexpectedRequests.push(req.url());
      if (req.url().includes('/inline/')) {
        imageRequests.push({
          token: new URL(req.url()).searchParams.get('x-api-key'),
          referrer: req.headers().referer ?? '',
        });
      }
    });
    // No injected headers or cookies: the sandbox must work with query-token login.
    await page.goto(`${base}${inlineBase}?x-api-key=${token}`);
    const frame = page.frameLocator('#msg_body');
    await frame.locator('img').first().waitFor();
    await page.waitForFunction(() => document.querySelector('#msg_body')?.contentDocument === null);
    await frame
      .locator('img')
      .first()
      .evaluate((img) => img.decode());
    assert.equal(
      await frame
        .locator('img')
        .first()
        .evaluate((img) => img.naturalWidth),
      1024,
    );
    assert.equal(
      await frame.locator('img').nth(1).getAttribute('src'),
      await frame.locator('img').first().getAttribute('src'),
    );
    await frame
      .locator('img')
      .nth(2)
      .evaluate((img) => img.decode());
    assert.equal(await page.locator('body').getAttribute('data-compromised'), null);
    assert.equal(
      await frame.locator('script, form, iframe, svg, meta[http-equiv="refresh"]').count(),
      0,
    );
    assert.ok(!unexpectedRequests.some((url) => url.includes('remote.invalid')));
    assert.ok(imageRequests.length >= 2);
    assert.ok(imageRequests.every((request) => request.token === token && !request.referrer));
    assert.equal(await page.locator('#msg_body').getAttribute('sandbox'), '');
    // Browser isolation must hold independently of the sanitizer's allowlist.
    const isolated = await frame.locator('body').evaluate((body) => {
      const script = document.createElement('script');
      script.textContent = 'window.emailScriptExecuted = true';
      body.append(script);
      try {
        return {
          parentAccessible: Boolean(parent.document),
          scriptExecuted: 'emailScriptExecuted' in window,
        };
      } catch {
        return { parentAccessible: false, scriptExecuted: 'emailScriptExecuted' in window };
      }
    });
    assert.deepEqual(isolated, { parentAccessible: false, scriptExecuted: false });
    await page.goto(`${base}/inbox/inlineinbox/latest?x-api-key=${token}`);
    await page
      .frameLocator('#msg_body')
      .locator('img')
      .first()
      .evaluate((img) => img.decode());
  } finally {
    await browser.close();
  }
  assert.equal((await request(`${inlineBase}/delete`, { method: 'DELETE' })).status, 204);
  assert.equal((await request(imagePath)).status, 404);
  assert.equal((await request(`/inbox/inlineother/${inlineId}/inline/0`)).status, 200);

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
    "UPDATE messages SET ExpireAt = 1 WHERE Username IN ('otherinbox', 'inlineother')",
  );
  assert.equal((await request(`/inbox/otherinbox/${id}?type=json`)).status, 404);
  assert.equal((await request(`/inbox/inlineother/${inlineId}/inline/0`)).status, 404);
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
