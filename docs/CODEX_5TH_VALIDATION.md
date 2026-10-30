> Historical development record. Current submission results and setup are in the [JigJoy hosted validation](JIGJOY_HOSTED.md) and [submission guide](SUBMISSION.md). Earlier test counts and Gemini quota blockers below do not describe the current submission.

# codex_5th autonomous engineering validation

Initial validation on 2026-10-30; revalidated on 2026-10-31 KST. Windows, Node v22.14.0, npm 10.9.2. This report replaces the initial missing-credential report.

## 1. Final status

Four real provider-backed Factory runs reached COMPLETED: Sum CLI, Notes HTTP API, and two new temporary CLI specifications. All used the real pinned Mozaik runtime and Gemini inference, with no demo flags. Their generated artifacts passed deterministic verification and 54 additional independent acceptance cases in total.

**Final-source fresh Sum rerun remains BLOCKED by external provider availability/quota.** The successful Sum run predates later Factory refinements. The successful live runs listed below are observed session evidence, not a claim that all four were rerun from the final source revision. Final source typecheck, build and 66 regression tests passed. The previously completed Sum delivery was independently exercised again after those checks and its artifact hashes remain unchanged.

## 2. Root causes and fixes

1. Credentials were initially absent. The user supplied ../.env; it was copied to the ignored repository .env so the existing CLI loader could read it. No credential value was printed or committed.
2. Transient quota failures were retried immediately by restarting whole turns. Retries now honor Retry-After headers, Google RPC RetryInfo and retry-delay text, use bounded backoff when no hint exists, share a per-model cooldown, and retry the identical request context. Completed tools and Gemini thought signatures survive; permanent HTTP 4xx errors do not retry. Exhausted request retries do not receive another turn-level budget.
3. Isolated worker snapshots lacked other workers' unfinished files. Incomplete checks now explicitly defer with passed:false, rather than encouraging stubs or interface changes. Local tests build complete snapshots first. finish_work checks every owned artifact and forwards the worker's validated summary through Mozaik, then independent review and CI still determine completion. This deterministic handoff is excluded from provider/token accounting.
4. Generated HTTP QA initially covered imports but missed a broken Windows direct-execution guard. HTTP CI now has a fourth mandatory gate: start node dist/index.js with PORT and require an actual HTTP response, with no product route hardcoding. Planning, workers and review receive execution-environment guidance for portable ESM guards.
5. Review revisions and CI repair attempts shared a counter, prematurely exhausting a new bug ticket. reviewRetryCount, ciRetryCount and artifact retryCount now have distinct purposes and bounded budgets. New bugs begin with their own review allowance.
6. Reviewer treated old CI failures as current results and lacked collaborating module implementations. Review now receives accepted dependencyArtifacts and actual candidateChecks collected after the latest write. Later writes clear stale checks. Old CI appears separately as previousVerification; verification is current failed evidence only during triage.
7. An otherwise schema-valid Reviewer verdict could assign another owner's file and terminate the run. Reviewer decisions now receive bounded semantic repair with the same ownership/decision validators, rejected verdict and exact error. Invalid verdicts never enter accepted review history. Exhaustion remains explicit; no ownership or contract validator was weakened.
8. Independent JSON checks exposed both a generated dictionary bug and a misleading QA expected value for __proto__. General developer/QA guidance now preserves arbitrary user keys as data, uses strict assertions and actual own-property checks, and constructs special expected keys correctly. The corrected Factory-generated project passed primitive and object-valued special-key cases. No generated production file or generated test was manually patched.

## 3. Changed files

Production/runtime:

- src/factory/company.ts
- src/participants/prompts.ts
- src/runtime/inference.ts
- src/runtime/provider-errors.ts (new)
- src/schemas.ts (ticket counter types only; original Zod/contract/plan validators retained)
- src/state.ts
- src/tools/agent-tools.ts
- src/tools/commands.ts
- src/tools/http-startup.ts (new)

Regression tests:

- tests/factory.test.ts
- tests/tools.test.ts
- tests/provider-retry.test.ts (new)
- tests/http-startup.test.ts (new)

