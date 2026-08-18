import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  QUOTA_EXCEEDED_CODE,
  ReasoningEffortId,
  userAgent,
} from '@deepseek-ai/dsh-llm'
import * as LlmFriendli from '@deepseek-ai/dsh-llm-friendli'
import { FriendliAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-friendli'
import { httpErrorCode } from '../src/adapter.ts'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, reasoningEvents, textEvents } from './mock-server.ts'
import type { Behavior } from './mock-server.ts'

let testHome: string

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), 'dsh-llm-friendli-'))
  vi.stubEnv('DSH_HOME', testHome)
})

afterEach(async () => {
  await closeMockServers()
  vi.unstubAllEnvs()
  vi.useRealTimers()
  rmSync(testHome, { recursive: true, force: true })
})

async function harness(baseURL: string, config: object = {}) {
  // Configuration carries only the reference; the key comes from the
  // environment, which is the whole credential plane without a mounted seam.
  vi.stubEnv('FRIENDLI_API_KEY', 'test-key')
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmFriendli, { baseURL, ...config })
  return ctx
}

/** Direct adapter over the plugin's real resolve step, with a static key. */
function adapterOf(config: Partial<LlmFriendli.Config> & { apiKey?: string } = {}): FriendliAdapter {
  const { apiKey, ...rest } = config
  return new FriendliAdapter({
    options: () => resolveAdapterOptions(rest),
    resolveApiKey: () => Promise.resolve(apiKey ?? 'k'),
  })
}

const user = (text: string) => createUserMessage({
  content: [{ type: 'text', text }],
  source: { kind: 'plugin', plugin: 'test' },
})

describe('FriendliAdapter against a mock server', () => {
  it('streams a text generation end to end through the assembler', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const ctx = await harness(server.url)

    const result = await assemble(ctx, { model: 'zai-org/GLM-5.2', messages: [user('hi')] })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 1 })

    // Every request states the FriendliAI reasoning dialect and streams usage.
    expect(server.requests[0]).toMatchObject({
      model: 'zai-org/GLM-5.2',
      max_tokens: 32_768,
      stream: true,
      stream_options: { include_usage: true },
      parse_reasoning: true,
      include_reasoning: true,
    })
    expect(server.targets[0]).toEqual({ method: 'POST', url: '/chat/completions' })
    // App attribution is the whole header surface beyond auth/content/accept.
    expect(server.headers[0]?.['user-agent']).toBe(userAgent())
    expect(server.headers[0]?.authorization).toBe('Bearer test-key')
    expect(server.headers[0]).not.toHaveProperty('x-deepseek-harness-user-id')
  })

  it('streams raw chunks through ctx.llm.stream', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents, delayMs: 2 }])
    const ctx = await harness(server.url)

    const kinds: string[] = []
    for await (const chunk of ctx.llm.stream({
      provider: 'friendli',
      model: 'zai-org/GLM-5.2',
      messages: [user('hi')],
    })) {
      kinds.push(chunk.type)
    }
    expect(kinds).toEqual(['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
  })

  it('splits parsed reasoning from the answer and reports reasoning tokens', async () => {
    const server = await mockServer([{ kind: 'sse', events: reasoningEvents }])
    const ctx = await harness(server.url)

    const result = await assemble(ctx, { model: 'zai-org/GLM-5.2', messages: [user('2+2?')] })
    expect(result.message.content).toEqual([
      { type: 'reasoning', text: 'let me think' },
      { type: 'text', text: '42' },
    ])
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 3, reasoningTokens: 2 })
  })

  it('enables thinking and sends the effort for a low default', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const ctx = await harness(server.url, { thinking: 'enabled', reasoningEffort: 'low' })

    await assemble(ctx, { model: 'zai-org/GLM-5.2', messages: [user('hi')] })
    expect(server.requests[0]).toMatchObject({
      chat_template_kwargs: { enable_thinking: true },
      reasoning_effort: 'low',
    })
  })

  it('maps the off effort to enable_thinking:false and omits reasoning_effort', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const ctx = await harness(server.url)

    await assemble(ctx, {
      model: 'zai-org/GLM-5.2',
      messages: [user('hi')],
      reasoningEffort: ReasoningEffortId('off'),
    })
    expect(server.requests[0]).toMatchObject({ chat_template_kwargs: { enable_thinking: false } })
    expect(server.requests[0]).not.toHaveProperty('reasoning_effort')
  })

  it('forces thinking off for a session-title request', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const ctx = await harness(server.url, { thinking: 'enabled', reasoningEffort: 'high' })

    await assemble(ctx, { model: 'zai-org/GLM-5.2', messages: [user('hi')], purpose: 'session-title' })
    expect(server.requests[0]).toMatchObject({ chat_template_kwargs: { enable_thinking: false } })
    expect(server.requests[0]).not.toHaveProperty('reasoning_effort')
  })

  it('passes reasoning back only on tool-call assistant turns', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const adapter = adapterOf({ baseURL: server.url })
    const chunks = []
    for await (const chunk of adapter.stream({
      provider: 'friendli',
      model: 'zai-org/GLM-5.2',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'planning' },
            { type: 'tool-call', id: 'call_1' as never, name: 'ls', arguments: '{}' },
          ],
          source: { kind: 'model', provider: 'friendli', model: 'zai-org/GLM-5.2' },
        } as never,
        {
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: 'call_1' as never, content: [{ type: 'text', text: 'ok' }] }],
          source: { kind: 'plugin', plugin: 'test' },
        } as never,
      ],
    })) chunks.push(chunk)

    const assistant = (server.requests[0] as { messages: { role: string; reasoning_content?: string }[] }).messages[0]
    expect(assistant).toMatchObject({ role: 'assistant', content: '', reasoning_content: 'planning' })
  })
})

