import { describe, expect, it } from 'vitest'
import { CallId, createAssistantMessage, createToolResultMessage, createUserMessage, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { serializeMessages, serializeRequest } from '../src/serialize.ts'

const text = (value: string): Message => createUserMessage({
  content: [{ type: 'text', text: value }],
  source: { kind: 'plugin', plugin: 'test' },
})

function req(partial: Partial<GenerateOptions>): GenerateOptions {
  return { provider: 'friendli', model: 'zai-org/GLM-5.2', messages: [], ...partial }
}

describe('serializeRequest', () => {
  it('always states the reasoning dialect and streams usage', () => {
    const body = serializeRequest(req({ messages: [text('hi')] }))
    expect(body).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
      parse_reasoning: true,
      include_reasoning: true,
    })
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('prepends the system slot and maps tools, temperature, maxTokens, and stop', () => {
    const body = serializeRequest(req({
      system: 'be brief',
      temperature: 0.2,
      maxTokens: 100,
      stop: ['STOP'],
      tools: [{ name: 'ls', description: 'list', parameters: { type: 'object' } }],
    }))
    expect(body.messages[0]).toEqual({ role: 'system', content: 'be brief' })
    expect(body.tools).toEqual([{ type: 'function', function: { name: 'ls', description: 'list', parameters: { type: 'object' } } }])
    expect(body).toMatchObject({ temperature: 0.2, max_tokens: 100, stop: ['STOP'] })
  })

  it('maps off to enable_thinking:false and a level to the wire effort', () => {
    expect(serializeRequest(req({ reasoningEffort: ReasoningEffortId('off') })))
      .toMatchObject({ chat_template_kwargs: { enable_thinking: false } })
    const high = serializeRequest(req({ reasoningEffort: ReasoningEffortId('high') }))
    expect(high).toMatchObject({ chat_template_kwargs: { enable_thinking: true }, reasoning_effort: 'high' })
    expect(serializeRequest(req({ reasoningEffort: ReasoningEffortId('off') }))).not.toHaveProperty('reasoning_effort')
  })

  it('applies the deployment default effort when the request names none', () => {
    expect(serializeRequest(req({}), { reasoningEffort: 'medium' }))
      .toMatchObject({ chat_template_kwargs: { enable_thinking: true }, reasoning_effort: 'medium' })
  })

  it('honors a thinking:disabled lock with no per-request effort', () => {
    expect(serializeRequest(req({}), { thinking: 'disabled' }))
      .toMatchObject({ chat_template_kwargs: { enable_thinking: false } })
  })

  it('rejects a non-off effort against a disabled deployment', () => {
    expect(() => serializeRequest(req({ reasoningEffort: ReasoningEffortId('high') }), { thinking: 'disabled' }))
      .toThrow(LlmError)
  })

  it('rejects an unsupported effort value', () => {
    expect(() => serializeRequest(req({ reasoningEffort: ReasoningEffortId('ludicrous') }))).toThrow(LlmError)
  })

  it('leaves the model default when no effort or lock speaks', () => {
    const body = serializeRequest(req({}))
    expect(body).not.toHaveProperty('chat_template_kwargs')
    expect(body).not.toHaveProperty('reasoning_effort')
  })
})

describe('serializeMessages', () => {
  it('emits tool results as standalone tool messages after the user text', () => {
    const messages: Message[] = [createUserMessage({
      content: [
        { type: 'text', text: 'go' },
        { type: 'tool-result', toolCallId: CallId('c1'), content: [{ type: 'text', text: 'done' }], isError: false },
      ],
      source: { kind: 'plugin', plugin: 'test' },
    })]
    expect(serializeMessages(messages)).toEqual([
      { role: 'user', content: 'go' },
      { role: 'tool', tool_call_id: 'c1', content: 'done' },
    ])
  })

  it('passes reasoning back only on tool-call assistant turns and sends "" content', () => {
    const withTool = createAssistantMessage({
      content: [
        { type: 'reasoning', text: 'plan' },
        { type: 'tool-call', id: CallId('c1'), name: 'ls', arguments: '{}' },
      ],
      source: { provider: 'friendli', model: 'zai-org/GLM-5.2' },
    })
    const plain = createAssistantMessage({
      content: [{ type: 'reasoning', text: 'plan' }, { type: 'text', text: 'answer' }],
      source: { provider: 'friendli', model: 'zai-org/GLM-5.2' },
    })
    expect(serializeMessages([withTool])[0]).toMatchObject({ role: 'assistant', content: '', reasoning_content: 'plan' })
    expect(serializeMessages([plain])[0]).not.toHaveProperty('reasoning_content')
  })

  it('substitutes (no output) for an empty tool result', () => {
    const messages: Message[] = [createToolResultMessage({ callId: CallId('c1'), content: [], isError: false })]
    expect(serializeMessages(messages)).toEqual([{ role: 'tool', tool_call_id: 'c1', content: '(no output)' }])
  })

  it('rejects image content on the text-only wire route', () => {
    const messages: Message[] = [createUserMessage({
      content: [{ type: 'image', image: { kind: 'reference', ref: 'x' } } as never],
      source: { kind: 'plugin', plugin: 'test' },
    })]
    expect(() => serializeMessages(messages)).toThrow(LlmError)
  })
})
