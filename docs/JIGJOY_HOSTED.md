# JigJoy hosted inference

> Submission evidence is now committed: [four generated projects and curated traces](evidence/jigjoy-2026-10-31/README.md). Run `npm run verify:evidence` to rebuild them without credentials. The originally unseen specs are now published unchanged under `specs/validation/`, and independent checks are in `scripts/verify-output.mjs`. Earlier local-only paths below describe the investigation workspace.

Investigated on 2026-10-31 (KST), against official `baro-ai@0.121.0`, Baro source,
installed `@mozaik-ai/core@4.2.0` and `@mozaik-ai/cloud-sdk@0.1.3`.

## Official path and authentication

The [Baro provider documentation](https://docs.baro.rs/docs/llm-providers) exposes
`baro --llm jigjoy`: the hosted gateway owns upstream model credentials.
The current [native CLI source](https://github.com/jigjoy-ai/baro/blob/main/crates/baro-tui/src/main.rs)
defines the gateway and hosted model aliases. Neither the installed Core v4
registry nor Cloud SDK exports a hosted JigJoy inference runner. The published
Baro package has a CLI binary and bundled scripts, without an exported JS client.
Therefore this project uses a small custom `InferenceRunner`, keeping all Mozaik
orchestration and role/tool boundaries.

`baro login` performs browser device authorization against the Baro control plane.
It stores a CLI session at `~/.baro/credentials.json`. The Factory never reads or
copies that session. Instead it invokes the same official
`~/.baro/bin/acquire-gateway-credential.mjs` helper used by Baro's native CLI.
Install with `npm install -g baro-ai@0.121.0`, then `baro login` once.

The official [credential implementation](https://github.com/jigjoy-ai/baro/blob/main/packages/baro-orchestrator/src/gateway-credentials.ts)
uses the session's saved control origin, default `https://api.baro.jigjoy.ai`,
POSTs `{}` to `/cli/gateway/credentials` with its CLI bearer session, and validates
the no-store response, expiry, gateway origin, run binding and exact token scopes.
The result contains `schemaVersion`, `runId`, `gatewayBaseUrl`, `apiKey`, and
`expiresAt`. Its signed `gk_v1` credential is limited to `model:invoke`,
`billing:receipts:read`, and `billing:attribution`; maximum lifetime is 24 hours.
The [shipped helper](https://github.com/jigjoy-ai/baro/blob/main/packages/baro-orchestrator/scripts/acquire-gateway-credential.ts)
deliberately returns the exchange result to its parent process through stdout.
Our parent captures it privately and shares one cached exchange among concurrent
agents. Credentials stay in memory; errors and traces redact them. Ambient
upstream API keys and `OPENAI_BASE_URL` do not select the hosted endpoint.

Mozaik Cloud's separate `~/.mozaik/credentials.json` is project telemetry pairing,
not a gateway login. It is neither read by this adapter nor sent for inference.
Existing Cloud export remains active with `MOZAIK_REDACTION=all`.

## Wire protocol, models and limitations

The official [OpenAI harness](https://github.com/jigjoy-ai/baro/blob/main/packages/baro-orchestrator/src/harness/openai/runtime.ts)
and [chat handling](https://github.com/jigjoy-ai/baro/blob/main/packages/baro-orchestrator/src/harness/openai/chat-stream.ts)
use the OpenAI-compatible gateway. This runner POSTs to the helper-returned base
`https://gw.baro.jigjoy.ai/v1` plus `/chat/completions`, bearer-authenticated with
the scoped credential. Requests contain `model`, `messages`, optional `tools`,
`parallel_tool_calls:false`, `max_tokens` and `response_format`.

Current official Baro aliases include `deepseek-flash` (story/review default) and
`gpt-6.1-sol` (strong-model default). The selected shared model is **deepseek-flash**,
actually accepted by this account with HTTP 200. No claim is made that every
official alias is enabled for this account. GET `/v1/models` returned 404, so the
server provides no model catalogue through that route. GPT Responses routing and
streaming are outside this first integration; all verified runs use Chat
Completions and one shared hosted model.

Responses contain `choices[0].message` (`content`, optional `reasoning_content`,
`tool_calls`), `finish_reason` and optional `usage`. Mozaik's public mapper handles
system/developer/user/assistant/tool messages and function arguments/results.
The adapter preserves returned reasoning and accompanying assistant content on
the exact tool-call object in a WeakMap and restores them for subsequent requests; concurrent contexts cannot
overwrite each other's metadata. Mozaik executes each tool and owns repeated
model/tool/result iterations. The adapter never executes tools itself.

This gateway rejected native `json_schema` with HTTP 400 “response_format type is
unavailable now”; `json_object` succeeded. Only explicit capability errors trigger
bounded format negotiation (`json_schema` → `json_object` → schema-in-prompt).
All modes receive the full schema as a final-answer instruction. Complete JSON
fences can be removed, but malformed JSON and semantic violations remain errors.
The existing local Zod schemas, parseContract/parsePlan, semantic planning repair,
review repair, deterministic CI and BUG recovery remain authoritative.

Measured usage includes `prompt_tokens`, `completion_tokens`, `total_tokens`,
cached-token and reasoning-token details. Missing usage remains unknown; no tokens
or prices are invented. Baro's `_baro_billing` extension correlates its own billing
receipt feed; a real hosted invocation succeeded without it. This Factory does
not fabricate Baro billing sessions or authoritative receipt amounts.

No numeric per-account rate limit was advertised by the inspected sources or
successful gateway responses. HTTP status and Retry-After flow into existing
bounded provider retries; auth and deterministic 4xx failures never create code
BUG tickets. Request cancellation covers format negotiation as a whole.

The first Notes API trial hit the original Factory's 12,000-token output ceiling
during QA generation. The official Baro generic OpenAI model uses 32,768 tokens;
the hosted Factory now uses that same default via `MAX_OUTPUT_TOKENS`, with a
240-second per-request timeout to accommodate reasoning and test-file payloads.
External modes retain the previous 12,000-token / 120-second defaults. This is a
provider budget change, not a relaxation of product schemas or test requirements.
DeepSeek's [thinking-mode documentation](https://api-docs.deepseek.com/guides/thinking_mode/)
also requires replaying `reasoning_content` across tool iterations; the adapter's
identity-based metadata preservation is exercised by the real Mozaik-loop test.

A later Notes Reviewer response also exhausted the 32,768-token ceiling under
the provider's default reasoning effort. `FACTORY_REASONING_EFFORT` now passes
through Mozaik's public inference input and mapper; the hosted setup explicitly
selects `low`. A direct authenticated gateway call with `reasoning_effort:low`
returned HTTP 200. The control is documented by DeepSeek at the link above and
does not disable reasoning. It is optional for external provider modes, whose
model-specific support still applies. No numeric rate-limit headers were present
on that successful response. Token ceilings and provider-error separation remain.

An independent Notes API acceptance check subsequently caught an end-to-end
contract interpretation gap: PM marked storage normalization ambiguous, the plan
preserved padded text, and QA accepted either form despite the spec's “trimmed”
wording. Its internal CI passed, but the independent check rejected it. The shared
role policy and PM invariants now require explicitly stated normalization to
survive storage/output and to have exact noncanonical-input acceptance checks.
This applies to arbitrary normalized fields, without a bundled-example branch,
generated-code edit, schema relaxation, or weakened acceptance test. Notes API
is regenerated from the original specification for independent revalidation.

Successful exchange and live invocation prove this login can use hosted inference
without external API keys. They do not prove that every Mozaik/JigJoy Pro or
hackathon badge includes unlimited inference. The [Baro cloud documentation](https://docs.baro.rs/docs/cloud)
describes account credit billing. The exact entitlement, balance, prices and
future limits remain controlled by the service/account; no undocumented account
or billing endpoint is queried. A one-time browser approval was required here;
after the session appeared, credential acquisition and execution continued
automatically. No provider API key was entered or copied.

## Validation

Deterministic tests cover a real Mozaik loop with two sequential function calls,
tool results, context/reasoning preservation, concurrent contexts with duplicate
call IDs, shared credential acquisition, native/fallback JSON modes, real usage,
error classification, helper capture and redaction, and provider configuration.
Final source checks: `npm run typecheck` **passed**, `npm run build` **passed**,
`npm test` **73 passed, 0 failed**, and `git diff --check` passed. The full final
test output is local at `.work/jigjoy-investigation/tests-final.log`.

### Real hosted E2E results

Every run below used the live CLI without either demo flag, the same hosted
`deepseek-flash` model, all six AI roles, deterministic Integrator / CI, and the
existing redacted Mozaik Cloud exporter. No generated production/test artifact
was manually patched. All CI command exit codes were zero.

| Task | Run ID | Result | Generated QA tests | Independent checks | CI gates |
| --- | --- | --- | ---: | ---: | ---: |
| Sum CLI | `2026-10-30T22-33-32-191Z-43c4378a` | COMPLETED | 25 | 15 | 3 |
| Notes API | `2026-10-30T22-30-48-532Z-b5f83de1` | COMPLETED | 10 | 16 | 4 |
| Unseen UTF-8 file-count CLI | `2026-10-30T22-20-13-790Z-6c16658c` | COMPLETED | 16 | 15 | 3 |
| Unseen Task API | `2026-10-30T22-23-22-359Z-9ceabbc2` | COMPLETED | 21 | 22 | 4 |

The final bundled runs explicitly used `reasoning_effort:low`. The unseen runs
completed with provider-default effort before that setting was added. Sum CLI
also completed two earlier hosted trials; the table selects its final adapter
regression run. Earlier failed trials remain in local traces rather than being
erased: `b16ce6f8` rejected unsupported native JSON schema; `391c4616` exhausted
the old 12K output budget; `6edca532` completed internally but failed the separate
normalization assertion; `5e8881be` exhausted the 32K Reviewer output budget.

Independent checks cover numeric/arity/invalid-input CLI cases; exact normalized
Notes CRUD responses and isolated stores; empty/missing/directory files, LF/CRLF,
blank lines, Unicode code points and paths containing spaces; and Task CRUD,
optional boolean defaults, malformed bodies, status codes and isolated stores.
They exercise the built outputs directly through Node subprocesses or real local
HTTP requests, separately from generated QA tests. **68 independent checks passed.**

The temporary unseen specs are `.work/jigjoy-investigation/file-counts.md` and
`tasks-api.md`. Their real commands were:

```sh
npm run factory -- ./specs/examples/sum-cli.md
npm run factory -- ./specs/examples/notes-api.md
npm run factory -- ./.work/jigjoy-investigation/file-counts.md
npm run factory -- ./.work/jigjoy-investigation/tasks-api.md
```

All four traces show PM → Tech Lead → actual concurrent Developer A / Developer B
/ QA turns → Reviewer → Integrator → `verification.passed` → `project.completed`.
The three worker spans overlap by respectively 8,298 ms, 17,110 ms, 14,122 ms and
15,253 ms. All measured model calls have provider token usage; none are fabricated
or unmetered. The successful evidence runs had no provider retries. Cost remains
unknown (`null`) because no authoritative price schedule was configured.

The file-count run additionally proves hosted review recovery: Reviewer requested
stronger no-write/no-network tests, QA revised only its owned test file, executed
real local checks, resubmitted, and Reviewer accepted. Existing deterministic
tests separately verify invalid-plan repair and CI failure → Reviewer → BUG →
responsible developer → passing reverification. Those tests are explicitly
fixtures, separate from the real hosted runs above.

Local evidence: `traces/<run-id>/{events.jsonl,activity.log,state.json}` and
`output/<run-id>/`. `.work/jigjoy-investigation/final-evidence.json` records actual
worker spans, model usage, gate exits and recovery counts; its `summarize.mjs`
verifies live/provider/model labels, all roles, ordering, overlap, successful
gates and absence of credential-shaped values in persisted traces. Separate
`*-evidence.json` files record completed independent acceptance checks. Generated
artifacts, traces, research cache and `.env` remain Git-ignored.

### Changed files and operational outcome

Migration changes are in:

- `src/runtime/jigjoy-auth.ts`: official helper invocation, safe classification,
  credential validation and private capture.
- `src/runtime/jigjoy.ts`: hosted runner, shared credentials, mapper conversion,
  assistant/tool metadata replay, structured-output negotiation and cancellation.
- `src/config.ts`, `.env.example`: provider/model, token and reasoning settings.
- `src/factory/company.ts`: select the runner and pass public inference settings;
  record nonsecret provider configuration in startup evidence.
- `src/tools/commands.ts`: redact runtime-issued gateway secrets as well as
  environment credentials.
- `src/participants/prompts.ts`: preserve specified normalization across roles.
- `tests/jigjoy.test.ts`: seven new deterministic adapter/config/auth tests.
- `README.md`, this document: setup, official research and actual validation.

Earlier uncommitted planning repair, provider retry, Gemini signature, ownership,
CI recovery and HTTP-startup work was preserved. No new runtime dependency or
replacement orchestrator was introduced. The private local `.env` now selects
`jigjoy`, `deepseek-flash`, and `low`; no secret was copied into source or logs.

**Official hosted reuse works for this signed-in account. External provider API
keys are not required.** A one-time browser login was needed and completed;
subsequent credential acquisition and all engineering runs were automatic. No
human action remains pending. Limits remain the hosted account's available
credits/entitlement, undocumented numeric rate limits/model catalogue, bounded
retry/output/deadline settings, and the tested non-streaming Chat Completions
surface. Other hosted aliases, GPT Responses routing, unlimited Pro usage and
authoritative billing charges are not claimed to have been verified.
