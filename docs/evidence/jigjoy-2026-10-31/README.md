# Recorded JigJoy-hosted Software Factory runs

These four deliveries came from **real hosted inference**, without demo flags,
on 2026-10-31 KST, Windows, Node v22.14.0, Mozaik v4.2.0. Every run reached
`verification.passed` and `project.completed`. Generated artifacts were not
manually patched.

| Task | Source snapshot | Recorded run | Generated tests | Independent checks |
| --- | --- | --- | ---: | ---: |
| Sum CLI | [project](sum-cli/project) | [run.json](sum-cli/run.json) | 25 | 15 |
| Notes API | [project](notes-api/project) | [run.json](notes-api/run.json) | 10 | 16 |
| File-statistics CLI | [project](file-counts/project) | [run.json](file-counts/run.json) | 16 | 15 |
| Task API | [project](tasks-api/project) | [run.json](tasks-api/run.json) | 21 | 22 |

## Reproduce without credentials

From the repository root:

```sh
npm ci
npm run verify:evidence
```

This is an **offline replay**, not a new hosted run. The script verifies recorded
source/specification hashes, participant events and worker overlap; copies each
project into ignored `.work/`; runs real typecheck/build/generated tests and HTTP
startup gates; then runs 68 independent behavior checks. It needs no login,
provider key or new inference. The 72 generated QA tests remain unmodified.

## Files and provenance

- [manifest.json](manifest.json): all run IDs, exact spec paths/hashes, source
  hashes, timestamps/spans, token metrics and gate summaries.
- Each `project/`: unchanged source and QA bytes checked against the Factory's
  recorded accepted SHA-256 artifacts; plus the CI-owned package/TS scaffold.
- Each `events.jsonl`: ordered original events with a strict selection of
  timestamp, run/role/ticket, event, phase, elapsed/retry, model and token fields.
- Each `verification.json`: actual attempt/status/timestamps and numeric command
  exit, signal, elapsed, timeout and error fields. Absolute command/cwd strings
  and raw stdout/stderr are omitted.
- Each `product-contract.json`, `engineering-plan.json` and `reviews.json`:
  model-produced planning and review decisions for these public example specs.
- Each `run.json`: task-specific metadata, independent acceptance counts and
  artifact hashes.

These are curated copies, not raw transcripts. Arbitrary event payloads,
participant identifiers, local machine paths, credential/session files and raw
provider responses are excluded. Full original `traces/` and `output/` directories remain
local and ignored. No token or account credential is required to review this
committed evidence.

The bundled final runs explicitly used `reasoning_effort:low`. The two originally
unseen scenarios completed with provider-default effort. All used the hosted
`deepseek-flash` alias. Prices are not known; `estimatedCostUsd:null` is not a
claim that inference was free.

File-statistics records include one actual `review.changes_requested` cycle:
Reviewer requested stronger no-write/no-network assertions, QA revised only its
test artifact, ran checks and resubmitted successfully. CI/BUG and invalid-plan
recovery have separate deterministic tests; they are not relabeled as hosted
failures here.

See [the investigation and failure/fix record](../../JIGJOY_HOSTED.md) and
[submission guide](../../SUBMISSION.md) for context and limitations.
