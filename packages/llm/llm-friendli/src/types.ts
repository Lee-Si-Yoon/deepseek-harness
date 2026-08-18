/**
 * FriendliAI serverless chat-completions wire format (OpenAI-compatible, with
 * FriendliAI's reasoning extensions). Types only.
 *
 * Source of truth: the OpenAPI schema at
 * `https://friendli.ai/docs/openapi/model-apis/chat-completions.md` and the
 * reasoning guide at `https://friendli.ai/docs/guides/reasoning`, cross-checked
 * against a live `/serverless/v1/models` listing (2026-08).
 *
 * @module dsh-llm-friendli/types
 */

/**
 * Request body for `POST {baseURL}/chat/completions`.
 *
 * FriendliAI parses model reasoning deterministically instead of leaving it
 * wrapped in `<think>` tags, so `parse_reasoning`/`include_reasoning` are the
 * one dialect fact this adapter always states — the reasoning guide recommends
 * naming them because older endpoints default `parse_reasoning` to `false`.
 * The thinking toggle rides `chat_template_kwargs.enable_thinking` (controllable
 * reasoning models such as GLM-5.2), separate from the effort level.
 */
export interface WireRequest {
  model: string
  messages: WireMessage[]
  stream: true
  stream_options: { include_usage: true }
  /**
   * Always `true`: FriendliAI separates reasoning into `reasoning_content`
   * rather than inlining `<think>` tags. Naming it defends against older
   * endpoints whose default is `false` (see the reasoning guide).
   */
  parse_reasoning: true
  /** Always `true`: keep the parsed reasoning in the response so the harness can show it. */
  include_reasoning: true
  /** Template renderer kwargs; the thinking toggle for controllable reasoning models. */
  chat_template_kwargs?: { enable_thinking: boolean }
  /** Reasoning effort; the available levels depend on the model. */
  reasoning_effort?: 'low' | 'medium' | 'high' | 'max'
  tools?: WireTool[]
  temperature?: number
  max_tokens?: number
  /**
   * Stop sequences (OpenAI `stop`): generation halts as soon as the model
   * produces any one of these strings. Mapped from `GenerateOptions.stop`.
   */
  stop?: string[]
}

/** System-role message: a single string of instructions. */
export interface WireSystemMessage {
  role: 'system'
  content: string
}

/** User-role message: a single string of user input. */
export interface WireUserMessage {
  role: 'user'
  content: string
}

/** Tool-role message: the result of one tool call, keyed by its call id. */
export interface WireToolMessage {
  role: 'tool'
  tool_call_id: string
  content: string
}

/** One entry of the request `messages` array, discriminated on `role`. */
export type WireMessage =
  | WireSystemMessage
  | WireUserMessage
  | WireAssistantMessage
  | WireToolMessage

/**
 * Assistant-role history message. The harness replays `content: ""` (never
 * null) on tool-call-only turns — some OpenAI-compatible gateways reject null
 * outright — and reasoning is passed back only on tool-call turns.
 */
export interface WireAssistantMessage {
  role: 'assistant'
  content: string
  /**
   * Parsed reasoning replayed on assistant turns that carried tool calls, so
   * an interleaved-reasoning model keeps its chain across a tool round trip;
   * dropped on tool-call-free turns to save tokens.
   */
  reasoning_content?: string
  tool_calls?: WireToolCall[]
}

/** A completed tool call replayed on an assistant history message; `arguments` is the raw JSON string. */
export interface WireToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** One entry of the request `tools` array; `parameters` is a JSON Schema object. */
export interface WireTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/** One parsed SSE `data:` payload (a chat.completion.chunk). */
export interface WireChunk {
  choices?: WireChoice[]
  /** Arrives attached to the finish chunk and/or as a trailing usage-only chunk. */
  usage?: WireUsage | null
}

/** One streamed choice (requests always ask for a single one); `finish_reason` is non-null only on its terminal chunk. */
export interface WireChoice {
  delta?: WireDelta
  finish_reason?: string | null
}

/** The incremental content of one streamed choice; any subset of fields may be present per chunk. */
export interface WireDelta {
  role?: string
  /** Visible answer text. Null/empty on reasoning/tool-call chunks. */
  content?: string | null
  /**
   * Parsed reasoning tokens (`parse_reasoning: true`). Absent when the model
   * did not reason or reasoning parsing is off.
   */
  reasoning_content?: string | null
  tool_calls?: WireToolCallDelta[]
}

/** A streamed fragment of one tool call; fragments sharing an `index` concatenate into one call. */
export interface WireToolCallDelta {
  /** Disambiguates parallel tool calls; stable across a call's deltas. */
  index: number
  /** Present on the first delta of each call only. */
  id?: string
  type?: 'function'
  function?: {
    /** Present on the first delta of each call only. */
    name?: string
    /** Argument JSON fragment (concatenate across deltas). */
    arguments?: string
  }
}

/**
 * Wire token accounting (OpenAI-compatible). `prompt_tokens` INCLUDES cache
 * hits; `mapUsage` subtracts `prompt_tokens_details.cached_tokens` to keep the
 * harness convention of disjoint counts. Reasoning tokens, when reported, are
 * a subset of `completion_tokens`.
 */
export interface WireUsage {
  prompt_tokens: number
  completion_tokens: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

/** Non-2xx error body. */
export interface WireError {
  error?: { message?: string; type?: string; code?: string }
}

/**
 * One entry of the `GET {baseURL}/models` listing. Only the fields this
 * adapter reads are typed; the endpoint returns more per model (pricing,
 * functionality, reasoning options) that discovery does not need.
 */
export interface WireModelListingEntry {
  id?: unknown
  name?: unknown
  context_length?: unknown
  max_completion_tokens?: unknown
  /** Present only on a model scheduled for or past removal; discovery skips it. */
  deprecation_date?: unknown
}
