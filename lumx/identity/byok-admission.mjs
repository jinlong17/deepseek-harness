import { LUMX_DESKTOP_APP_ID } from '../desktop/release-config.mjs'

/** A failed local identity check. No BYOK credential is retained by this seam. */
export class LumxByokAdmissionError extends Error {
  /** @param {'identity_required' | 'identity_invalid' | 'identity_expired' | 'identity_rejected'} code */
  constructor(code) {
    super(`LUMX BYOK admission denied: ${code}`)
    this.code = code
  }
}

/**
 * Admits a BYOK request only after an injected local identity gateway confirms it.
 * This seam deliberately does not use the upstream DeepSeek account plugins.
 *
 * @param {{ byokKey: string, gateway: { validate(input: { audience: string, credential: string, subject: string }): Promise<{ active: boolean, expiresAt: string, subject: string }> }, identity?: { credential?: string, expiresAt?: string, subject?: string, type?: string }, now?: Date }} input
 * @returns {Promise<{ subject: string }>}
 */
export async function admitLumxByok(input) {
  if (typeof input.byokKey !== 'string' || input.byokKey.length === 0) {
    throw new LumxByokAdmissionError('identity_required')
  }
  const identity = input.identity
  if (!isWellFormedIdentity(identity)) throw new LumxByokAdmissionError('identity_required')
  const now = input.now ?? new Date()
  if (Number.isNaN(now.valueOf()) || expired(identity.expiresAt, now)) {
    throw new LumxByokAdmissionError('identity_expired')
  }

  let verified
  try {
    verified = await input.gateway.validate({
      audience: LUMX_DESKTOP_APP_ID,
      credential: identity.credential,
      subject: identity.subject,
    })
  } catch {
    throw new LumxByokAdmissionError('identity_rejected')
  }
  if (!isVerifiedIdentity(verified, identity, now)) {
    throw new LumxByokAdmissionError('identity_rejected')
  }
  return { subject: identity.subject }
}

/** @param {unknown} identity */
function isWellFormedIdentity(identity) {
  return identity !== null
    && typeof identity === 'object'
    && identity.type === 'lumx.local-auth.v1'
    && typeof identity.subject === 'string'
    && identity.subject.length > 0
    && identity.subject !== 'anonymous'
    && typeof identity.credential === 'string'
    && identity.credential.length > 0
    && typeof identity.expiresAt === 'string'
}

/** @param {string} expiresAt @param {Date} now */
function expired(expiresAt, now) {
  const time = Date.parse(expiresAt)
  return Number.isNaN(time) || time <= now.valueOf()
}

/** @param {unknown} verified @param {{ subject: string }} identity @param {Date} now */
function isVerifiedIdentity(verified, identity, now) {
  return verified !== null
    && typeof verified === 'object'
    && verified.active === true
    && verified.subject === identity.subject
    && typeof verified.expiresAt === 'string'
    && !expired(verified.expiresAt, now)
}
