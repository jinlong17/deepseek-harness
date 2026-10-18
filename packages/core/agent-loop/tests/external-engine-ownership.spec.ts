import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function bytes(root: string): Promise<string[]> {
  const names = (await readdir(root, { recursive: true })).sort()
  const values: string[] = []
  for (const name of names) {
    try { values.push(`${name}:${(await readFile(join(root, name))).toString('hex')}`) } catch { /* directory */ }
  }
  return values
}

async function context(root: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root }); return ctx
}

function binding(seq = 0) {
  return { type: 'agent/external-engine-bound' as const, seq: SessionSeq(seq), time: 1,
    data: { version: 1 as const, engineId: 'qwen', nativeSessionId: 'native', artifactIdentity: 'tree-sha256' } }
}

it('refuses a persisted external-engine session before repair writes or publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-loop-external-owner-')); roots.push(root)
  const ctx = await context(root); const id = SessionId('external-owned')
  const session = ctx.sessions.create(id, { seed: [binding()] }); const handle = await ctx.sessionPersistence.create(session.header)
  await handle.append(session.snapshotEvents()); await handle.close(); const before = await bytes(root)
  await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
  await expect(ctx.agents.resume({ resumeSessionId: id })).rejects.toThrow(/owned by an external engine/)
  expect(ctx.agents.get(id)).toBeUndefined(); expect(await bytes(root)).toEqual(before)
  await ctx.fiber.dispose()
})

it('refuses an external binding in a create seed before persistence publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-loop-external-seed-')); roots.push(root)
  const ctx = await context(root); await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 }); const before = await bytes(root)
  await expect(ctx.agents.create({ sessionId: SessionId('external-seed'), seed: [binding()] })).rejects.toThrow(/owned by an external engine/)
  expect(ctx.agents.get(SessionId('external-seed'))).toBeUndefined(); expect(await bytes(root)).toEqual(before)
  await ctx.fiber.dispose()
})
