import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'
import * as LlmFriendli from '@deepseek-ai/dsh-llm-friendli'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  await closeMockServers()
  vi.unstubAllEnvs()
})

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-friendli-dyn-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/**
 * Real dynamic composition: llm + settings-file + credentials-local +
 * llm-friendli over one temp harness home, booted through cordis. `watch:
 * false` keeps every change flowing through the in-process write path.
 */
async function boot(dir: string, config: object): Promise<Context> {
  vi.stubEnv('DSH_HOME', dir)
  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(FileSettingsProvider, { path: join(dir, 'settings.yaml'), watch: false })
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  await ctx.plugin(LlmFriendli, config)
  return ctx
}

describe('llm-friendli dynamic composition', () => {
  it('registers the friendli route and its configurable-provider directory entry', async () => {
    const dir = await home()
    const ctx = await boot(dir, {})
    const entry = ctx.llm.listConfigurableProviders().find(e => e.provider === 'friendli')
    expect(entry).toMatchObject({ provider: 'friendli', displayName: 'FriendliAI' })
    expect(typeof entry?.settingsNs).toBe('string')
    const models = await ctx.llm.listModels('friendli')
    expect(models.map(m => m.id)).toContain('zai-org/GLM-5.2')
  })

  it('serves a request with the key resolved from the credential store', async () => {
    vi.stubEnv('FRIENDLI_API_KEY', '')
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const dir = await home()
    await writeFile(join(dir, '.credentials.yaml'), 'FRIENDLI_API_KEY: stored-key\n', { mode: 0o600 })
    const ctx = await boot(dir, { baseURL: server.url })
    const result = await assemble(ctx, { model: 'zai-org/GLM-5.2', messages: [] })
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(server.headers[0]?.authorization).toBe('Bearer stored-key')
  })

  it('fails with MISSING_CREDENTIAL when no key is set anywhere, keeping the route browsable', async () => {
    vi.stubEnv('FRIENDLI_API_KEY', '')
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const dir = await home()
    const ctx = await boot(dir, { baseURL: server.url })
    const result = await assemble(ctx, { model: 'zai-org/GLM-5.2', messages: [] })
    // ctx.llm.stream normalizes the adapter throw into a terminal error finish.
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } })
    // The route stays registered and its catalog browsable — onboarding path.
    expect((await ctx.llm.listModels('friendli')).length).toBeGreaterThan(0)
  })
})