Documentation: README.md, docs/VALIDATION.md and this file. Package versions, lockfile, existing Mozaik signature patch and dependency bundles were not modified. No commit or push was made.

Ignored local evidence/specifications are under .work/codex-5th-validation/. The private .env copy remains ignored.

## 4. Deterministic validation

| Command | Final result |
| --- | --- |
| npm run typecheck | Passed, exit 0 |
| npm run build | Passed, exit 0 |
| npm test | 66 passed, 0 failed, 0 skipped, exit 0 |

Baseline was 54 tests; 12 regression cases were added. Existing concurrency, planning, schema, signature/privacy, filesystem and artifact-integrity regressions remain passing. New cases cover retry timing/context/cancellation, explicit submission and accounting, partial snapshots, HTTP startup plus real automated repair, independent repair budgets, current-versus-previous review evidence, and Reviewer semantic repair/exhaustion.

Final complete terminal logs: typecheck-final.log, build-final.log and test-final.log in the ignored evidence directory. Machine-readable exit codes: deterministic-final.json.

## 5-8. Live bundled and unseen task results

| Task | Observed live status | CI attempts | Generated QA tests in final CI | Independent cases | Models |
| --- | --- | --- | --- | --- | --- |
| sum-cli | COMPLETED | 1 | 4 | 15 | gemini-3.5-flash-lite |
| notes-api | COMPLETED | 2 | 3 | 16 | gemini-3.5-flash-lite |
| text-stats | COMPLETED | 1 | 8 | 9 | gemini-3.5-flash-lite |
| json-select | COMPLETED | 1 | 5 | 14 | gemini-3.5-flash-lite |

Notes API's first integrated candidate failed actual TypeScript compilation; Reviewer triaged BUG-001 to Developer B, the worker repaired it, Reviewer approved it, and the second CI passed all four gates. This is actual live recovery evidence, not scripted inference. Other earlier failed/interrupted traces remain available and are not presented as successes.

The two unseen specifications were created after the bundled examples had produced live runs:

- .work/codex-5th-validation/specs/text-stats.md: Unicode code-point/word counting, empty/whitespace input and CLI errors.
- .work/codex-5th-validation/specs/json-select.md: own-property selection, preserved values, duplicates/missing keys, special keys and malformed/non-object JSON.

Developer A, Developer B and initial QA intervals overlap in every listed successful trace; this is also asserted by the independent evidence script. Each role retains meaningful work. QA derives initial tests from contract/interfaces in its isolated snapshot. Reviewer remains read-only. Completion requires actual integrated commands, not a model's summary.

- **sum-cli**: [delivery](../output/2026-10-30T13-08-52-754Z-246b70d9/FACTORY.md), [verification](../output/2026-10-30T13-08-52-754Z-246b70d9/factory-verification.json), [trace](../traces/2026-10-30T13-08-52-754Z-246b70d9/events.jsonl). Run 2026-10-30T13-08-52-754Z-246b70d9; 133.99 seconds.
- **notes-api**: [delivery](../output/2026-10-30T13-26-18-235Z-1f6b75d2/FACTORY.md), [verification](../output/2026-10-30T13-26-18-235Z-1f6b75d2/factory-verification.json), [trace](../traces/2026-10-30T13-26-18-235Z-1f6b75d2/events.jsonl). Run 2026-10-30T13-26-18-235Z-1f6b75d2; 121.42 seconds.
- **text-stats**: [delivery](../output/2026-10-30T13-34-24-477Z-37610d41/FACTORY.md), [verification](../output/2026-10-30T13-34-24-477Z-37610d41/factory-verification.json), [trace](../traces/2026-10-30T13-34-24-477Z-37610d41/events.jsonl). Run 2026-10-30T13-34-24-477Z-37610d41; 111.06 seconds.
- **json-select**: [delivery](../output/2026-10-30T13-42-01-372Z-a676ab3d/FACTORY.md), [verification](../output/2026-10-30T13-42-01-372Z-a676ab3d/factory-verification.json), [trace](../traces/2026-10-30T13-42-01-372Z-a676ab3d/events.jsonl). Run 2026-10-30T13-42-01-372Z-a676ab3d; 69.20 seconds.

