import { describe, expect, it } from 'vitest'
import { mapFinishReason, mapUsage, translate } from '../src/translate.ts'

async function* payloads(items: string[]): AsyncGenerator<string> {
  for (const item of items) yield item
}

async function collect(items: string[]) {
  const chunks = []
  for await (const chunk of translate(payloads(items))) chunks.push(chunk)
  return chunks
}

describe('mapFinishReason', () => {
  it('maps the known vocabulary', () => {
    expect(mapFinishReason('stop')).toEqual({ kind: 'stop' })
    expect(mapFinishReason('tool_calls')).toEqual({ kind: 'tool-calls' })
    expect(mapFinishReason('length')).toEqual({ kind: 'max-tokens' })
  })
  it('maps an unknown reason to a coded error finish', () => {
    expect(mapFinishReason('content_filter')).toEqual({
      kind: 'error',
      failure: { message: 'model stopped: content_filter', code: 'CONTENT_FILTER' },
    })
  })
})

describe('mapUsage', () => {
  it('subtracts cache reads to keep disjoint counts', () => {
    expect(mapUsage({ prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 6 } }))
      .toEqual({ inputTokens: 4, outputTokens: 4, cacheReadTokens: 6 })
  })
  it('reports reasoning tokens when present and omits absent optionals', () => {
    expect(mapUsage({ prompt_tokens: 3, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 2 } }))
      .toEqual({ inputTokens: 3, outputTokens: 5, reasoningTokens: 2 })
  })
})

describe('translate', () => {
  it('opens a reasoning block only on the first non-empty reasoning delta', async () => {
    const chunks = await collect([
      '{"choices":[{"delta":{"reasoning_content":""}}]}',
      '{"choices":[{"delta":{"reasoning_content":"think"}}]}',
      '{"choices":[{"delta":{"content":"answer"}}]}',
      '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
      '[DONE]',
    ])
    expect(chunks.filter(c => c.type === 'block-start')).toHaveLength(2)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('assembles interleaved tool-call fragments into one block', async () => {
    const chunks = await collect([
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"ls","arguments":"{\\"a\\":"}}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}}]}',
      '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      '[DONE]',
    ])
    const end = chunks.find(c => c.type === 'block-end')
    expect(end).toMatchObject({ block: { type: 'tool-call', name: 'ls', arguments: '{"a":1}' } })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('maps a stop with no content to an EMPTY_RESPONSE error finish', async () => {
    const chunks = await collect([
      '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
      '[DONE]',
    ])
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'EMPTY_RESPONSE' } } })
  })

  it('throws MALFORMED_RESPONSE on a bad JSON payload', async () => {
    await expect(collect(['not json', '[DONE]'])).rejects.toMatchObject({ failure: { code: 'MALFORMED_RESPONSE' } })
  })

  it('throws STREAM_CLOSED when the payload source omits [DONE]', async () => {
    await expect(collect(['{"choices":[{"delta":{"content":"x"}}]}']))
      .rejects.toMatchObject({ failure: { code: 'STREAM_CLOSED' } })
  })
})
