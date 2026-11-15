# Configured-provider classifier benchmark, 2026-11-13

## Scope and inventory

Inspect the local TUI profile declarations in `/home/vietdo/.dsh/profiles/tui/cordis.patch.yml`, the installed pi-ai catalog, and locally resolvable credential references. Do not modify production model settings, authentication, or classifier implementation.

Four provider routes have resolvable API keys: `opencode-go`, `deepseek`, `zai`, and `router`. `commandcode` and `commandcode-anthropic` are declared, but `COMMAND_CODE_API_KEY` does not resolve in this process/DSH store. `openai-codex` is referenced by advisor settings, but no usable OAuth record was found in the inspected local DSH credential store; it is not claimed to be globally unconfigured or unusable in another running host.

This is not an exhaustive test of every catalog model. The candidate list targets Flash/Highspeed/Turbo/Haiku/Luna models, the current MiMo baseline, and the configured Jev router. Large Pro/Max models are not exhaustively benchmarked. Inventory and catalog descriptors are saved without credentials in `inventory.json`.

## Production fidelity

The harness extracts SYSTEM from the current `src/modules/classifier/index.ts`, saves it as `system-prompt.txt`, and uses built `normalizeAnswers`, `extractJson`, and `clampText`. State serialization, 12,000-character clamp including truncation marker, question formatting, temperature 0 where the native API supports it, and 900 output tokens match the module path. The SYSTEM is asserted on the actual outgoing payload.

Native installed adapters handle each model's declared API: Completions, Responses, or Anthropic Messages. `normalizeContext` materializes the system transcript correctly. OpenCode uses the required session header; a separate benchmark session ID is shared across the models within a run. No cross-model fallback occurs inside a measured request. Fetch attempts and native stop reasons are recorded. SDK retries, if any, are included in wall time.

For builtin finalist providers, declaration parity was explicitly checked: `opencode-go` and `deepseek` have no configured API/baseURL/compat/modelOverrides; the sole declared DeepSeek model has only its `id`. Installed catalog descriptors therefore match the declaration-level resolution for these finalists. This does not claim to boot or inspect every dynamic settings layer in the running host.

The custom `router/typesafe/jev-router` screening row uses the declared Completions API/base URL/context window, reasoning disabled by default and a 4096 descriptor output cap (the actual request is 900). Full custom-route host resolution was not reproduced; treat that route's screen as diagnostic, not a production end-to-end ranking. It is not in the balanced final cohort.

## Stages

1. **Screen:** six inputs per candidate: dirty-tree reset, safe generated build deletion, Vietnamese source edit, untrusted route injection, irreversible-data-loss severity, and a medium-log three-question batch. Candidate order rotates by case. Screening is for shortlist selection, not a broad accuracy proof.
2. **Final:** five finalists run on all 27 inputs, twice each, serial and cyclically interleaved by case/repeat. This gives 54 matched requests per finalist, with MiMo as a fresh baseline rather than reusing morning timings.
3. **Supplement:** ZAI Flash/Turbo were under-covered because initial provider-wide stop logic halted ZAI after two highspeed-model 429 plan denials. A separate later one-pass cohort checks the already-successful Flash model and the untested Turbo model, without retrying either denied highspeed model. This is a switch to different models, not retries of the inaccessible models. Plan denial is model-specific; supplemental logic disables that model immediately, while actual consecutive capacity/rate-limit errors disable the provider. Supplemental numbers are labeled separately, not pooled into the balanced final cohort.

The first screen declared 13 candidates but actually called 12 routes, for 57 requests: ZAI Flash succeeded once; two Highspeed variants each returned a model-plan-access 429; the provider-wide stop skipped the remaining ZAI cases and Turbo entirely. Do not label the Flash or Turbo model as inaccurate or unavailable based on that stop.

Finalist selection uses observed perfect screening decisions and latency plus provider diversity: Luna, Haiku, direct DeepSeek, MiniMax, and current MiMo. Qwen had a valid-but-wrong screen decision; OpenCode GLM had a timeout; slower router/proxy alternatives remain screening-only. This is a bounded selection, not proof all excluded models are dominated in every workload.

Two attempts to use the live `classify` tool for shortlist selection failed schema/timeout on its existing MiMo→Muse fallback chain. They are not included in measured cohorts. The measured screening evidence, not an unavailable classifier vote, determined the shortlist.

## Cases and scoring

The same 27 pre-defined synthetic cases from the morning benchmark are reused: 10 `noul`, 8 `choice`, 6 `score`, 3 batches with three questions each. English/Vietnamese, safety context, injection, quoted commands, and log lengths around 0/4000/11000 characters are covered. Cases and expected answers are saved before timing. Each complete 27-case pass expects 33 individual question answers; a 54-request finalist cohort expects 66.

Safety uses probability >=0.5; choice uses exact supplied key; score uses exact expected integer index. Production parser validation is mandatory. All questions must be correct for the whole request to count correct. Wrong-but-valid answers are distinguished from schema, budget, network, plan-access, and deadline errors. Confidence/calibration quality is NOT established; production validation permits missing optional confidence/probabilities. No false-allow in this small synthetic set is a safety certificate.

## Timing

Wall-clock latency includes native request/stream drain and failures; parsing afterward is negligible and occurs after the timer stops. TTFT is first visible text delta, not hidden reasoning or HTTP bytes. Requests abort at 25 seconds, matching the irreversible-command gate, whereas the public classify tool allows 30 seconds. Failed deadlines are right-censored; do not call a capped wait a completed response.

Successful-only timing must be reported alongside failure counts. Correct response rates under 2/5/10 seconds exclude quick API errors and incorrect answers. No throughput benchmark or broad intrinsic model speed/intelligence claim is made. Cache behavior, endpoint/transport, account plan, load and time of day are part of the observed route performance. Separate cohorts are not causal comparisons of provider tuning.

## Reproduction

From repository root with the existing local credentials and installed runtime:

```sh
node out/classifier-provider-benchmark-2026-11-13/benchmark.mjs inventory
node out/classifier-provider-benchmark-2026-11-13/benchmark.mjs screen
node out/classifier-provider-benchmark-2026-11-13/benchmark.mjs final opencode-go/gpt-6-luna opencode-go/claude-haiku-5-5 deepseek/deepseek-flash opencode-go/minimax-m3.1-flash opencode-go/mimo-v2.6-flash
node out/classifier-provider-benchmark-2026-11-13/benchmark.mjs supplement zai/glm-5.3-flash zai/glm-5-turbo
node out/classifier-provider-benchmark-2026-11-13/analyze.mjs final
node out/classifier-provider-benchmark-2026-11-13/analyze.mjs screen
node out/classifier-provider-benchmark-2026-11-13/analyze.mjs supplement
```

Results append. Use a fresh output directory/archive before rerunning the same phase, otherwise duplicate sample detection will fail. The installed-runtime absolute path is machine-specific. Catalog price/SDK cost, if inspected, is not a subscription invoice, and timeouts may omit usage.

## Review

An initial role reviewer failed before inspection; no approval is inferred from that failure. A fresh independent reviewer then checked the harness and classifier source. Its descriptor-parity concern was resolved with explicit checks of actual builtin finalist declarations; remaining points are reporting limitations recorded above. A final artifact/numeric check is performed after measurements finish.
