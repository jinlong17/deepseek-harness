import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import {
  LUMX_AGENT_PRIORITY,
  LUMX_DESKTOP_APP_ID,
  LUMX_DESKTOP_NAME,
  LUMX_ORIGIN,
  LUMX_PROTOCOL,
} from './release-config.mjs'

const TRUE = new Set(['1', 'true', 'yes', 'on'])
const FALSE = new Set(['0', 'false', 'no', 'off'])

/**
 * Resolves the LUMX launcher inputs without creating or mutating any directory.
 *
 * @param {{ mode: 'consumer' | 'developer', homeDirectory: string, protectedHomeDirectories?: readonly string[], workspaceDirectory: string, environment?: Record<string, string | undefined> }} input
 * @returns {{ agentPriority: readonly string[], appId: string, appName: string, dataHomeDirectory: string, origin: string, profile: 'consumer' | 'developer', protocol: string, homeDirectory: string, telemetry: { enabled: boolean, implementation: 'configuration-only' }, workspaceDirectory: string }}
 */
export function resolveLumxLaunchEnvironment(input) {
  const homeDirectory = requiredAbsoluteDirectory(input.homeDirectory, 'homeDirectory')
  const workspaceDirectory = requiredAbsoluteDirectory(input.workspaceDirectory, 'workspaceDirectory')
  if (input.mode !== 'consumer' && input.mode !== 'developer') {
    throw new Error('LUMX launch mode must be consumer or developer')
  }
  const protectedHomeDirectories = [homeDirectory, ...(input.protectedHomeDirectories ?? [])]
    .map(directory => requiredAbsoluteDirectory(directory, 'protectedHomeDirectories'))
  if (protectedHomeDirectories.some(directory => pathsOverlap(workspaceDirectory, directory))) {
    throw new Error('LUMX workspaceDirectory must be outside every LUMX data home')
  }

  return {
    agentPriority: LUMX_AGENT_PRIORITY,
    appId: LUMX_DESKTOP_APP_ID,
    appName: LUMX_DESKTOP_NAME,
    dataHomeDirectory: homeDirectory,
    origin: LUMX_ORIGIN,
    profile: input.mode,
    protocol: LUMX_PROTOCOL,
    homeDirectory,
    telemetry: { enabled: resolveTelemetry(input.environment), implementation: 'configuration-only' },
    workspaceDirectory,
  }
}

/**
 * Uses a caller-provided OS home as the only source of LUMX's default home.
 *
 * @param {{ mode: 'consumer' | 'developer', osHome: string, workspaceDirectory: string, environment?: Record<string, string | undefined> }} input
 * @returns {ReturnType<typeof resolveLumxLaunchEnvironment>}
 */
export function createLumxLaunchEnvironment(input) {
  const osHome = requiredAbsoluteDirectory(input.osHome, 'osHome')
  const consumerHome = join(osHome, '.lumx')
  const developerHome = join(osHome, '.lumx-developer')
  return resolveLumxLaunchEnvironment({
    ...input,
    homeDirectory: input.mode === 'consumer' ? consumerHome : developerHome,
    protectedHomeDirectories: [consumerHome, developerHome],
  })
}

/** @param {Record<string, string | undefined> | undefined} environment */
function resolveTelemetry(environment) {
  const value = environment?.LUMX_TELEMETRY_ENABLED
  if (value === undefined || value === '') return true
  const normalized = value.trim().toLowerCase()
  if (TRUE.has(normalized)) return true
  if (FALSE.has(normalized)) return false
  throw new Error('LUMX_TELEMETRY_ENABLED must be one of 1, true, yes, on, 0, false, no, off')
}

/** @param {string} directory @param {string} field */
function requiredAbsoluteDirectory(directory, field) {
  if (typeof directory !== 'string' || directory.length === 0 || !isAbsolute(directory)) {
    throw new Error(`LUMX ${field} must be an absolute path`)
  }
  return resolve(directory)
}

/** @param {string} candidate @param {string} parent */
function isInside(candidate, parent) {
  const path = relative(parent, candidate)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

/** @param {string} first @param {string} second */
function pathsOverlap(first, second) {
  return isInside(first, second) || isInside(second, first)
}
