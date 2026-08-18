# @deepseek-ai/dsh-llm-friendli

English | [中文](README.zh.md)

FriendliAI serverless chat-completions adapter for the harness LLM seam: direct `fetch` + SSE (framed by `eventsource-parser`) translating FriendliAI's OpenAI-compatible wire format — with its deterministic reasoning parsing (source of truth: the [reasoning guide](https://friendli.ai/docs/guides/reasoning) and the [chat-completions OpenAPI schema](https://friendli.ai/docs/openapi/model-apis/chat-completions.md)) — into the `StreamChunk` protocol.

This package owns the `friendli` provider route. It mirrors `@deepseek-ai/dsh-llm-deepseek`: a transport-only adapter over connection facts resolved once per operation, with the registering plugin owning validation, layering, and credential policy. Registering another adapter for `friendli` throws `LlmError('DUPLICATE_ADAPTER')`.

The package root exposes the Cordis plugin contract and `FriendliAdapter`; wire serialization, SSE parsing, chunk translation, and model discovery helpers are not part of that root contract.

## Config

```yaml
- id: llm-friendli
  name: '@deepseek-ai/dsh-llm-friendli'
  config:
    apiKeyEnv: FRIENDLI_API_KEY  # default; resolved per request via ctx.credentials, then the environment
    baseURL: https://api.friendli.ai/serverless/v1 # optional; $FRIENDLI_BASE_URL then the public serverless API
    thinking: enabled        # optional; provider/model default when omitted
    reasoningEffort: high    # optional; off | low | medium | high | max
    maxTokens: 32768         # optional positive per-request output cap; this is the default
    streamIdleTimeoutMs: 300000 # optional; positive finite Node timer delay; five-minute default
    retryPolicy:             # optional; omission uses bounded normal defaults
      mode: always           # normal | always
      backoff:
        initialDelayMs: 500
        maxDelayMs: 10000
        jitterRatio: 0.1
    defaultContextWindow: 131072 # optional positive-integer fallback; this is the default
    models:                  # optional; defaults to a snapshot of the serverless catalog
      - id: zai-org/GLM-5.2
        name: GLM-5.2
        contextWindow: 1048576
      - id: deepseek-ai/DeepSeek-V3.2
        contextWindow: 163840
```

The plugin registers the single provider route `friendli` together with its resolved `retryPolicy`. A request selects it with `provider: friendli`; its `model` is passed through as the wire `model` string (FriendliAI model ids carry their vendor prefix, e.g. `zai-org/GLM-5.2`), so changing models does not require lifecycle-time registration. Omitting `models` advertises a snapshot of the serverless catalog; an explicit list replaces those defaults, while `models: []` advertises none. Catalog entries are exposed through `ctx.llm.listModels('friendli')` for clients such as ACP editors and the Web selector, but remain advisory: unlisted model ids still pass through unchanged. An omitted entry name defaults to its id.

`contextWindow` is optional per configured model. `ctx.llm.resolveModelInfo('friendli', model).context` returns an exact model value first, then `defaultContextWindow` for an entry without capacity or an unlisted pass-through id. The adapter default is 131,072 — a conservative floor across the serverless catalog, whose flagship models range far higher, so deployments pinning a large-context model should size it explicitly.

`maxTokens` is the adapter-configured output cap for conversation requests and defaults to 32,768. A catalog entry may carry its own `maxTokens`, which wins for that model; an entry without one, and any unlisted pass-through id, resolve to the profile value. Exact-model resolution exposes the winner as `defaultMaxTokens`; `LlmRuntime` materializes that value into `GenerateOptions.maxTokens` before the agent loop writes `request/header`, so the wire request remains reconstructable. An explicit request or `AgentOptions.maxTokens` value wins and is serialized as `max_tokens`. The adapter does not clamp this request budget against `contextWindow`.

## Reasoning

