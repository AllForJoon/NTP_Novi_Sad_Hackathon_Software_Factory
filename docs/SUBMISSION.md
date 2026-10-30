# Hackathon submission guide

**Project:** Mozaik Software Factory

**Repository:** [AllForJoon/NTP_Novi_Sad_Hackathon_Software_Factory](https://github.com/AllForJoon/NTP_Novi_Sad_Hackathon_Software_Factory)

**Event:** JigJoy NTP Novi Sad Hackathon 2026, Track 01: Software Factory

## What was built

A Markdown specification starts a small AI engineering organization. Product
Manager creates a strict contract; Tech Lead publishes interfaces and a ticket
DAG; Developer A, Developer B and QA work concurrently in isolated workspaces;
Reviewer evaluates candidates without write authority; deterministic CI alone
decides completion. Failures return evidence to the responsible participant.

This is a Mozaik v4 runtime application. It does not shell out to a single coding
agent or replace Mozaik with Baro. The JigJoy integration is an inference runner
and an official login-credential helper. No external provider API key is required
when the signed-in account has hosted inference access.

## Suggested review path

1. Read the [README](../README.md) result table and organization diagram.
2. Open the [live evidence](evidence/jigjoy-2026-10-31/README.md). Each of four tasks
   has actual timestamps, overlapping worker spans, generated source/tests,
   accepted artifact hashes and deterministic gate exit codes.
3. Run the account-free checks below to rebuild and exercise the recorded outputs.
4. To observe new inference, sign in with your own Baro account and run the real
   Factory against any supported Markdown spec. Follow its actual trace and CI.

```sh
npm ci
npm run typecheck
npm run build
npm test
npm run verify:evidence
```

Expected: 73 runtime regressions pass; archived replay passes 72 generated QA
tests and 68 independent behavioral checks across all four projects. Archived
replay checks original hashes before copying sources to ignored `.work/`; it
performs no inference and does not alter the committed evidence.

For a new live run:

```sh
cp .env.example .env
npm install -g baro-ai@0.121.0
baro login
npm run factory -- ./specs/examples/sum-cli.md
npm run factory -- ./specs/examples/notes-api.md
```

The account needs its own hosted access/credits. Credentials are deliberately
absent from this repository. Existing Mozaik Cloud pairing remains separate.

## Where to inspect the implementation

| Capability | Implementation / proof |
| --- | --- |
| Mozaik orchestration | [`src/factory/company.ts`](../src/factory/company.ts) uses public `defineRuntime`, participants, events and `runLoop` |
| Independent roles and authority | [`prompts.ts`](../src/participants/prompts.ts), owned-file tools, read-only Reviewer |
| Concurrent developers and QA | Live event spans plus the three-worker barrier in [`factory.test.ts`](../tests/factory.test.ts) |
| Strict planning and semantic repair | [`schemas.ts`](../src/schemas.ts), [`planning-repair.test.ts`](../tests/planning-repair.test.ts) |
| Actual tool loops | [`agent-tools.ts`](../src/tools/agent-tools.ts), sequential tool/result replay in [`jigjoy.test.ts`](../tests/jigjoy.test.ts) |
| Hosted auth and inference | [`jigjoy-auth.ts`](../src/runtime/jigjoy-auth.ts), [`jigjoy.ts`](../src/runtime/jigjoy.ts), [official-source investigation](JIGJOY_HOSTED.md) |
| Reviewer / BUG / CI recovery | [`company.ts`](../src/factory/company.ts), actual failed-process regression cases and recorded QA revision |
| Deterministic completion | [`commands.ts`](../src/tools/commands.ts), [`http-startup.ts`](../src/tools/http-startup.ts); compiler, tests, HTTP response and exit codes |
| Independent acceptance | [`verify-output.mjs`](../scripts/verify-output.mjs) tests observable CLI/HTTP behavior outside generated QA |
| Privacy and traceability | Secret redaction, artifact hashes, curated evidence and preserved local full traces |

## What the evidence establishes

Sum CLI, Notes API, a file-statistics CLI and a Task API all completed with real
hosted inference. The last two inputs were first introduced after the bundled
examples and are now published unchanged. All three worker roles overlap in
every recorded run. File-statistics QA was rejected for insufficient checks,
revised its own tests, ran real checks and was accepted without human edits.

The submitted record also explains unsuccessful trials: unsupported native JSON
schema, insufficient reasoning/output budgets, and a missing normalization
assertion discovered by independent acceptance. The Factory was fixed and run
again rather than manually patching generated projects or weakening checks.

CI recovery and planning repair are additionally tested with explicit scripted
fixtures. `npm run smoke:recovery` is a reproducible offline recovery demo; it is
not represented as a hosted LLM run. CI itself needs no provider secrets.

## Boundaries

There is no claim of arbitrary-spec correctness, unlimited Pro inference, an OS
execution sandbox, distributed workers, crash resume, a frontend or deployment.
Observed live validation was on Windows/Node 22. GitHub Actions verifies the
runtime and archived outputs on Ubuntu and Windows. The hosted adapter was
verified with `deepseek-flash` Chat Completions; other hosted models and billing
entitlements are not inferred from Cloud pairing or a Pro badge.

## Submission preflight

Checked on 2026-10-31 KST in a separate checkout with no `.env` and no existing
`node_modules`. `npm ci` installed the locked dependencies and automatically
applied the pinned Mozaik patch.

| Check | Result |
| --- | --- |
| Clean `npm ci` | Passed; compatibility patch applied |
| `npm run typecheck` / `npm run build` | Passed |
| `npm test` | 73 passed, none failed/skipped |
| `npm run verify:evidence` | Four deliveries, 72 generated QA tests and 68 independent checks passed |
| `npm run smoke` / `npm run smoke:recovery` | Both COMPLETED; explicit offline fixtures |
| Evidence integrity | Source/spec hashes verified before rebuilding |
| Submission hygiene | No detected credential patterns or personal machine paths in public evidence; local Markdown links and staged whitespace checks passed |

GitHub Actions repeats the executable checks from a fresh installation on Ubuntu
and Windows. Its status badge links to the actual workflow results for the
submitted commit; committed live evidence records the earlier hosted executions.
