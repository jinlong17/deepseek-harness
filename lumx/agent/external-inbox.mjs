function normalized(list, start, count) {
  const offset = Number.isNaN(Math.trunc(start)) ? 0 : Math.trunc(start)
  const index = offset < 0 ? Math.max(list.length + offset, 0) : Math.min(offset, list.length)
  const value = Number.isNaN(Math.trunc(count)) ? 0 : Math.trunc(count)
  return { count: Math.min(Math.max(value, 0), list.length - index), index }
}

/** Driver-owned durable inbox without importing the default AgentLoop. */
export class ExternalInbox {
  #dispatch
  #session
  #state = { 'next-turn': [], 'next-step': [] }

  constructor(session, dispatch) {
    this.#session = session; this.#dispatch = dispatch
    for (const event of session.snapshotEvents()) {
      if (event.type !== 'agent/inbox/spliced') continue
      const list = this.#state[event.data.target]; const count = event.data.removedCount ?? 0
      if (!Number.isSafeInteger(event.data.start) || event.data.start < 0 || event.data.start > list.length
        || !Number.isSafeInteger(count) || count < 0 || event.data.start + count > list.length) throw new Error('persisted external inbox splice is invalid')
      list.splice(event.data.start, count, ...event.data.inserted)
    }
    this.#assertUnique()
  }

  get nextTurn() { return Object.freeze([...this.#state['next-turn']]) }
  get nextStep() { return Object.freeze([...this.#state['next-step']]) }
  get hasPending() { return this.#state['next-turn'].length > 0 || this.#state['next-step'].length > 0 }
  clear() { this.splice('next-step', 0, this.nextStep.length, []); this.splice('next-turn', 0, this.nextTurn.length, []) }
  append(target, message) { this.splice(target, this.#list(target).length, 0, [message]) }
  prepend(target, message) { this.splice(target, 0, 0, [message]) }
  replace(messageId, message) {
    const found = this.#find(messageId); if (found === undefined) return false
    this.splice(found.target, found.index, 1, [message]); return true
  }
  remove(messageId) {
    const found = this.#find(messageId); if (found === undefined) return false
    this.splice(found.target, found.index, 1, []); return true
  }
  splice(target, start, count, inserted) { return this.#mutate(target, start, count, inserted, true) }
  claim(turn) {
    const claimed = this.#mutate('next-step', 0, this.#state['next-step'].length, [], false)
    claimed.push(...this.#mutate('next-turn', 0, 1, [], false))
    for (const message of claimed) this.#dispatch.emit('agent/inbox/claimed', { message, turn })
    return claimed
  }

  #list(target) {
    if (target !== 'next-turn' && target !== 'next-step') throw new Error('external inbox target is invalid')
    return this.#state[target]
  }
  #find(messageId) {
    for (const target of ['next-turn', 'next-step']) {
      const index = this.#state[target].findIndex(message => message.id === messageId)
      if (index >= 0) return { index, target }
    }
  }
  #assertUnique(candidate) {
    const ids = new Set()
    for (const message of candidate ?? [...this.#state['next-turn'], ...this.#state['next-step']]) {
      if (typeof message?.id !== 'string' || ids.has(message.id)) throw new Error('external inbox message identity is invalid or duplicated')
      ids.add(message.id)
    }
  }
  #mutate(target, start, count, inserted, discarded) {
    const list = this.#list(target); if (!Array.isArray(inserted)) throw new Error('external inbox insertion is invalid')
    const position = normalized(list, start, count); const candidate = list.toSpliced(position.index, position.count, ...inserted)
    this.#assertUnique(target === 'next-turn' ? [...candidate, ...this.#state['next-step']] : [...this.#state['next-turn'], ...candidate])
    const removed = list.slice(position.index, position.index + position.count)
    if (removed.length === 0 && inserted.length === 0) return []
    const data = { target, start: position.index, inserted, ...(position.count === 0 ? {} : { removedCount: position.count }),
      ...(discarded && position.count > 0 ? { outcome: 'canceled' } : {}) }
    const event = this.#session.append('agent/inbox/spliced', data); list.splice(position.index, position.count, ...event.data.inserted)
    if (discarded) for (const message of removed) this.#dispatch.emit('agent/inbox/discarded', { message })
    for (const message of event.data.inserted) this.#dispatch.emit('agent/inbox/inserted', { message })
    return removed
  }
}
