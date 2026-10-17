import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PRIVACY_PATCH = fileURLToPath(new URL('./privacy.patch.yml', import.meta.url))
const BYOK_PLUGIN = fileURLToPath(new URL('./byok-plugin.mjs', import.meta.url))
const BUNDLES = Object.freeze(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])

function yamlString(value) {
  return JSON.stringify(value)
}

/**
 * Materialize the fixed application-owned profile consumed by runProfile.
 * No caller-supplied bundle, plugin, or patch path enters the composition.
 *
 * @param {{ dataHomeDirectory: string, profileName: string, runtimeId: string, sourceRoot: string }} input
 */
export async function createLumxRuntimeProfile(input) {
  const profileDirectory = join(input.dataHomeDirectory, 'profiles', input.profileName)
  const runtimePatch = join(profileDirectory, 'lumx.runtime.patch.yml')
  await mkdir(profileDirectory, { recursive: true, mode: 0o700 })
  await writeFile(join(profileDirectory, 'package.json'), `${JSON.stringify({
    name: `@lumx/runtime-profile-${input.profileName}`,
    private: true,
    type: 'module',
    dsh: { profile: { bundles: BUNDLES } },
  }, null, 2)}\n`, { mode: 0o600 })
  await writeFile(join(profileDirectory, 'cordis.yml'), '[]\n', { mode: 0o600 })
  await writeFile(join(profileDirectory, 'cordis.patch.yml'), await readFile(PRIVACY_PATCH), { mode: 0o600 })
  await writeFile(runtimePatch, [
    '- id: hmr',
    '  disabled: true',
    '- id: account-controller',
    '  disabled: true',
    '- id: session-title-llm',
    '  disabled: true',
    '- id: agent-default-model',
    '  config:',
    '    provider: lumx-byok',
    '    model: lumx-loopback',
    '- insert:',
    '    - id: lumx-byok',
    `      name: ${yamlString(pathToFileURL(BYOK_PLUGIN).href)}`,
    '      config:',
    `        runtimeId: ${yamlString(input.runtimeId)}`,
    `        sourceRoot: ${yamlString(input.sourceRoot)}`,
    '',
  ].join('\n'), { mode: 0o600 })
  return Object.freeze({
    bundles: BUNDLES,
    installAnchor: join(input.sourceRoot, 'apps', 'cli', 'package.json'),
    profileDirectory,
    runtimePatch,
  })
}

export { BUNDLES as LUMX_RUNTIME_BUNDLES }
