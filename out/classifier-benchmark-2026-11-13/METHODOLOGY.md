# Classifier benchmark — 2026-11-13

## Scope

Compare the currently configured classifier model `opencode-go/mimo-v2.6-flash` with `opencode-go/muse-spark-1.3-contributor` (the exact catalog ID corresponding to the requested Muse 1.3 Contributor). No production settings are changed.

Production anchors:
- `src/modules/classifier/index.ts`: SYSTEM prompt, `askClassifier`, typed validation, 900 output-token budget, 25-second irreversible-command gate, 30-second explicit classify tool deadline, safe threshold 0.5, four concurrent explicit classify slots.
- `src/core/llm.ts`: temperature 0, text extraction and errors.
- `src/core/tools.ts`: `clampText` state limit 12,000 characters and truncation marker.
- Live settings at measurement start: primary `opencode-go/mimo-v2.6-flash`; fallback `opencode-go/muse-spark-1.3-contributor:xhigh`.

## Execution

`benchmark.mjs` extracts the exact SYSTEM string from source and uses the built module's `normalizeAnswers`, `extractJson`, and `clampText`. It calls the installed runtime's native pi-ai adapters with normalized transcript context, a shared benchmark session ID, OpenCode session header, temperature 0, and 900 output tokens. An assertion verifies the system prompt is present in the actual API payload. Credentials are resolved locally, never written into outputs.

MiMo uses OpenAI Completions; Muse uses OpenAI Responses, as declared by the installed provider catalog. These are each model's native production transports, not an artificial common endpoint. No fallback to another model occurs within a measured request. Adapter retries, if any, remain included in elapsed time and are counted by the fetch wrapper.

- Main: 27 deterministic synthetic cases × 2 repeats × 2 models = 108 calls.
- Order alternates A/B and B/A by case and repeat; requests are serial, with no self-created model-call contention.
- xhigh: 12 supplemental Muse calls spanning all question types and all context sizes, representing the currently configured fallback effort. This smaller, later sample is descriptive, not a balanced head-to-head comparison.
- Optional minimal: one pass of all 27 cases with Muse `minimal`, to test whether an explicit low reasoning budget improves interactive latency. This is a later, unpaired tuning experiment, not equivalent evidence to the repeated main comparison.
- Pilot rows are excluded from all final statistics. Early pilot runs caught and fixed a transcript-normalization error; only subsequent main and named supplemental phases are eligible.

## Cases and scoring

27 distinct inputs: 10 command-safety judgments, 8 intent/route choices, 6 incident severity scores, and 3 batched requests with 3 questions each. Batches contain approximately 0, 4,000, and 11,000 characters of irrelevant log text before the decision state. English and Vietnamese, destructive/reversible actions, quoted commands, and untrusted prompt-injection text are included. Full inputs and expected answers are in `cases.json`, defined before the main run.

Safety is correct if probability >= 0.5 matches the expected boolean. Choice must equal the exact supplied key. Severity must equal the exact integer index. A whole request is correct only if schema validation succeeds and every expected question is correct. The main sample has 66 expected question answers per model (54 requests, including 6 three-question batches).

This is a small synthetic regression set, not a broad intelligence benchmark or a certified safety evaluation. It does not establish real-world calibration. Brier score on the safety subset, if reported, is descriptive only. Two repeats estimate short-run variability but not day-to-day provider variation.

## Timing and failure semantics

- Total latency: monotonic wall time from before adapter stream creation until its stream ends or fails, including parsing/validation afterward only negligibly (the recorded timer stops before normalization).
- TTFT: time to the first visible text delta, not the first hidden reasoning token or HTTP byte. `firstEvent` separately records the first text/thinking delta.
- A 25-second request deadline matches the destructive-command gate, not the explicit classify tool's 30-second deadline.
- Deadline errors are service failures under this tested SLO, not necessarily evidence that the model could never finish. Their actual completion latency is right-censored. Percentiles including failed/capped calls describe observed wait, not uncapped model generation time.
- Successful-only latency excludes timeouts and must not conceal their count. A fast successful-only median does not imply good availability.
- Schema errors, incorrect valid answers, token-limit stops, and deadline/network errors must be distinguished in the report. The 900-token budget can be consumed by hidden reasoning, especially xhigh. Such failures are production-budget failures, not necessarily knowledge errors.
- Rates under 5s / 10s count schema-valid responses; the accuracy metrics separately indicate whether those responses were correct.
- No throughput/concurrency benchmark is claimed. Tokens/second is not the primary metric because these JSON answers are short and TTFT/hidden reasoning dominate.

## Reproduce

From the repository root, with the existing OpenCode credential and installed DSH runtime:

```sh
node out/classifier-benchmark-2026-11-13/benchmark.mjs main
node out/classifier-benchmark-2026-11-13/benchmark.mjs minimal
node out/classifier-benchmark-2026-11-13/analyze.mjs
```

`main` also runs the xhigh supplement. Results append to `results.jsonl`; use a fresh output directory or archive the existing output before repeating, otherwise duplicate samples would be counted. The absolute pi-ai import path in the harness is specific to this installation; adjust it when reproducing elsewhere. Provider prices used by the SDK are catalog estimates, not invoices or measured subscription billing.

## Verification

- Benchmark scripts checked with `node --check`.
- Existing classifier regression tests: `npx vitest run test/classifier.test.ts` — 77/77 passed.
- Independent read-only methodology review and one delta recheck: clean after prompt normalization, exact score matching, production clamp, and API assertion fixes. Review explicitly requires separating budget/deadline failures from semantic errors.
