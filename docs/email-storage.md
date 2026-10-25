# Parsed email storage

Raw MIME remains the authoritative, byte-for-byte download at its SHA-256 R2 key.
The application also stores private, rebuildable derived data so that displaying
a message or loading each image does not repeatedly decode the entire MIME file.

## Objects and publication

Each version-1 conversion uses a unique generation:

```text
<sha256>                                          original MIME
parsed/v1/<sha256>/<generation>/body               decoded UTF-8 body
parsed/v1/<sha256>/<generation>/parts/<index>      decoded binary MIME part
parsed/v1/<sha256>/<generation>/manifest.json      headers, metadata, part mappings
```

The manifest contains no binary payloads, authentication tokens, or public URLs.
It preserves MIME part ordering, Content-IDs, filenames, content types, addresses,
and the parsed message date. A CID-bearing image that is also a downloadable
attachment references one stored object in both metadata lists. Unsupported
inline formats remain recorded but cannot be served through the image endpoint.

`email_derivatives` in D1 is the publication and cleanup index. A conversion:

1. Registers an unpublished generation before writing derived objects.
2. Parses the original MIME and writes decoded parts sequentially.
3. Writes the body, then the complete manifest.
4. Marks the generation ready in D1 only after all object writes succeed.

Failures leave an unpublished generation that readers ignore. A subsequent
request retries in a new generation; cleanup also covers failed generations.
Concurrent cold requests may perform duplicate conversion work, but each publishes
its own complete generation. No request shares another request's in-flight I/O or
stream. Once a generation is ready, later requests reuse it across Worker isolates.

## Ingestion and existing messages

New deliveries persist the raw MIME and prepare the derived representation before
creating inbox metadata. Identical deliveries can reuse a ready generation.

Existing emails require no backfill or resend. Their first authorized message,
image, attachment, or RSS read converts the original MIME lazily. A missing or
incompatible published manifest is invalidated and rebuilt. Raw downloads always
use the original object and never require conversion.

Message views and RSS load the manifest and decoded body. Image and attachment
requests load the manifest and stream only the selected binary object, without
loading the body or reparsing the raw MIME. Public JSON retains the documented
contract and does not expose storage keys or generation bookkeeping.

## Authentication and retention

R2 remains private. Every HTTP resource request passes instance authentication,
username validation, and unexpired D1 inbox membership checks before accessing
derived storage. A cached generation never grants access to another inbox.
Recipient-specific deletion only removes that recipient's metadata; it cannot
delete the shared raw or derived objects needed by another recipient.

Each generation's expiration is calculated from the raw object's R2 upload time
and the configured email TTL, not the lazy conversion time. Generations are not
read after that expiration. A repeated delivery can refresh the raw object's
lifetime; an older generation expires normally and can be rebuilt from that
refreshed source when necessary.

The existing cleanup schedule removes expired generations, including unpublished
ones, in bounded batches (up to 100 generations and 1,000 objects per generation
per invocation). A partially cleaned generation stays indexed for the next run.
The existing bucket-wide R2 lifecycle rule also applies to every derived object
as a fallback. Physical removal is asynchronous, as it is for raw MIME.

## Deployment and limits

Apply `0002_email_derivatives.sql` before deploying this code. The migration adds
one independent table and indexes; it does not change `messages` or raw keys.
Older application code can continue running during migration or rollback and
simply ignores derived data. No Terraform resources, DNS, bindings, or new buckets
are needed.

RSS still accounts for the original MIME sizes against its 25 MiB cumulative
source-byte budget, including warm reads. It retains the 1 MiB feed-item and 2 MiB
output limits. A cold read checks its remaining source-byte budget before buffering
the raw object. A warm read checks the manifest's original size before loading the
body. Oversized feeds return 413 without silently omitting content.

This trades extra private R2 objects and an index lookup for lower read-time CPU
and memory. Conversion still buffers and parses one complete message and writes
one object per distinct decoded MIME part. Platform CPU, memory, and subrequest
limits still apply. This change does not establish a measured peak-memory bound
for arbitrary 25 MiB messages or concurrent conversions.
