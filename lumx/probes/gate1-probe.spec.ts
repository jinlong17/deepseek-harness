import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent, type AgentFactory } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'
import ts from 'typescript'
import { createLumxLaunchEnvironment } from '../desktop/launch-environment.mjs'
import { admitLumxByok } from '../identity/byok-admission.mjs'
import { assertProductPatchBudget, listProductPatches, PATCH_BUDGET } from '../patches/registry.mjs'

interface Check {
  readonly id: string
  readonly result: 'pass' | 'fail'
  readonly evidence: string
  readonly failure_kind?: 'prerequisite' | 'behavior'
}

interface Capture {
  registry_factory_selftest: Check
  cordis_lifecycle_sentinel: Check
  product_inventory: {
    readonly files: readonly string[]
    readonly signals: Record<string, readonly string[]>
  }
  source_observations: Record<string, unknown>
  product_prerequisites: Record<string, unknown>
}

const repository = resolve(import.meta.dirname, '../..')

function stubAgent(rawId: string): Agent {
  const id = SessionId(rawId)
  return {
    id,
    options: {},
    session: Session.create(id),
    inbox: { nextTurn: [], nextStep: [] } as never,
    status: 'idle',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

function walk(root: string): string[] {
  const rows: string[] = []
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name)
    const item = statSync(path)
    if (item.isDirectory()) {
      if (name !== 'probes') rows.push(...walk(path))
    } else if (item.isFile() && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name)) {
      rows.push(relative(repository, path))
    }
  }
  return rows
}

function signalFiles(files: readonly string[], expressions: Record<string, RegExp>): Record<string, readonly string[]> {
  const signals: Record<string, string[]> = Object.fromEntries(Object.keys(expressions).map(key => [key, []]))
  for (const file of files) {
    if (!/\.(?:js|mjs|ts|tsx|json|ya?ml)$/.test(file)) continue
    const text = readFileSync(join(repository, file), 'utf8')
    for (const [name, expression] of Object.entries(expressions)) {
      if (expression.test(text)) signals[name]?.push(file)
    }
  }
  return signals
}

function directImports(source: string): string[] {
  const parsed = ts.createSourceFile('entry.ts', source, ts.ScriptTarget.Latest, false)
  return parsed.statements.flatMap(statement =>
    ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
      ? [statement.moduleSpecifier.text] : [])
}

function directImportMatches(source: string, expression: RegExp): boolean {
  return directImports(source).some(specifier => expression.test(specifier))
}

it('does not promote comments or string contents to direct imports', () => {
  expect(directImports('/*\nimport fake from "./agent-driver.mjs"\n*/\nconst note = "broker"'))
    .toEqual([])
  expect(directImports('import actual from "./launch-environment.mjs"'))
    .toEqual(['./launch-environment.mjs'])
})

