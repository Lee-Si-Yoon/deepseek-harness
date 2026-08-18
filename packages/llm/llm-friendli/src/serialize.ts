/**
 * Serialize harness messages into FriendliAI chat completions. User text is
 * joined; assistant text becomes `content`, tool calls become `tool_calls`,
 * and tool results become separate tool messages. Assistant reasoning is
 * replayed as `reasoning_content` only on tool-call turns, so an interleaved
 * reasoning model keeps its chain across a tool round trip. Core image blocks
 * are rejected explicitly because this wire route is text-only.
 *
 * FriendliAI's reasoning dialect is stated on every request: `parse_reasoning`
 * and `include_reasoning` are always `true` (deterministic reasoning parsing
 * into `reasoning_content`), the thinking toggle rides
 * `chat_template_kwargs.enable_thinking` for controllable reasoning models,
 * and the effort level maps to `reasoning_effort`.
 *
 * @module dsh-llm-friendli/serialize
 */

import { contentHasImage, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { WireMessage, WireRequest, WireTool } from './types.ts'

/** Adapter-level request defaults (from plugin config). */
export interface RequestDefaults {
  /** Deployment thinking lock; `disabled` forces `enable_thinking: false` on every request. */
  thinking?: 'enabled' | 'disabled' | undefined
  /** Default reasoning effort applied when a request names none. */
  reasoningEffort?: 'off' | 'low' | 'medium' | 'high' | 'max' | undefined
}

/** The FriendliAI reasoning fields one request carries. */
interface ResolvedThinking {
  /** `chat_template_kwargs.enable_thinking`; absent leaves the model default. */
  enableThinking?: boolean
  /** Wire `reasoning_effort`; only the model-supported levels, never `off`. */
  reasoningEffort?: 'low' | 'medium' | 'high' | 'max'
}

/** Validate the adapter-owned effort before resolving its FriendliAI wire fields. */
function reasoningEffort(
  effort: NonNullable<GenerateOptions['reasoningEffort']>,
): 'off' | 'low' | 'medium' | 'high' | 'max' {
  if (effort === 'off' || effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'max') {
    return effort as 'off' | 'low' | 'medium' | 'high' | 'max'
  }
  throw new LlmError(
    `FriendliAI does not support reasoning effort "${effort}"`,
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

/**
 * Resolve one legal thinking/effort pair. `off` toggles thinking off through
 * `enable_thinking: false` and never crosses the wire as `reasoning_effort`;
 * a level enables thinking and sends that level. A `session-title` request
 * forces thinking off to reserve its bounded output for visible title text.
 */
function resolveThinking(options: GenerateOptions, defaults: RequestDefaults): ResolvedThinking {
  if (options.purpose === 'session-title') return { enableThinking: false }
  const effort = options.reasoningEffort === undefined
    ? defaults.reasoningEffort
    : reasoningEffort(options.reasoningEffort)
  if (defaults.thinking === 'disabled' && effort !== undefined && effort !== 'off') {
    throw new LlmError(
      `FriendliAI deployment does not support reasoning effort "${effort}"`,
      'UNSUPPORTED_REASONING_EFFORT',
    )
  }
  if (effort === 'off') return { enableThinking: false }
  if (effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'max') {
    return { enableThinking: true, reasoningEffort: effort }
  }
  // No request or default effort: only a deployment thinking lock speaks here.
  return defaults.thinking === 'disabled' ? { enableThinking: false } : {}
}

/** Join the text blocks of a message (used for user/tool-result content). */
function flattenText(blocks: ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Reject core image content before any text-flattening path can silently erase it. */
function assertTextOnly(blocks: readonly ContentBlock[]): void {
  if (contentHasImage(blocks)) {
    throw new LlmError('The FriendliAI chat-completions adapter does not support image content.', 'UNSUPPORTED_CONTENT')
  }
}

/** Serialize one assistant message (text + reasoning + tool calls). */
function serializeAssistant(message: Message): WireMessage {
  const text = flattenText(message.content)
  const reasoning = message.content
    .filter(block => block.type === 'reasoning')
    .map(block => block.text)
    .join('')
  const toolCalls = message.content
    .filter(block => block.type === 'tool-call')
    .map(block => ({
      id: block.id,
      type: 'function' as const,
      function: { name: block.name, arguments: block.arguments },
    }))

  return {
    role: 'assistant',
    // Text-less turns send "" — never null. Pure tool-call turns replay
    // content verbatim (which is ""), and OpenAI-compatible gateways reject
    // null-content assistant messages, which would sit durably in the session
    // log and brick every later turn of the session.
    content: text,
    // Reasoning is passed back only on tool-call turns so an interleaved
    // reasoning model keeps its chain across a tool round trip; on plain
    // turns it is dropped to save tokens.
    ...toolCalls.length > 0 && reasoning.length > 0 ? { reasoning_content: reasoning } : {},
    ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
  }
}

/**
 * Serialize the conversation. `tool-result` blocks become standalone
 * `{role: 'tool'}` messages; the harness puts each tool result in its own
 * user-role message, so a mixed user message contributes its text first and
 * its tool results as separate wire messages after.
 * @param messages - the harness conversation, in order.
 * @returns the wire messages; order preserved, each tool result expanded into its own entry.
 */
export function serializeMessages(messages: Message[]): WireMessage[] {
  const wire: WireMessage[] = []
  for (const message of messages) {
    assertTextOnly(message.content)
    if (message.role === 'system') {
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      wire.push(serializeAssistant(message))
      continue
    }
    // user role: tool results ride in user messages in the harness
    // vocabulary, but FriendliAI wants them as role:'tool' messages.
    const toolResults = message.content.filter(block => block.type === 'tool-result')
    const text = flattenText(message.content)
    if (text.length > 0 || toolResults.length === 0) {
      wire.push({ role: 'user', content: text })
    }
    for (const result of toolResults) {
      wire.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        // Empty tool output still needs SOME content on the wire.
        content: flattenText(result.content) || '(no output)',
      })
    }
  }
  return wire
}

/**
 * Build the full wire request. Always streaming (`stream: true`, usage
 * reporting on) and always reasoning-parsing (`parse_reasoning: true`,
 * `include_reasoning: true`); optional fields are omitted rather than sent as
 * null, so provider defaults apply.
 * @param options - the harness request (model, history, system, tools, sampling).
 * @param defaults - adapter-level thinking defaults; undefined fields put nothing on the wire.
 * @returns the chat-completions request body.
 */
export function serializeRequest(
  options: GenerateOptions,
  defaults: RequestDefaults = {},
): WireRequest {
  const messages: WireMessage[] = []
  if (options.system !== undefined) {
    messages.push({ role: 'system', content: options.system })
  }
  messages.push(...serializeMessages(options.messages))

  const tools: WireTool[] | undefined = options.tools?.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
  const resolvedThinking = resolveThinking(options, defaults)

  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    // FriendliAI parses reasoning deterministically; naming both defends
    // against older endpoints whose parse_reasoning default is false.
    parse_reasoning: true,
    include_reasoning: true,
    ...resolvedThinking.enableThinking !== undefined
      ? { chat_template_kwargs: { enable_thinking: resolvedThinking.enableThinking } }
      : {},
    ...resolvedThinking.reasoningEffort !== undefined
      ? { reasoning_effort: resolvedThinking.reasoningEffort }
      : {},
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    ...options.temperature !== undefined ? { temperature: options.temperature } : {},
    ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
    ...options.stop !== undefined ? { stop: options.stop } : {},
  }
}
