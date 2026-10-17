/** Stable product identifiers shared by the launcher and packaging overlay. */
export const LUMX_DESKTOP_APP_ID = 'com.lumxai.desktop'
export const LUMX_DESKTOP_NAME = 'LUMX Desktop'
export const LUMX_PROTOCOL = 'lumx'
export const LUMX_ORIGIN = 'lumx:///'
/** Codex is the first available agent in the LUMX release configuration. */
export const LUMX_AGENT_PRIORITY = Object.freeze(['codex', 'claude-agent'])

/**
 * Adds LUMX's product identity to an Electron Builder configuration.
 *
 * @param {object} [base] Existing downstream Electron Builder settings.
 * @returns {object} A new config object; the input is not mutated.
 */
export function createLumxElectronBuilderOverlay(base = {}) {
  return {
    ...base,
    appId: LUMX_DESKTOP_APP_ID,
    productName: LUMX_DESKTOP_NAME,
    protocols: [{ name: LUMX_DESKTOP_NAME, schemes: [LUMX_PROTOCOL] }],
  }
}
