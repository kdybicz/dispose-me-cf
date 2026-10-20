import { Buffer } from 'node:buffer';
import { crc32, deflateSync } from 'node:zlib';

const chunk = (name: string, bytes: Buffer): Buffer => {
  const data = Buffer.concat([Buffer.from(name), bytes]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(data));
  return Buffer.concat([length, data, checksum]);
};

// A valid 3 MiB PNG, generated without storing private mail or a large binary fixture.
const header = Buffer.alloc(13);
header.writeUInt32BE(1024, 0);
header.writeUInt32BE(1024, 4);
header[8] = 8;
header[9] = 2;
export const largePng = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(Buffer.alloc(1024 * (1024 * 3 + 1)), { level: 0 })),
  chunk('IEND', Buffer.alloc(0)),
]);
const smallPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=',
  'base64',
);

export const inlineMessage = [
  'From: sender@example.net',
  'To: visible@example.com',
  'Subject: Inline image regression',
  'Message-ID: <inline-fixture@example.net>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/related; boundary="inline-fixture"',
  '',
  '--inline-fixture',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>Inline images</p><img src="cid:large%40fixture"><img src="CID:%3Clarge%40fixture%3E">' +
    '<img src="cid:second"><img src="cid:missing"><img src="cid:%ZZ">' +
    '<img src="cid:active"><img src="https://remote.invalid/pixel">' +
    '<script>parent.document.body.dataset.compromised="yes"</script>' +
    '<img src="cid:second" onload="parent.document.body.dataset.compromised=\'yes\'">' +
    '<form action="/logout"><input type="submit"></form>' +
    '<iframe src="/logout"></iframe><meta http-equiv="refresh" content="0;url=/logout">' +
    '<svg onload="alert(1)"></svg><style>body{background:url(https://remote.invalid/css)}</style>',
  ...[
    { id: 'large@fixture', type: 'image/png', content: largePng, disposition: 'inline' },
    { id: 'second', type: 'image/png', content: smallPng, disposition: '' },
    {
      id: 'large@fixture',
      type: 'image/png',
      content: Buffer.from('duplicate'),
      disposition: 'inline',
    },
    { id: 'active', type: 'image/svg+xml', content: Buffer.from('<svg/>'), disposition: 'inline' },
    { id: '', type: 'image/png', content: smallPng, disposition: 'inline' },
    {
      id: 'download',
      type: 'application/octet-stream',
      content: Buffer.from([0, 1, 255]),
      disposition: 'attachment; filename="fixture.bin"',
    },
  ].flatMap(({ id, type, content, disposition }) => [
    '--inline-fixture',
    `Content-Type: ${type}`,
    ...(id ? [`Content-ID: <${id}>`] : []),
    ...(disposition ? [`Content-Disposition: ${disposition}`] : []),
    'Content-Transfer-Encoding: base64',
    '',
    content
      .toString('base64')
      .match(/.{1,76}/g)
      ?.join('\r\n') ?? '',
  ]),
  '--inline-fixture--',
  '',
].join('\r\n');
