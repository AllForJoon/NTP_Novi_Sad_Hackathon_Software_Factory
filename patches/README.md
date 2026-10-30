# Mozaik 4.2.0 compatibility patch

`@mozaik-ai+core+4.2.0.patch` preserves opaque Gemini function-call thought signatures. The runtime version is pinned in package.json and package-lock.json.

## Root cause and scope

The installed v4.2.0 API uses `FunctionCallItem`, not `ToolUseRequest`. Gemini `toResponse()` retained only id/name/arguments, while `toRequest()` reconstructed those fields without the original part's `thoughtSignature`. `runLoop` appends the same call object to ModelContext, so provider metadata can survive without a new inference adapter or orchestration layer.

The diff changes only:

- `dist/index.js` and `dist/index.mjs`: an optional signature field on FunctionCallItem, its rehydrate path and Gemini response/history mapping.
- `dist/index.d.ts` and `dist/index.d.mts`: matching optional string declarations.

Unsigned calls retain their existing own-property shape. Non-Gemini endpoint mapping is unchanged. The patch never generates a signature or changes the provider string. The factory's observer separately excludes opaque signature fields from persisted logs.

## Install and maintain

```sh
npm ci
```

The root postinstall runs `patch-package --error-on-fail`. It is idempotent, uses the checked-in patch, and fails installation if the pinned dependency no longer matches. `.gitattributes` forces patch files to LF for Windows/Linux consistency and permits the required blank context-line prefixes in unified diffs. Installs with `--ignore-scripts` require a subsequent `npm run postinstall`.

No manual edit of node_modules is part of setup. To intentionally revise the patch, edit the installed v4.2.0 bundle/type files during development, run `npx patch-package @mozaik-ai/core`, inspect the resulting diff, then run the full verification below. Do not upgrade Mozaik without checking/removing/updating this patch.

```sh
npm ci
npm run typecheck
npm run build
npm test
npm run smoke
npm run smoke:recovery
```

`tests/gemini-signature.test.ts` exercises the actual patched CJS/ESM mappers and Mozaik runLoop, sequential call signatures, ModelContext and explicit rehydration, non-Gemini payload equivalence and log privacy. All signatures in the automated test are local fixtures; no live Gemini credential or request is used.
