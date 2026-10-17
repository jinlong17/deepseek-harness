import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const H1_PLUGIN = fileURLToPath(new URL('../runtime/h1-driver-plugin.mjs', import.meta.url))
const BUNDLES = Object.freeze(['@deepseek-ai/dsh-base'])

/** Lab-only qualification fixture. Product profiles and registries must not import this module. */

function yamlString(value) {
  return JSON.stringify(value)
}

const PRIVACY_ROWS = Object.freeze([
  'session-log-deepseek',
  'plugin-package-inventory-deepseek',
  'session-telemetry-otel',
  'deepseek-account',
  'llm-deepseek-account',
  'desktop-product-telemetry',
  'product-analytics',
])

const DISABLED_ROWS = [
  'tool-bash',
  'tool-pwsh',
  'tool-fs',
  'tool-fs-search',
  'web',
  'web-search-deepseek',
  'web-fetch-http',
  'tool-web',
  'subagent',
  'subagent-spawn-in-process',
  'subagent-fork-in-process',
  'tool-subagent-control',
  'tool-subagent-list-agents',
  'tool-subagent',
  'tool-subagent-fork',
  'tool-plugin-manager',
  'plugin-manager',
  ...PRIVACY_ROWS,
]

/** Materialize the fixed base-backed H1 profile and its invocation overlay. */
export async function createH1DriverProfile(input) {
  const profileDirectory = join(input.dataHomeDirectory, 'profiles', 'lumx-h1-driver')
  const runtimePatch = join(profileDirectory, 'h1-driver.runtime.patch.yml')
  await mkdir(profileDirectory, { recursive: true, mode: 0o700 })
  await writeFile(join(profileDirectory, 'package.json'), `${JSON.stringify({
    name: '@lumx/h1-driver-profile',
    private: true,
    type: 'module',
    dsh: { profile: { bundles: BUNDLES } },
  }, null, 2)}\n`, { mode: 0o600 })
  await writeFile(join(profileDirectory, 'cordis.yml'), '[]\n', { mode: 0o600 })
  await writeFile(join(profileDirectory, 'cordis.patch.yml'), `${DISABLED_ROWS.map(id => `- id: ${id}\n  disabled: true`).join('\n')}\n`, { mode: 0o600 })
  await writeFile(runtimePatch, [
    '- id: session-title-llm',
    '  disabled: true',
    '- id: agent-default-model',
    '  config:',
    '    provider: lumx-h1',
    '    model: h1-controlled',
    '- insert:',
    '    - id: lumx-h1-driver',
    `      name: ${yamlString(pathToFileURL(H1_PLUGIN).href)}`,
    '      config:',
    `        runtimeId: ${yamlString(input.runtimeId)}`,
    `        sourceRoot: ${yamlString(input.sourceRoot)}`,
    '',
  ].join('\n'), { mode: 0o600 })
  return Object.freeze({
    bundles: BUNDLES,
    disabledRows: DISABLED_ROWS,
    privacyRows: PRIVACY_ROWS,
    installAnchor: join(input.sourceRoot, 'apps', 'cli', 'package.json'),
    profileDirectory,
    runtimePatch,
  })
}
