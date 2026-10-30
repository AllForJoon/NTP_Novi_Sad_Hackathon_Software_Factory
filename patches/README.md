# Required Mozaik compatibility patch

`@mozaik-ai+core+4.2.0.patch` preserves provider-required Gemini tool-call
signatures through Mozaik context, rehydration and request mapping. It updates
the CJS/ESM bundles and their matching type declarations. Other providers and
unsigned calls retain their behavior; opaque signatures are redacted from traces.

`npm ci` applies this patch automatically through
`postinstall: patch-package --error-on-fail`. The pinned version and lockfile
are required. If installation scripts were skipped, run `npm run postinstall`.

Keep the patch and `tests/gemini-signature.test.ts` together. The tests exercise
actual patched mappers and sequential Mozaik tool loops without live credentials.
When upgrading Mozaik, check whether the patch is still needed and update it
against that version before running the full regression suite.
