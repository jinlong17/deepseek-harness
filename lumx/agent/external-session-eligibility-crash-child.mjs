import { writeFileSync } from 'node:fs'

import { Context } from '../../vendor/cordis/lib/index.js'
import AgentRegistry from '../../packages/core/agent/lib/index.js'
import SessionStore from '../../packages/core/session/lib/index.js'
import JsonlSessionPersistence from '../../packages/session/session-persistence-jsonl/lib/index.js'
import { createExternalEngineRouter, createExternalQwenFactory } from './external-agent-factory.mjs'
import { createExternalSessionEligibilityStore } from './external-session-eligibility.mjs'

const [mode, persistenceRoot, eligibilityRoot, phasePath] = process.argv.slice(2)
if (!['precommit', 'postcommit'].includes(mode) || [persistenceRoot, eligibilityRoot, phasePath].some(value => value === undefined)) throw new Error('invalid crash-child arguments')
const ctx = new Context(); await ctx.plugin(SessionStore); await ctx.plugin(AgentRegistry); await ctx.plugin(JsonlSessionPersistence, { root: persistenceRoot, compression: 'none' })
const router = createExternalEngineRouter(); const engine = { router, async create(_input, { handleId }) { return { handleId, nativeSessionId: `native-${mode}` } }, async load() { throw new Error('crash child never loads') }, async prompt() {}, async cancel() {}, async dispose() {} }
const eligibility = createExternalSessionEligibilityStore({ eligibilityRoot, mode: 'developer', persistenceRoot, persistenceScope: persistenceRoot })
createExternalQwenFactory(ctx, { artifactIdentity: 'artifact-sha256', eligibility, engine, engineId: 'qwen-code-0.24.0', model: 'qwen3.7-max', provider: 'external-qwen', router })
const stop = () => { writeFileSync(phasePath, mode); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0) }
if (mode === 'postcommit') ctx.on('agent/created', stop)
await ctx.agents.create({ sessionId: `crash-${mode}`, ...mode === 'precommit' ? { setup: () => ({ commit: stop }) } : {} })
throw new Error('crash child crossed its kill barrier')