FriendliAI performs **model-agnostic reasoning parsing**: rather than leaving the chain of thought wrapped in `<think>` tags inside `content`, it separates reasoning into `reasoning_content`. This adapter always states that dialect — every request sends `parse_reasoning: true` and `include_reasoning: true` — because older endpoints default `parse_reasoning` to `false` and the [reasoning guide](https://friendli.ai/docs/guides/reasoning) recommends naming it. Parsed reasoning tokens stream as `delta.reasoning_content` and become harness `reasoning` blocks; answer tokens stream as `delta.content` and become `text` blocks.

Thinking is controlled separately from parsing. For controllable reasoning models (e.g. `zai-org/GLM-5.2`), the toggle rides `chat_template_kwargs.enable_thinking`; the effort level maps to the top-level `reasoning_effort`. The adapter-owned `off` effort sends `chat_template_kwargs.enable_thinking: false` and never crosses the wire as `reasoning_effort: 'off'`; `low`, `medium`, `high`, and `max` enable thinking and serialize the matching `reasoning_effort`. An unsupported value fails with `UNSUPPORTED_REASONING_EFFORT` before network I/O. Always-reasoning models ignore the toggle and reason regardless; the adapter still parses their `reasoning_content` identically.

`thinking: disabled` is a deployment lock that publishes only `off` with `off` as its default; configuring `low`/`medium`/`high`/`max` beside it fails plugin loading, and a direct per-request attempt to enable thinking fails before network I/O. A request with `GenerateOptions.purpose: 'session-title'` also forces thinking off, reserving its bounded output for visible title text without changing conversation or compaction defaults. Reasoning is passed back as `reasoning_content` only on assistant turns that carried tool calls (so an interleaved-reasoning model keeps its chain across a tool round trip) and dropped on tool-call-free turns to save tokens.

`reasoningEffort` selects the deployment default; exact-model resolution exposes ordered `off`, `low`, `medium`, `high`, and `max` efforts under `reasoning` for every pass-through model when deployment policy permits thinking. A catalog entry may set `reasoning: false` to publish `off` only for a non-reasoning model. `agent/request` can replace the effort on each conversation step; the resolved value is logged in `request/header`.

## Model discovery

The plugin registers a model-discovery handler for the `llm-friendli` settings namespace. A configuration surface interrogates the serverless `GET {baseURL}/models` listing, which discloses `context_length` and `max_completion_tokens`, so an adopted model arrives sized rather than guessed. A model carrying a `deprecation_date` is skipped: a listing membership is not a grant of access — account, permission, and deprecation each decide whether a request to that model actually succeeds. Discovery stores nothing; the reply is candidate metadata the surface offers for adoption, and the settings document remains the only thing that decides what the route serves.

## Dynamic configuration (settings + credentials)

Connection facts are not frozen at load. `resolveAdapterOptions` is the one explicit resolve step from raw config to validated facts, and the adapter re-reads them through a thunk **once per operation**: base URL, catalog, request defaults, and idle budget all take effect on the next request, while an in-flight stream keeps the facts it started with. Two optional seams feed that thunk:

- **`ctx.settings`** — the plugin registers the `llm-friendli` namespace with this same `Config` schema and its `cordis.yml` entry as the composition `base`, so a `llm-friendli:` section in the user settings document overrides any field without a restart. Without a mounted settings service the entry config alone drives the adapter. A live settings snapshot that passes the schema but fails a beyond-schema bound (a duplicate catalog id, a broken thinking/effort pair) keeps the last good facts and logs the failure; the entry config itself still fails plugin load.
- **`ctx.credentials`** — the API key resolves per stream call, from the *same* resolved snapshot that supplies the endpoint. Configuration carries only `apiKeyEnv`, never a literal key. Because credential facts travel with the connection facts, a settings snapshot the resolver rejects contributes neither its endpoint nor its key. Every resolved key is format-checked before use, so a value no HTTP header can carry is refused with `LlmError('INVALID_CREDENTIAL')` naming the failing entry point — never any part of the key. A request with no key anywhere fails with `MISSING_CREDENTIAL` naming every configuration entry point, while the route stays registered and the catalog stays browsable — first-run onboarding is "browse models, store the key, prompt again", with no restart between.

The one registration-captured fact is the retry policy: when its resolved value changes, the plugin re-registers the route in place (same adapter instance, one synchronous section), so `ctx.llm.providerRetryPolicy('friendli')` always reports the current policy.

The plugin also declares its route in the configurable-provider directory (`ctx.llm.listConfigurableProviders()`): provider `friendli`, settings namespace `llm-friendli`, empty settings path — the whole section is the profile.

## App attribution

Every request carries the shared attribution header from dsh-llm's `attributionHeaders()` — the mandatory `User-Agent` baseline identifying the harness (see [dsh-llm § App attribution](../llm/README.md#app-attribution-attributionts)). This adapter adds no provider-specific app-attribution or request-identity headers; the bearer token and the shared `User-Agent` are the whole header surface beyond content type and accept, sent to the resolved `baseURL` including a configured gateway.

## Wire-format notes

- Streaming only (`stream_options.include_usage` always on). `usage` may arrive attached to the finish chunk or as a trailing usage-only chunk — the translator defers both to `[DONE]`, so `usage` always precedes `finish` and nothing follows `finish`.
- `parse_reasoning: true` and `include_reasoning: true` are always sent, so reasoning arrives split into `reasoning_content` rather than inline `<think>` tags.
- The adapter-owned `off` effort maps to `chat_template_kwargs.enable_thinking: false` and never crosses the wire as `reasoning_effort: 'off'`.
- The first reasoning chunk may carry `reasoning_content: ""` — handled (no spurious reasoning block).
- **Reasoning passback rule**: on assistant turns that carried tool calls, `reasoning_content` is serialized back in history; on tool-call-free turns it is dropped.
- Cache accounting: `cacheReadTokens` ← `prompt_tokens_details.cached_tokens`; FriendliAI reports no cache-write metric.

## Errors

Non-2xx responses throw `LlmError` with stable codes: `AUTH` (401/403), `QUOTA` (a response whose provider details identify exhausted quota, balance, or credits), `RATE_LIMIT` (other 429s), `CONTEXT_WINDOW_EXCEEDED` (a 400/422 whose provider code, type, or message identifies context overflow), `INVALID_REQUEST` (other 400s and 422s — FriendliAI answers a rejected request with `422 Unprocessable Entity` where OpenAI answers 400), `SERVER` (5xx), `HTTP_<status>` otherwise. Its serializable `failure` retains the HTTP status plus a valid positive `Retry-After` seconds/date delay and `x-request-id` when present. A pre-response transport failure (DNS, refused connection, TLS, proxy) throws `TRANSPORT` naming the configured endpoint and chaining the original rejection as `cause`; caller aborts throw `ABORTED`. Protocol violations throw `STREAM_CLOSED` (no `[DONE]`) or `MALFORMED_RESPONSE` (bad JSON payload). Unknown wire `finish_reason`s become `finish {kind: 'error', failure}` chunks, and a completed stream whose `stop` (or absent) finish opened no content blocks becomes a `finish {kind: 'error'}` with code `EMPTY_RESPONSE` (retried by default policy).

## Model Experience

### FriendliAI request

#### What the model sees

The selected FriendliAI model receives the harness system prompt, message history, tool schemas, stop sequences, and call config without adapter-authored prompt prose. On a prior assistant turn with tool calls, its reasoning content is passed back as `reasoning_content`; reasoning from tool-call-free turns is omitted.

#### Token effect

Provider tokenization governs exact input. Conditional reasoning passback increases tool-round-trip context, while dropping other reasoning avoids paying those tokens again; cache-read usage is reported when available.

#### KV Cache effect

An unchanged assembled prefix is eligible for FriendliAI prompt-cache reuse, which this adapter reports in usage. A model-route change or any upstream prompt, schema, prefix, or history change may prevent reuse from the first changed token; reasoning passback appends during tool round trips.

### FriendliAI response

#### What the model sees

Parsed reasoning, answer text, and raw-string tool arguments are translated into harness chunks for the loop to log and assemble.

#### Token effect

Generated tokens follow the request's logged reasoning effort and `maxTokens`; only loop-retained blocks affect later input. Reasoning tokens, when the provider reports them, count as a subset of output.

#### KV Cache effect

Loop-retained response blocks append to the next request and preserve its earlier reusable prefix; dropped blocks have no later cache effect. Changing the provider or model selects a different cache domain.

## Known Limitations and Deferred Work

- **A settings `models` list replaces the composition list wholesale** — settings-layer merging is per-field, and arrays are one field; per-entry catalog merging would need a keyed shape.
- **Reasoning effort levels are a fixed `off`/`low`/`medium`/`high`/`max` set** — the FriendliAI schema also accepts `minimal`/`xhigh`/`ultracode`, and which levels a model honors varies; the published set is the cross-catalog common denominator, and an unlisted request value still passes through to the endpoint, which is authoritative.
- **`tool_choice` and structured-output (`response_format`) are not mapped** — not part of the core vocabulary (shared cut with the DeepSeek and pi-ai adapters); FriendliAI additionally rejects `response_format` combined with `tools`.
- **Requests use raw `fetch`, not `@cordisjs/plugin-http`** — no shared proxy/interception configuration; adoption is deferred until a second adapter wants it (`TODO(http)`).
- **Serialization flattens user and tool-result content to text blocks** — plugin-added block types are skipped, and empty tool output crosses the wire as the literal `(no output)`.
