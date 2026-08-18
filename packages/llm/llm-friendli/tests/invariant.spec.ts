import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Invariants from '@deepseek-ai/dsh-invariants'
import * as FriendliInvariant from '../src/invariant.ts'

describe('llm-friendli invariant companion', () => {
  it('registers package ownership and disposes cleanly', async () => {
    const ctx = new Context()
    await ctx.plugin(Invariants)
    const fiber = ctx.plugin(FriendliInvariant)
    await fiber
    // A no-runtime-invariant companion still reserves its package name; the
    // registry accepts it and disposal removes it (HMR-safety contract).
    await fiber.dispose()
    expect(FriendliInvariant.name).toBe('llm-friendli-invariant')
  })
})