it('runs bounded Gate 1 seam probes and writes one raw capture', async () => {
  const calls: string[] = []
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  const factory: AgentFactory = {
    async createAgent(_ownerCtx, options) {
      calls.push(`create:${options.sessionId}`)
      return { agent: stubAgent(options.sessionId), dispose: () => Promise.resolve() }
    },
    async resume(_ownerCtx, options) {
      calls.push(`resume:${options.resumeSessionId}`)
      return { agent: stubAgent(options.resumeSessionId), dispose: () => Promise.resolve() }
    },
  }
  const releaseFactory = ctx.agents.setFactory(factory)
  const created = await ctx.agents.create({ sessionId: SessionId('gate1-create') })
  const resumed = await ctx.agents.resume({ resumeSessionId: SessionId('gate1-resume') })
  await created.dispose()
  await resumed.dispose()
  await releaseFactory()

  let activations = 0
  let disposals = 0
  const sentinel = (inner: Context): void => {
    activations += 1
    inner.effect(() => () => { disposals += 1 }, 'gate1.lifecycle-sentinel')
  }
  const first = ctx.plugin(sentinel)
  await first
  await first.dispose()
  const reinstall = ctx.plugin(sentinel)
  await reinstall
  await reinstall.dispose()
  await ctx.fiber.dispose()

  const productRoot = join(repository, 'lumx')
  const files = walk(productRoot)
  const signals = signalFiles(files, {
    factory_driver: /setFactory\s*\(|createAgent\s*\(|resume\s*\(/,
    durable_adapter: /sessionPersistence|durable.{0,24}event|persisted.{0,24}event/is,
    ui_join: /durable.{0,24}(?:UI|render)|event.{0,24}(?:UI|render)/is,
    resolved_rows: /resolved.{0,24}rows|cordis\.patch|privacy.{0,24}row/is,
    governed_h1: /retry_count|retryCount|Gateway|Broker/,
    host_boundary: /token.{0,24}origin|origin.{0,24}token|close_fds|stdio/is,
    byok_positive: /BYOK|apiKey|inference/i,
    ui_control: /host.{0,24}control|control.{0,24}host/is,
  })
  const hostProcess = readFileSync(join(repository, 'apps/desktop/src/host-process.ts'), 'utf8')
  const desktopHost = readFileSync(join(repository, 'apps/desktop-host/src/index.ts'), 'utf8')
  const lumxLaunch = readFileSync(join(repository, 'lumx/desktop/launch.mjs'), 'utf8')
  assertProductPatchBudget()
  const isolatedLaunch = createLumxLaunchEnvironment({
    mode: 'consumer', osHome: '/synthetic-home', workspaceDirectory: '/synthetic-workspace', environment: {},
  })
  const identity = { credential: 'synthetic-credential', expiresAt: '2030-01-01T00:00:00.000Z',
    subject: 'synthetic-subject', type: 'lumx.local-auth.v1' }
  const admitted = await admitLumxByok({ byokKey: 'synthetic-byok', identity, now: new Date('2029-01-01T00:00:00.000Z'),
    gateway: { validate: async () => ({ active: true, expiresAt: identity.expiresAt, subject: identity.subject }) } })
  const capture: Capture = {
    registry_factory_selftest: {
      id: 'actual-AgentRegistry-fake-factory-create-resume',
      result: calls.join(',') === 'create:gate1-create,resume:gate1-resume' ? 'pass' : 'fail',
      evidence: `actual AgentRegistry calls: ${calls.join(',')}`,
      ...(calls.length === 2 ? {} : { failure_kind: 'behavior' as const }),
    },
    cordis_lifecycle_sentinel: {
      id: 'actual-Cordis-sentinel-reinstall-dispose',
      result: activations === 2 && disposals === 2 ? 'pass' : 'fail',
      evidence: `actual Cordis sentinel activations=${activations}, disposals=${disposals}`,
      ...(activations === 2 && disposals === 2 ? {} : { failure_kind: 'behavior' as const }),
    },
    product_inventory: { files, signals },
    source_observations: {
      desktop_host_spawn_uses_ipc: /stdio:\s*\[[^\]]*'ipc'/.test(hostProcess),
      desktop_host_launcher_passes_environment: /desktopNodeEnvironment\(/.test(hostProcess),
      host_control_is_parent_child_ipc: /process\.on\('message'/.test(desktopHost),
      fixed_product_loopback_port_19387: /'--port',\s*'19387'/.test(desktopHost),
      authenticated_web_url_present: /authenticatedUrl\(/.test(desktopHost),
      product_token_origin_os_enforcement_observed: false,
    },
    product_prerequisites: {
      patch_registry: { budget: PATCH_BUDGET, count: listProductPatches().length },
      isolated_launch: isolatedLaunch,
      byok_admission: {
        result: admitted.subject === identity.subject ? 'pass' : 'fail',
        evidence: `validated synthetic subject=${admitted.subject}`,
      },
      analysis_kind: 'direct static import specifiers only; keywords are not an import graph',
      lumx_launch_imports: directImports(lumxLaunch),
      electron_host_imports_lumx: directImportMatches(hostProcess, /lumx/i),
      desktop_host_imports_lumx: directImportMatches(desktopHost, /lumx/i),
      launch_imports_agent_driver: directImportMatches(lumxLaunch, /agent|factory|driver/i),
      launch_imports_durable_adapter: directImportMatches(lumxLaunch, /durable|persistence/i),
      launch_imports_ui_adapter: directImportMatches(lumxLaunch, /render|ui-control/i),
      launch_imports_cordis_patch_adapter: directImportMatches(lumxLaunch, /cordis|patch/i),
      launch_imports_h1_consumer: directImportMatches(lumxLaunch, /gateway|broker|retry_count|retryCount/i),
      launch_imports_host_control: directImportMatches(lumxLaunch, /host-control|control-channel/i),
    },
  }
  const output = process.env.A2K_GATE1_PROBE_OUTPUT
  expect(output).toBeTruthy()
  mkdirSync(dirname(output as string), { recursive: true })
  writeFileSync(output as string, `${JSON.stringify(capture, null, 2)}\n`)
  expect(capture.registry_factory_selftest.result).toBe('pass')
  expect(capture.cordis_lifecycle_sentinel.result).toBe('pass')
})
