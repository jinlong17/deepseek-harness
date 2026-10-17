import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const H1_PLUGIN = fileURLToPath(new URL('../runtime/governed-h1-adapter.mjs', import.meta.url))
const BUNDLES = Object.freeze(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
export const GOVERNED_H1_PRIVACY_ROWS = Object.freeze([
  'session-log-deepseek', 'plugin-package-inventory-deepseek', 'session-telemetry-otel',
  'deepseek-account', 'llm-deepseek-account', 'desktop-product-telemetry', 'product-analytics',
])
const DISABLED_ROWS = Object.freeze([
  'tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search', 'web', 'web-search-deepseek', 'web-fetch-http',
  'tool-web', 'subagent', 'subagent-spawn-in-process', 'subagent-fork-in-process', 'tool-subagent-control',
  'tool-subagent-list-agents', 'tool-subagent', 'tool-subagent-fork', 'tool-plugin-manager', 'plugin-manager',
  ...GOVERNED_H1_PRIVACY_ROWS,
])
const yaml = value => JSON.stringify(value)

/** Materialize the fixed product H1 profile; no caller plugin or patch enters it. */
export async function createGovernedH1Profile(input) {
  const profileDirectory = join(input.dataHomeDirectory, 'profiles', 'lumx-governed-h1')
  const runtimePatch = join(profileDirectory, 'governed-h1.runtime.patch.yml')
  await mkdir(profileDirectory, { recursive: true, mode: 0o700 })
  await writeFile(join(profileDirectory, 'package.json'), `${JSON.stringify({
    name: '@lumx/governed-h1-profile', private: true, type: 'module', dsh: { profile: { bundles: BUNDLES } },
  }, null, 2)}\n`, { mode: 0o600 })
  await writeFile(join(profileDirectory, 'cordis.yml'), '[]\n', { mode: 0o600 })
  await writeFile(join(profileDirectory, 'cordis.patch.yml'), `${DISABLED_ROWS.map(id => `- id: ${id}\n  disabled: true`).join('\n')}\n`, { mode: 0o600 })
  await writeFile(runtimePatch, [
    '- id: session-title-llm', '  disabled: true', '- id: agent-default-model', '  config:',
    '    provider: lumx-h1', '    model: h1-controlled', '- insert:', '    - id: lumx-governed-h1-adapter',
    `      name: ${yaml(pathToFileURL(H1_PLUGIN).href)}`, '      config:', `        runtimeId: ${yaml(input.runtimeId)}`,
    `        sourceRoot: ${yaml(input.sourceRoot)}`, '',
  ].join('\n'), { mode: 0o600 })
  return Object.freeze({
    bundles: BUNDLES, disabledRows: DISABLED_ROWS, privacyRows: GOVERNED_H1_PRIVACY_ROWS,
    installAnchor: join(input.sourceRoot, 'apps', 'cli', 'package.json'), profileDirectory, runtimePatch,
  })
}
