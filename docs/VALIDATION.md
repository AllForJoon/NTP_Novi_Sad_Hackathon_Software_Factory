# Initial implementation and validation record

Validated locally on 2026-10-30, Windows, Node v22.14.0, npm 10.9.2.

This opening record describes the initial implementation. The planning self-repair follow-up and its current 29-test results are recorded below.

## Starting point and delivered files

The cloned repository contained only `.git`, with no commits, source, tests, README or package configuration. The implementation brief was supplied separately at `../codex.md`; it was read before implementation.

Created:

- `src/cli.ts`, `src/config.ts`: one-command entry point and role/model/limit configuration.
- `src/factory/company.ts`: Mozaik participants, event reactions, DAG scheduling, review queue, deterministic integration and recovery.
- `src/runtime/{situations,inference}.ts`: situation specifications and bounded inference/fault adapter.
- `src/{schemas,state}.ts`: strict contract/plan/verdict validation, shared typed state, ticket lifecycle and interventions.
- `src/participants/prompts.ts`: six different role policies and authority boundaries.
- `src/tools/{workspace,commands,agent-tools}.ts`: isolated owned artifacts, hashes, bounded file tools and fixed child commands.
- `src/tracing/observer.ts`: JSONL events, readable activity and state snapshots.
- `src/testing/demo-runner.ts`: clearly labeled scripted offline fixture.
- `specs/examples/{sum-cli,notes-api}.md`: CLI and HTTP example specifications.
- `tests/{contracts,tools,factory}.test.ts`: 18 validation, boundary and integration tests.
- `README.md`, this report, `.env.example`, `.gitignore`, TypeScript/npm configuration and lockfile.
- `.github/workflows/ci.yml`: reproducible Ubuntu/Windows checks and trace artifact upload.

## Exact validation commands and results

From the repository root:

| Command | Result |
| --- | --- |
| `npm ci` | Successful clean installation; 148 packages audited, 0 reported vulnerabilities |
| `npm run typecheck` | Passed |
| `npm run build` | Passed |
| `npm test` | **18 passed, 0 failed, 0 skipped** |
| `npm run smoke` | COMPLETED, first CI attempt passed |
| `npm run smoke:recovery` | COMPLETED, first CI attempt failed actual QA assertions; second passed after generated repair |
| `npm run factory -- ./specs/examples/sum-cli.md` | Expected exit **1** with explicit `OPENAI_API_KEY is required` message; no live LLM run claimed |

Then, from `output/2026-10-30T10-47-38-269Z-cc52612b`:

| Command | Result |
| --- | --- |
| `npm run build` | Passed |
| `npm test` | **15 passed, 0 failed** |
| `node dist/index.js sum 2 3` | Printed `5`, exit 0 |

The final generated `src/index.ts` and `src/validation.ts`, trace JSONL, state snapshot and both CI attempts were inspected directly. The source-key pattern scan found no matching committed key/private-key values. Generated directories and local `.env` are ignored.

## Concrete runtime evidence

Normal smoke run: `2026-10-30T10-47-34-126Z-ac39af22`.

Recovery smoke run: `2026-10-30T10-47-38-269Z-cc52612b`.

These are **offline scripted fixtures**, with real Mozaik loops, tool writes and child processes. Timestamps below are relative elapsed seconds from that recovery run's activity log:

| Activity | Start | End |
| --- | --- | --- |
| Developer A / DEV-001 | 0.07 s | 0.14 s |
| Developer B / DEV-002 | 0.08 s | 0.15 s |
| QA / QA-001 | 0.09 s | 0.15 s |

Their intervals overlap. The independent automated concurrency test additionally required all three workers to enter a barrier before any could proceed.

Recovery sequence observed:

1. CI typecheck/build succeeded; Node tests rejected the candidate that accepted empty operands as zero.
2. `verification.failed` was recorded at about 2.47 s with nonzero test exit code and captured output.
3. Reviewer triage classified the validation defect and created `BUG-001` for Developer B at about 2.50 s.
4. The worker wrote the repaired validation artifact through its file tool, followed by review and reintegration.
5. All three CI gates passed at about 4.84 s.
6. `DEV-001`, `DEV-002`, `QA-001`, and `BUG-001` finished `DONE`. Human intervention count was 0. Token totals and cost were `null`, because the fixture does not consume or report provider tokens.

Machine-readable evidence remains locally under `traces/<run-id>/`, and delivery under `output/<run-id>/`. These ignored artifacts are reproducible with the smoke commands; they are not fabricated or hard-coded activity logs. GitHub Actions also uploads smoke evidence as workflow artifacts.

