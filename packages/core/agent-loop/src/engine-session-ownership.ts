const EXTERNAL_BINDING = 'agent/external-engine-bound'

/** Refuse logs owned by an external engine before default AgentLoop interpretation or writes. */
export function assertAgentLoopSessionOwnership(events: readonly { type: string }[]): void {
  if (events.some(event => event.type === EXTERNAL_BINDING)) {
    throw new Error('session is owned by an external engine and cannot be opened by AgentLoop')
  }
}
