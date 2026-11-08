# Dependency maintenance

Use Node.js 24 and the pinned Yarn 4.18.1. Keep `enableScripts: false` and
`npmMinimalAgeGate: 7d` enabled in `.yarnrc.yml`. Do not add age-gate exceptions
without explicit user approval.

After changing dependencies, regenerate the lockfile, run `yarn install --immutable`,
`make test`, and `yarn audit`. Inspect findings and prefer a compatible parent
upgrade before a narrowly scoped resolution. Do not hide failing audits.

## Current resolution

`wrangler@4.148.0` pins `miniflare@5.20261006.0-alpha`, which pins vulnerable
`sharp@0.35.4`. The scoped resolution selects compatible patch `sharp@0.35.5`
for GHSA-wq5f-xc86-pv6w. That release was published on 2026-09-27 and passed the
age gate. Sharp is local development tooling, not application
code in the Worker. Remove the resolution when an eligible Wrangler/Miniflare
release supplies a fixed version without it.

## Deferred finding

The dependency audit on 2026-10-18 reports `braces@3.0.3` through
`@parcel/watcher@2.5.1` and `micromatch@4.0.8`, GHSA-vfj7-8cjw-p6xm, high severity. The advisory specifies
`3.0.4`, but the registry returns E404 for that version. Keep the finding visible
and recheck the parent/fixed release rather than inventing an incompatible pin.