## Material limits and next priorities

No provider API credentials were present. Live arbitrary-spec generation and the HTTP example were **not** run. The first next step is a provider-backed run against both examples and unseen challenge specs, followed by investigation of any actual model/protocol failures.

The current scope deliberately excludes external runtime dependencies. File/tool restrictions are application boundaries, not an OS sandbox. The Mozaik inference API exposes no request abort signal; timed-out SDK requests may finish in the background. There is no crash resume or distributed worker service. Multi-model cost rates and full batched tool-call support are follow-up work. See README for the complete operating limits.

The added GitHub Actions workflow has not been claimed as passing based on local tests alone; its remote status must be checked after push.

## Planning self-repair follow-up

Implemented the second brief (`../codex_second.md`) against the existing runtime without redesigning the company. The reported Gemini run failed semantic plan validation with `Plan needs independent initial tickets for both developers`; this is not a provider failure.

Changed files:

- `src/factory/company.ts`: shared bounded semantic-repair loop for PM and Tech Lead; validation/repair events and top-level retry metadata.
- `src/config.ts` and `.env.example`: `MAX_PLANNING_RETRIES`, default 2, allowed integers 0 through 5.
- `src/participants/prompts.ts`: explicit contract and all eleven non-negotiable plan invariants.
- `tests/planning-repair.test.ts`: eleven new deterministic planning-repair tests.
- `tests/contracts.test.ts`: configuration default, zero/override and invalid-limit checks.
- `README.md` and this record: retry semantics, trace events, evidence and next live command.

The same planning participant receives the original spec or valid Product Contract, its latest rejected candidate, exact redacted validation error, repair-only instruction and invariants. Each replacement must pass the same original validator. The budget is per planning role: initial attempt plus at most two semantic repairs by default, separate from provider retries and implementation repairs. Exhaustion is a clear terminal protocol failure; it does not produce fake developer or bug tickets. Basic schema errors retain their previous protocol-failure handling.

**No validators were weakened or modified.** `src/schemas.ts` has no diff. Both developers still need an independent initial ticket. Ownership, entry-point, coverage, dependency/DAG and reserved-ID checks all remain in force.

New real events:

```text
contract.validation_failed
contract.repair_requested
plan.validation_failed
plan.repair_requested
```

Each event uses existing run/participant/role tracing, a top-level retry index and validation error evidence. Retry 0 denotes the initial rejected output; repairs start at 1. Invalid contracts/plans are not published as ready. Redaction is tested against persisted JSONL/state and final error messages.

New deterministic cases prove:

1. A serial Tech Lead plan is rejected, automatically repaired by the same participant, then Dev A, Dev B and QA begin and the complete run passes CI.
2. Repeated invalid plans stop after exactly three attempts with the default two-repair budget.
3. The final allowed repair can succeed, and the prompt contains the latest rejected plan and latest error.
4. PM repairs duplicate IDs.
5. PM repairs unknown requirement references.
6. PM repairs uncovered requirements.
7. PM exhaustion stops before Tech Lead work.
8. Zero planning retries performs only the initial attempt.
9. Basic schema errors do not enter semantic repair.
10. Secret-shaped validation evidence is redacted.
11. PM and Tech Lead receive independent repair budgets.

Executed after the code/test changes on 2026-10-30:

| Exact command | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm run build` | Passed |
| `npm test` | **29 passed, 0 failed, 0 skipped** |
| `npm run smoke` | COMPLETED; normal generated-project gates passed |
| `npm run smoke:recovery` | COMPLETED; first candidate failed QA, automatic code repair passed the second CI attempt |

Smoke traces: `2026-10-30T11-28-30-739Z-4451fb29` (normal) and `2026-10-30T11-28-34-903Z-bb4f9d00` (code recovery). Planning-repair tests use isolated temporary roots and actual Mozaik loops/compiler/test processes with scripted inference; no Gemini API call is required or claimed for this follow-up.

For the next real Gemini run, from the repository root in a PowerShell session that already has `GEMINI_API_KEY` configured:

```powershell
$env:FACTORY_MODEL = 'gemini-3.5-flash-lite'
npm run factory -- ./specs/examples/sum-cli.md
```

This model matches the latest existing live trace and the installed Mozaik registry. Existing role-specific model overrides still take precedence over `FACTORY_MODEL`; keep them on the intended Gemini models when reproducing that run. `MAX_PLANNING_RETRIES` defaults to 2 without any environment change.
