/** B5-only prepare/finalize seam for the existing complete build contract. */

import { parseArgs } from 'node:util'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  CLIENT_BUILD_PROFILE_SELECTOR,
  clientBuildProcessEnvironment,
  repositoryClientBuildEnvironment,
  resolveClientBuildEnvironment,
  writeClientBuildRecord,
} from './client-build-environment.ts'

interface EnvironmentPlan {
  readonly schema: 'g9-b5-client-build-environment/v1'
  readonly root: string
  readonly profile: string | null
  readonly clientEnvironment: Readonly<Record<string, string>>
  readonly buildEnvironment: Readonly<Record<string, string>>
}

const BUILD_BASE_ENVIRONMENT = new Set(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ'])
const MACOS_TEXT_ENCODING_KEY = '__CF_USER_TEXT_ENCODING'
function currentMacOSTextEncoding(): string | undefined {
  if (process.platform !== 'darwin' || typeof process.getuid !== 'function') return undefined
  return `0x${process.getuid().toString(16).toUpperCase()}:0x0:0x0`
}

/** Remove only the observed Darwin per-user launch metadata before public build state. */
function exactBuildEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const expectedMacOSLaunchMetadata = currentMacOSTextEncoding()
  const discardMacOSLaunchMetadata = expectedMacOSLaunchMetadata !== undefined
    && environment[MACOS_TEXT_ENCODING_KEY] === expectedMacOSLaunchMetadata
  const unexpected = Object.keys(environment)
    .filter(name => !BUILD_BASE_ENVIRONMENT.has(name)
      && name !== CLIENT_BUILD_PROFILE_SELECTOR && !name.startsWith('DSH_CLIENT_')
      && !(discardMacOSLaunchMetadata && name === MACOS_TEXT_ENCODING_KEY))
    .sort()
  if (unexpected.length > 0) throw new Error(`unreviewed build environment keys: ${unexpected.join(', ')}`)
  if (!discardMacOSLaunchMetadata) return environment
  const normalized = { ...environment }
  delete normalized[MACOS_TEXT_ENCODING_KEY]
  return normalized
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is not an object`)
  }
  return value as Record<string, unknown>
}

function stringMap(value: unknown, label: string): Record<string, string> {
  const input = object(value, label)
  const rows = Object.entries(input)
  if (!rows.every(([key, item]) => key.length > 0 && typeof item === 'string')) {
    throw new Error(`${label} is not a string map`)
  }
  return Object.fromEntries(rows.sort(([left], [right]) => left.localeCompare(right))) as Record<string, string>
}

function readPlan(path: string): EnvironmentPlan {
  const raw = object(JSON.parse(readFileSync(path, 'utf8')), 'environment plan')
  if (raw.schema !== 'g9-b5-client-build-environment/v1') throw new Error('environment plan schema differs')
  if (typeof raw.root !== 'string' || (raw.profile !== null && typeof raw.profile !== 'string')) {
    throw new Error('environment plan root/profile differs')
  }
  return {
    schema: raw.schema,
    root: resolve(raw.root),
    profile: raw.profile,
    clientEnvironment: stringMap(raw.clientEnvironment, 'client environment'),
    buildEnvironment: stringMap(raw.buildEnvironment, 'build environment'),
  }
}

function prepare(root: string, output: string, profile: string | undefined): void {
  const parent = exactBuildEnvironment(process.env)
  const repositoryEnvironment = repositoryClientBuildEnvironment(root, parent)
  const selected = profile ?? process.env[CLIENT_BUILD_PROFILE_SELECTOR]
  const clientEnvironment = resolveClientBuildEnvironment(repositoryEnvironment, selected)
  const buildEnvironment = clientBuildProcessEnvironment(parent, clientEnvironment)
  const plan: EnvironmentPlan = {
    schema: 'g9-b5-client-build-environment/v1', root, profile: selected ?? null,
    clientEnvironment: stringMap(clientEnvironment, 'client environment'),
    buildEnvironment: stringMap(buildEnvironment, 'build environment'),
  }
  writeFileSync(output, `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx', mode: 0o400 })
}

function finalize(root: string, input: string): void {
  const plan = readPlan(input)
  if (plan.root !== root) throw new Error('environment plan belongs to a different root')
  const actualBuildEnvironment = stringMap(exactBuildEnvironment(process.env), 'process environment')
  if (JSON.stringify(actualBuildEnvironment) !== JSON.stringify(plan.buildEnvironment)) {
    throw new Error('finalizer process environment differs from prepared build environment')
  }
  const selected = resolveClientBuildEnvironment(process.env)
  if (JSON.stringify(stringMap(selected, 'selected client environment'))
      !== JSON.stringify(plan.clientEnvironment)) {
    throw new Error('finalizer client environment differs from prepared client environment')
  }
  const record = writeClientBuildRecord(root, plan.clientEnvironment)
  process.stdout.write(`${JSON.stringify(record)}\n`)
}

function main(): void {
  const { values } = parseArgs({ options: {
    mode: { type: 'string' }, root: { type: 'string' }, plan: { type: 'string' }, profile: { type: 'string' },
  }, allowPositionals: false })
  if ((values.mode !== 'prepare' && values.mode !== 'finalize') || values.root === undefined || values.plan === undefined) {
    throw new Error('required: --mode prepare|finalize --root ROOT --plan PATH [--profile PROFILE]')
  }
  const root = resolve(values.root)
  if (values.mode === 'prepare') prepare(root, resolve(values.plan), values.profile)
  else {
    if (values.profile !== undefined) throw new Error('--profile is preparation-only')
    finalize(root, resolve(values.plan))
  }
}

if (import.meta.main) main()