## 9. Remaining limitations and final rerun blocker

The final Sum repeat exhausted the configured Flash Lite model's free daily allowance. Alternative supported Gemini models were tried using per-process overrides only; saved .env model settings were preserved.

- gemini-3.5-flash-lite: Daily free-tier request quota 500 exhausted; RetryInfo about 17 hours. Trace: traces/2026-10-30T13-43-32-261Z-0063d760/.
- gemini-3.5-flash: Provider reported gemini-3.6-flash daily request quota 20 exhausted. Trace: traces/2026-10-30T13-47-32-948Z-b8f69eb9/.
- gemini-3.1-pro-preview (mixed-role attempt): Pro free-tier request/token quotas are 0; blocked at PM. Trace: traces/2026-10-30T13-52-44-747Z-c7248ed7/.
- gemini-3.8-flash: PM request produced no response within 120 seconds; attempt interrupted after timeout/retry. Trace: traces/2026-10-30T13-53-20-761Z-205fc1ae/.

These attempts were interrupted rather than waiting beyond useful run deadlines; they are not COMPLETED runs. No Factory process remains running from this task. To repeat live generation with the configured model, the external Gemini quota must reset or the project's quota/billing must be changed by its owner. Provider messages at the time indicated about 17 hours until reset. No billing, quota or account access changes were performed.

Passing generated QA is not exhaustive semantic proof: independent checks found a real false pass before the JSON guidance improvement. Four recorded examples do not guarantee arbitrary-spec correctness. Scope remains small Node-only CLI/HTTP projects. Existing limits include no SDK request abort signal, no OS sandbox/crash resume, and first-call handling for batched tool outputs. Cost is null because pricing was not supplied; no price or cost was fabricated. Provider-reported token subsets are retained in evidence.

## 10. Human intervention and evidence integrity

The user supplied the credential configuration once. Factory repairs and generated artifacts required no manual source/test edits; successful runtime traces report humanInterventionCount=0. Factory source was changed by this engineering task as described above. The remaining fresh-run blocker is external quota/provider availability, not an unresolved deterministic test failure.

Artifact hashes for all 16 accepted source/test artifacts across the four successful deliveries match their recorded submissions. A static import audit found only relative imports and Node built-ins. See artifact-audit.json, per-task *-evidence.json and summary.json under .work/codex-5th-validation/. Full Factory terminal outputs for all attempts are retained there, along with traces/<run-id>/ evidence and output/<run-id>/ deliveries.

## 2026-10-31 resumption

The requested continuation was attempted with the saved source and configured provider. Typecheck and build passed; all 66 tests again passed with zero failures/skips. No production source, dependency, generated artifact or permanent model configuration changed in this continuation.

- Configured model attempt 2026-10-30T21-45-54-538Z-9ba73907: real PM, Tech Lead and concurrent worker stages ran, then HTTP 429 reported the same 500-request daily free-tier quota exhausted. This attempt was interrupted rather than waiting nine hours.
- The provider RetryInfo indicated reset at approximately Saturday, 31 October 2026 at 15:59:57 GMT+9 (calculated from that specific error response, not a guarantee of account availability). This Gemini quota is independent of the Codex five-hour usage window.
- Remaining supported fallback model attempt 2026-10-30T21-47-44-403Z-a90c1b0d: gemini-3.8-flash failed at PM after two bounded 30-second request timeouts. No COMPLETED status is claimed for either resumed attempt.
- Fresh final-source Sum validation remains externally blocked. Wait for the provider-indicated quota reset, or have the project owner increase available Gemini quota. Previous successful live runs and independent acceptance evidence above remain valid. No Factory process from these attempts remains running.

Current evidence: .work/codex-5th-validation/resume-oct31.json, test-resume-oct31.log, sum-cli-resume-oct31.log, sum-cli-resume-oct31-flash38.log, and the two traces cited above.