describe('reasoning effort validation', () => {
  it('rejects an unsupported effort before network I/O', async () => {
    const adapter = adapterOf()
    await expect((async () => {
      for await (const _ of adapter.stream({
        provider: 'friendli',
        model: 'zai-org/GLM-5.2',
        messages: [user('hi')],
        reasoningEffort: ReasoningEffortId('ludicrous'),
      })) { /* drain */ }
    })()).rejects.toThrow(/UNSUPPORTED_REASONING_EFFORT|does not support/)
  })

  it('rejects a thinking:disabled deployment configured with a non-off effort', () => {
    expect(() => resolveAdapterOptions({ thinking: 'disabled', reasoningEffort: 'high' }))
      .toThrow(/only reasoningEffort "off"/)
  })
})

describe('httpErrorCode', () => {
  it('maps FriendliAI 422 to INVALID_REQUEST', () => {
    expect(httpErrorCode(422)).toBe('INVALID_REQUEST')
  })
  it('maps auth, rate-limit, quota, context overflow, and server codes', () => {
    expect(httpErrorCode(401)).toBe('AUTH')
    expect(httpErrorCode(403)).toBe('AUTH')
    expect(httpErrorCode(429)).toBe('RATE_LIMIT')
    expect(httpErrorCode(429, { message: 'quota exceeded' })).toBe(QUOTA_EXCEEDED_CODE)
    expect(httpErrorCode(422, { message: 'reduce the length of the messages; context window exceeded' }))
      .toBe(CONTEXT_WINDOW_EXCEEDED_CODE)
    expect(httpErrorCode(500)).toBe('SERVER')
    expect(httpErrorCode(418)).toBe('HTTP_418')
  })
})

describe('error responses surface as coded LlmErrors', () => {
  const cases: { status: number; code: string }[] = [
    { status: 401, code: 'AUTH' },
    { status: 422, code: 'INVALID_REQUEST' },
    { status: 500, code: 'SERVER' },
  ]
  for (const { status, code } of cases) {
    it(`maps HTTP ${status} to ${code}`, async () => {
      const behavior: Behavior = { kind: 'http-error', status, body: JSON.stringify({ error: { message: 'nope' } }) }
      const server = await mockServer([behavior])
      const ctx = await harness(server.url)
      const result = await assemble(ctx, { model: 'zai-org/GLM-5.2', messages: [user('hi')] })
      // ctx.llm.stream normalizes an adapter throw into a terminal error finish.
      expect(result.finish).toMatchObject({ kind: 'error', failure: { code, status } })
    })
  }
})
