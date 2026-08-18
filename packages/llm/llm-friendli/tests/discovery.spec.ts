import { afterEach, describe, expect, it } from 'vitest'
import { discoverModels, readListing } from '../src/discovery.ts'
import { closeMockServers, mockServer } from './mock-server.ts'

afterEach(async () => { await closeMockServers() })

const LISTING = JSON.stringify({
  data: [
    { id: 'zai-org/GLM-5.2', name: 'zai-org/GLM-5.2', context_length: 1048576, max_completion_tokens: 1048576 },
    { id: 'google/gemma-4-31B-it', context_length: 262144, max_completion_tokens: 262144 },
    { id: 'LGAI/old-model', context_length: 262144, deprecation_date: '2026-08-20T00:00:00Z' },
    { name: 'no-id' },
  ],
})

describe('readListing', () => {
  it('adopts usable entries, sizes them, and drops the id when name equals id', () => {
    const models = readListing(JSON.parse(LISTING))
    expect(models).toEqual([
      { id: 'zai-org/GLM-5.2', contextWindow: 1048576, maxTokens: 1048576 },
      { id: 'google/gemma-4-31B-it', contextWindow: 262144, maxTokens: 262144 },
    ])
  })

  it('throws DISCOVERY_FAILED without a data array', () => {
    expect(() => readListing({})).toThrow(/data.*array|DISCOVERY_FAILED/)
  })
})

describe('discoverModels', () => {
  it('interrogates GET {baseURL}/models with the drafted key', async () => {
    const server = await mockServer([{ kind: 'json', body: LISTING }])
    const models = await discoverModels({ baseURL: server.url, apiKey: 'draft-key' }, () => Promise.resolve(undefined))
    expect(models.map(m => m.id)).toEqual(['zai-org/GLM-5.2', 'google/gemma-4-31B-it'])
    expect(server.targets[0]).toEqual({ method: 'GET', url: '/models' })
    expect(server.headers[0]?.authorization).toBe('Bearer draft-key')
  })

  it('falls back to the stored key when the draft carries none', async () => {
    const server = await mockServer([{ kind: 'json', body: LISTING }])
    await discoverModels({ baseURL: server.url }, () => Promise.resolve('stored-key'))
    expect(server.headers[0]?.authorization).toBe('Bearer stored-key')
  })

  it('requires an endpoint', async () => {
    await expect(discoverModels({}, () => Promise.resolve(undefined)))
      .rejects.toMatchObject({ failure: { code: 'DISCOVERY_FAILED' } })
  })

  it('maps a non-2xx listing to DISCOVERY_FAILED', async () => {
    const server = await mockServer([{ kind: 'http-error', status: 401, body: '{}' }])
    await expect(discoverModels({ baseURL: server.url }, () => Promise.resolve(undefined)))
      .rejects.toMatchObject({ failure: { code: 'DISCOVERY_FAILED' } })
  })

  it('maps non-JSON to DISCOVERY_FAILED', async () => {
    const server = await mockServer([{ kind: 'json', body: 'not json' }])
    await expect(discoverModels({ baseURL: server.url }, () => Promise.resolve(undefined)))
      .rejects.toMatchObject({ failure: { code: 'DISCOVERY_FAILED' } })
  })

  it('maps an unreachable endpoint to DISCOVERY_FAILED', async () => {
    // Port 1 is unbound; the connection is refused before any reply.
    await expect(discoverModels({ baseURL: 'http://127.0.0.1:1' }, () => Promise.resolve(undefined)))
      .rejects.toMatchObject({ failure: { code: 'DISCOVERY_FAILED' } })
  })
})
