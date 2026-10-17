import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { errorRecord, subcheck, unit, withDeadline } from './h1-driver-common.mjs'
import { runH1 } from './h1-driver-h1-observation.mjs'

/** Lab-only executable: collect dynamic qualification evidence from real DSH composition paths. */

function argsOf(argv) {
  const args = new Map()
  for (let index = 0; index < argv.length; index += 2) args.set(argv[index], argv[index + 1])
  const required = name => {
    const value = args.get(name)
    if (value === undefined) throw new Error(`missing ${name}`)
    return resolve(value)
  }
  return {
    osHome: required('--os-home'),
    output: required('--output'),
    sourceRoot: required('--source-root'),
    workspace: required('--workspace'),
  }
}

async function closeAcp(launched, observation) {
  if (launched === undefined) return
  try { await launched.close() } catch (error) { observation.closeError = errorRecord(error) }
  observation.stdout = launched.rawStdout()
  observation.stderr = launched.stderr()
  observation.exitCode = launched.child.exitCode
  observation.signalCode = launched.child.signalCode
}

async function runDshNonAgentLoop(options, runtimeRoot) {
  const positive = { phase: 'starting' }
  const negative = { phase: 'not-started' }
  let positiveLaunch
  let negativeLaunch
  try {
    const snapshot = await import(pathToFileURL(join(
      options.sourceRoot, 'packages/test-support/session-snapshot/lib/index.js',
    )).href)
    const protocol = await import(pathToFileURL(join(
      options.sourceRoot,
      'node_modules/.pnpm/node_modules/@agentclientprotocol/sdk/dist/acp.js',
    )).href)
    const noOpPatch = join(runtimeRoot, 'acp-positive.patch.yml')
    const disabledPatch = join(runtimeRoot, 'acp-agent-loop-disabled.patch.yml')
    await writeFile(noOpPatch, '[]\n', { mode: 0o600 })
    await writeFile(disabledPatch, [
      '- id: agent-loop',
      '  disabled: true',
      '- id: agent-loop-invariant',
      '  disabled: true',
      '',
    ].join('\n'), { mode: 0o600 })
    const agent = {
      binScript: join(options.sourceRoot, 'apps/cli/src/bin.ts'),
      libBinScript: join(options.sourceRoot, 'apps/cli/lib/bin.js'),
      configPath: noOpPatch,
      profile: 'acp',
      tsconfigPath: join(options.sourceRoot, 'tsconfig.json'),
    }
    const env = {
      DEEPSEEK_API_KEY: 'sk-synthetic-never-used',
      DSH_EXAMPLE_MODE: 'lib',
      DSH_TELEMETRY_DISABLED: '1',
    }

    positiveLaunch = snapshot.launchAcpTestAgent({ agent, cwd: options.workspace, env })
    await withDeadline('ACP positive spawn', positiveLaunch.spawned)
    positive.phase = 'spawned'
    const initialized = await withDeadline('ACP positive initialize', positiveLaunch.client.initialize({
      protocolVersion: protocol.PROTOCOL_VERSION,
      clientCapabilities: {},
    }))
    positive.phase = 'initialized'
    const created = await withDeadline('ACP positive session/new', positiveLaunch.client.newSession({
      cwd: options.workspace,
      mcpServers: [],
    }))
    positive.phase = 'session-created'
    positive.initialize = initialized
    positive.sessionId = created.sessionId
    await closeAcp(positiveLaunch, positive)
    positiveLaunch = undefined

    negative.phase = 'starting'
    negativeLaunch = snapshot.launchAcpTestAgent({
      agent,
      configPath: disabledPatch,
      cwd: options.workspace,
      env,
    })
    await withDeadline('ACP negative spawn', negativeLaunch.spawned)
    negative.phase = 'spawned'
    negative.initialize = await withDeadline('ACP negative initialize', negativeLaunch.client.initialize({
      protocolVersion: protocol.PROTOCOL_VERSION,
      clientCapabilities: {},
    }))
    negative.phase = 'initialized'
    negative.list = await withDeadline('ACP non-AgentLoop session/list', negativeLaunch.client.listSessions({
      cwd: options.workspace,
    }))
    negative.phase = 'persisted-session-listed'
    try {
      negative.newSession = await withDeadline('ACP non-AgentLoop session/new', negativeLaunch.client.newSession({
        cwd: options.workspace,
        mcpServers: [],
      }))
    } catch (error) {
      negative.newSessionError = errorRecord(error)
    }
    try {
      negative.resumeSession = await withDeadline('ACP non-AgentLoop session/resume', negativeLaunch.client.resumeSession({
        sessionId: created.sessionId,
        cwd: options.workspace,
        mcpServers: [],
      }))
    } catch (error) {
      negative.resumeSessionError = errorRecord(error)
    }
    negative.phase = 'negative-calls-complete'
    const listed = negative.list.sessions.some(row => row.sessionId === created.sessionId)
    const newErrorText = JSON.stringify(negative.newSessionError ?? {})
    const resumeErrorText = JSON.stringify(negative.resumeSessionError ?? {})
    const newMissingFactory = negative.newSessionError !== undefined && negative.newSession === undefined
      && newErrorText.includes('no agent factory registered')
    const resumeMissingFactory = negative.resumeSessionError !== undefined && negative.resumeSession === undefined
      && resumeErrorText.includes('no agent factory registered')
    const newSupported = negative.newSession !== undefined && negative.newSessionError === undefined
    const resumeSupported = negative.resumeSession !== undefined && negative.resumeSessionError === undefined
    const subchecks = [
      subcheck('agent-loop-positive-session-new', typeof created.sessionId === 'string' && created.sessionId.length > 0,
        { sessionId: created.sessionId }, 'normal AgentLoop profile did not create a session'),
      subcheck('persisted-session-load-visible', listed, negative.list,
        'the AgentLoop-disabled composition could not list the positive persisted session'),
      subcheck('non-agent-loop-session-new-capability', newSupported,
        { rejected: newMissingFactory, error: negative.newSessionError, unexpected: negative.newSession },
        newMissingFactory
          ? 'actual session/new rejected because the Agent factory is absent with AgentLoop disabled'
          : 'session/new did not produce the expected missing-factory capability refusal'),
      subcheck('non-agent-loop-session-resume-capability', resumeSupported,
        { rejected: resumeMissingFactory, error: negative.resumeSessionError, unexpected: negative.resumeSession },
        resumeMissingFactory
          ? 'actual session/resume loaded persistence but rejected because the Agent factory is absent'
          : 'session/resume did not produce the expected missing-factory capability refusal'),
    ]
    return {
      observation: { positive, negative, overlay: disabledPatch },
      counted: unit('real/DSH-non-AgentLoop-driver', subchecks,
        'DSH ACP has no non-AgentLoop Agent factory; actual session/new and session/resume reject'),
    }
  } catch (error) {
    return {
      observation: { positive, negative, environmentError: errorRecord(error) },
      counted: unit('real/DSH-non-AgentLoop-driver', [
        subcheck('environment-execution', false, { positive, negative }, errorRecord(error).message),
      ], 'environment failure prevented the real ACP non-AgentLoop capability observation'),
    }
  } finally {
    await closeAcp(positiveLaunch, positive)
    await closeAcp(negativeLaunch, negative)
  }
}

async function main() {
  const options = argsOf(process.argv.slice(2))
  const runtimeRoot = join(options.osHome, 'h1-driver-runtime')
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 })
  const capture = {
    generatedAt: new Date().toISOString(),
    scope: 'actual runProfile H1 inventory and actual ACP non-AgentLoop driver capability',
    counted_results: [],
    observations: {},
  }
  try {
    const h1 = await runH1(options)
    capture.counted_results.push(h1.counted)
    capture.observations.h1 = h1.observation
    const dsh = await runDshNonAgentLoop(options, runtimeRoot)
    capture.counted_results.push(dsh.counted)
    capture.observations.dshNonAgentLoop = dsh.observation
  } catch (error) {
    capture.fatal = errorRecord(error)
  } finally {
    await writeFile(options.output, `${JSON.stringify(capture, null, 2)}\n`, { mode: 0o600 })
  }
  return capture.counted_results.length === 2
    && capture.counted_results.every(row => row.status === 'pass') ? 0 : 1
}

process.exitCode = await main()
