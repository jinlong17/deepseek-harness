import type { Volatile } from '@deepseek-ai/cosmokit'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_MAX_PARALLEL_TOOL_CALLS } from './constants.ts'
import type { AgentLoop } from './index.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { agentLoop: AgentLoop; configuredAgentIdentities?: ConfiguredAgentIdentities }
  interface Events { 'agent-loop/config-start-failed'(payload: { sessionId: SessionId; error: unknown }): void }
}

export interface LauncherAgentIdentity { id: SessionId; resume: boolean }
export interface ConfiguredAgentIdentities extends Readonly<Record<string, LauncherAgentIdentity>> {}
export const CONFIGURED_AGENT_IDENTITIES_KEY = 'configuredAgentIdentities'
export interface Config {
  maxParallelToolCalls: Volatile<number>
  agents: (AgentOptions & { id: string; sessionId?: SessionId; cwd?: string; resumeSessionId?: SessionId })[]
}

export function applyLauncherIdentities(agents: Config['agents'], identities: ConfiguredAgentIdentities | undefined): Config['agents'] {
  if (identities === undefined) return agents
  return agents.map((agent) => {
    const identity = identities[agent.id]
    if (identity === undefined) return agent
    const { sessionId: _sessionId, resumeSessionId: _resumeSessionId, ...rest } = agent
    return identity.resume ? { ...rest, resumeSessionId: identity.id } : { ...rest, sessionId: identity.id }
  })
}

export function validateConfiguredAgents(agents: Config['agents']): void {
  const exactIdentities = new Map<SessionId, string>()
  for (const { id, sessionId, resumeSessionId } of agents) {
    const hasResumeId = resumeSessionId !== undefined && resumeSessionId !== ''
    if (sessionId !== undefined && hasResumeId) throw new Error(`agent "${id}": sessionId and resumeSessionId are mutually exclusive`)
    const exactIdentity = hasResumeId ? resumeSessionId : sessionId
    if (exactIdentity === undefined) continue
    const firstId = exactIdentities.get(exactIdentity)
    if (firstId !== undefined) throw new Error(`agents "${firstId}" and "${id}" use duplicate exact session identity "${exactIdentity}"`)
    exactIdentities.set(exactIdentity, id)
  }
}

export const agentLoopConfigSchema: z<{ agents?: Config['agents']; maxParallelToolCalls?: number }, Config> = z.object({
  maxParallelToolCalls: z.number().step(1).min(1).default(DEFAULT_MAX_PARALLEL_TOOL_CALLS).volatile(),
  agents: z.array(z.object({
    id: z.string().required(), sessionId: z.string().min(1), provider: z.string(), model: z.string(),
    reasoningEffort: z.string().min(1) as z<ReturnType<typeof ReasoningEffortId>>,
    maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER), cwd: z.string(), resumeSessionId: z.string(),
  })).default([]),
}) as z<{ agents?: Config['agents']; maxParallelToolCalls?: number }, Config>
