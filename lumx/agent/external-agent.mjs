import { agentEvents } from '../../packages/core/agent/lib/index.js'
import { createScope } from '../../packages/core/scope/lib/index.js'
import { ToolCallRecovery } from '../../packages/core/session/lib/index.js'
import { AssistantStreamAccumulator, BlockAssembler, LlmAttemptId, ToolCallId, createAssistantMessage, createToolResultMessage } from '../../packages/llm/llm/lib/index.js'

import { ExternalInbox } from './external-inbox.mjs'

function textContent(messages) {
  const prompt = []
  for (const message of messages) for (const block of message.content) {
    if (block.type !== 'text') throw new Error(`external Qwen driver does not admit ${block.type} input`)
    prompt.push({ type: 'text', text: block.text })
  }
  if (prompt.length === 0) throw new Error('external Qwen prompt has no text content')
  return prompt
}
function failure(error) { return { code: 'UNKNOWN', message: error instanceof Error ? error.message : String(error) } }

class ExternalAttempt {
  #accumulator = new AssistantStreamAccumulator()
  #assembler = new BlockAssembler()
  #blocks = new Map()
  #index = 0

  constructor(agent, turn, step, number) {
    this.agent = agent; this.turn = turn; this.step = step
    this.attemptId = LlmAttemptId(`${agent.id}:external:${number}`)
    this.agent.emitFrame({ type: 'start', attemptId: this.attemptId, turn, step })
  }
  #push(chunk) {
    const timed = this.#accumulator.push({ time: Date.now(), chunk }); this.#assembler.push(timed.chunk)
    this.agent.emitFrame({ type: 'chunk', attemptId: this.attemptId, index: this.#index++, time: timed.time, chunk: timed.chunk })
  }
  update(value) {
    const update = value.update
    if (update.sessionUpdate !== 'agent_message_chunk' && update.sessionUpdate !== 'agent_thought_chunk') return
    if (update.content?.type !== 'text' || typeof update.content.text !== 'string') throw new Error('external Qwen emitted unsupported assistant content')
    const type = update.sessionUpdate === 'agent_message_chunk' ? 'text' : 'reasoning'
    let block = this.#blocks.get(type)
    if (block === undefined) {
      block = { index: this.#blocks.size, text: '', type }; this.#blocks.set(type, block)
      this.#push({ type: 'block-start', index: block.index, blockType: type })
    }
    block.text += update.content.text
    this.#push({ type: type === 'text' ? 'text-delta' : 'reasoning-delta', index: block.index, text: update.content.text })
  }
  finish() {
    for (const block of this.#blocks.values()) this.#push({ type: 'block-end', index: block.index, block: { type: block.type, text: block.text } })
    this.#push({ type: 'finish', reason: 'stop' })
    const event = this.agent.session.append('assistant/message', { turn: this.turn, step: this.step,
      message: createAssistantMessage({ content: this.#assembler.blocks(), source: { provider: this.agent.provider, model: this.agent.model } }),
      stream: [...this.#accumulator.snapshot()] }, { surfaceOp: 'append' })
    this.agent.emitFrame({ type: 'end', attemptId: this.attemptId, index: this.#index, outcome: { kind: 'committed', eventType: 'assistant/message', seq: event.seq } })
  }
  abandon(interrupted) {
    const content = this.#assembler.interruptedBlocks()
    const event = content.length > 0 ? this.agent.session.append('assistant/message', { turn: this.turn, step: this.step,
      message: createAssistantMessage({ content, source: { provider: this.agent.provider, model: this.agent.model } }),
      stream: [...this.#accumulator.snapshot()], ...(interrupted ? { interrupted: true } : {}) }, { surfaceOp: 'append' })
      : this.agent.session.append('assistant/attempt', { turn: this.turn, step: this.step, stream: [...this.#accumulator.snapshot()] })
    this.agent.emitFrame({ type: 'end', attemptId: this.attemptId, index: this.#index,
      outcome: { kind: 'committed', eventType: event.type, seq: event.seq } })
  }
}

/** Public Agent implementation backed by one supervisor-owned external Qwen handle. */
export class ExternalQwenAgent {
  #abort
  #attempt = 0
  #disposed = false
  #active = false
  #frameRevision = 0
  #maintenance
  #parked = false
  #running
  #retiredPromptOrder = []
  #retiredPrompts = new Set()
  #rootCtx
  #controls = new Set()
  #controlFailure
  #toolCalls = new Map()

  constructor({ ctx, engine, flush, handleId, id, model, nativeSessionId, options, parentAgent, provider, session }) {
    this.id = id; this.options = Object.freeze({ ...options, provider, model }); this.session = session
    this.engine = engine; this.flush = flush; this.handleId = handleId; this.nativeSessionId = nativeSessionId; this.model = model; this.provider = provider
    this.#rootCtx = ctx; this.scope = createScope(ctx, this, parentAgent === undefined ? undefined : { parent: parentAgent }); this.ctx = this.scope.ctx
    this.dispatch = agentEvents(ctx, this); this.inbox = new ExternalInbox(session, this.dispatch)
    this.lastTurn = Math.max(0, ...session.snapshotEvents().filter(event => event.type === 'turn/start').map(event => event.data.turn))
  }
  get status() { return this.#running === undefined ? 'idle' : 'running' }
  emitFrame(frame) { this.dispatch.emit('agent/assistant-stream', { frame: { ...frame, revision: ++this.#frameRevision } }) }
  activate() { this.#assertLive(); if (this.#active) throw new Error('external Agent already activated'); this.#active = true; if (this.inbox.hasPending) this.#wake() }
  send(message, target, wakeup) {
    this.#assertLive(); textContent([message]); this.inbox.append(target, message); if (wakeup && this.#active) this.#wake()
  }
  followup(message) { this.send(message, 'next-turn', true) }
  steer(message) { this.send(message, 'next-step', true) }
  inject(message) { this.send(message, 'next-step', false) }
  cancel(cause, options = {}) {
    if (cause?.kind === 'disposed') this.#parked = true
    if (!options.keepInbox) this.inbox.clear()
    const promptId = this.#running?.promptId; this.#abort?.abort(cause)
    if (promptId !== undefined) this.#trackControl(this.engine.cancel({ handleId: this.handleId, promptId }))
  }
  async whenIdle() {
    const failures = []
    for (;;) {
      const work = [this.#running?.done, this.#maintenance].filter(Boolean)
      try { await Promise.all(work) } catch (error) { failures.push(error) }
      await Promise.allSettled([...this.#controls])
      if (this.#running !== undefined || this.#maintenance !== undefined || this.#controls.size > 0) continue
      if (this.#controlFailure !== undefined) { failures.push(this.#controlFailure); this.#controlFailure = undefined }
      try { await this.flush() } catch (error) { failures.push(error) }
      if (this.#running === undefined && this.#maintenance === undefined && this.#controls.size === 0) break
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'external Agent quiescence failed')
  }
  runMaintenance(job) {
    this.#assertLive(); if (this.#running !== undefined || this.#maintenance !== undefined) throw new Error(`agent "${this.id}" already has active work`)
    const abort = new AbortController(); this.#abort = abort
    return (this.#maintenance = Promise.resolve().then(() => job(abort.signal)).finally(() => { this.#abort = undefined; this.#maintenance = undefined; if (this.inbox.hasPending) this.#wake() }))
  }
  onUpdate(promptId, params) {
    if (params.sessionId !== this.nativeSessionId) throw new Error('external Qwen update has the wrong native session identity')
    if (this.#running?.promptId !== promptId) {
      if (this.#retiredPrompts.has(promptId)) return
      throw new Error('external Qwen update does not match the active prompt')
    }
    this.#running.attempt.update(params); this.#toolUpdate(params.update)
  }
  async requestPermission(promptId, params) {
    const running = this.#running; const abort = this.#abort
    if (running?.promptId !== promptId || abort === undefined) return { outcome: { outcome: 'cancelled' } }
    if (params.sessionId !== this.nativeSessionId) return { outcome: { outcome: 'cancelled' } }
    const approval = this.ctx.get('approval'); const callId = params.toolCall?.toolCallId
    if (approval === undefined || typeof callId !== 'string') return { outcome: { outcome: 'cancelled' } }
    const result = await approval.request({ agent: this, callId: ToolCallId(callId), toolName: params.toolCall.title ?? 'external-tool', signal: abort.signal })
    if (this.#disposed || this.#running !== running || running.promptId !== promptId || abort.signal.aborted) return { outcome: { outcome: 'cancelled' } }
    if (result !== 'allowed-once' && result !== 'rejected') return { outcome: { outcome: 'cancelled' } }
    const wanted = result === 'allowed-once' ? 'allow_once' : 'reject_once'
    const option = params.options.find(value => value.kind === wanted)
    return option === undefined ? { outcome: { outcome: 'cancelled' } } : { outcome: { outcome: 'selected', optionId: option.optionId } }
  }
  async dispose() {
    this.#disposed = true; this.cancel({ kind: 'disposed' }, { keepInbox: true }); const failures = []
    try { await this.whenIdle() } catch (error) { failures.push(error) }
    try { await this.engine.dispose({ handleId: this.handleId }) } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'external Agent disposal failed')
  }

  #assertLive() { if (this.#disposed) throw new Error(`external agent "${this.id}" is disposed`) }
  #trackControl(operation) {
    const task = Promise.resolve(operation); this.#controls.add(task)
    task.catch(error => { this.#controlFailure ??= error }).finally(() => this.#controls.delete(task))
  }
  #wake() {
    if (!this.#active || this.#disposed || this.#parked || this.#running !== undefined || this.#maintenance !== undefined) return
    const running = { done: undefined, promptId: undefined, attempt: undefined }; this.#running = running
    const operation = this.#drive(running)
    this.dispatch.emit('agent/status', { status: 'running' })
    running.done = operation.finally(() => {
      if (running.promptId !== undefined) this.#retirePrompt(running.promptId)
      if (this.#running === running) this.#running = undefined
      this.#abort = undefined; this.dispatch.emit('agent/status', { status: 'idle' }); if (this.inbox.hasPending) this.#wake()
    })
    void running.done.catch(() => {})
  }
  async #drive(running) {
    const turn = ++this.lastTurn; const step = 1; const abort = new AbortController(); this.#abort = abort
    this.session.append('turn/start', { turn }); const messages = this.inbox.claim(turn)
    if (messages.length === 0) { this.session.append('turn/end', { turn, reason: { kind: 'completed' } }); return }
    this.session.append('step/start', { turn, step }); for (const message of messages) this.session.append('user/message', message, { surfaceOp: 'append' })
    const recovery = new ToolCallRecovery(); const stopRecovery = this.#rootCtx.on('session/event', (session, event) => { if (session === this.session) recovery.observe(event) })
    const promptId = `${this.id}:${turn}:${step}`; const attempt = new ExternalAttempt(this, turn, step, ++this.#attempt)
    running.promptId = promptId; running.attempt = attempt
    let promptError
    try {
      await this.engine.prompt({ prompt: textContent(messages) }, { handleId: this.handleId, promptId, signal: abort.signal })
      abort.signal.throwIfAborted(); attempt.finish()
    } catch (error) {
      promptError = error; attempt.abandon(abort.signal.aborted)
    }
    try {
      for (const event of recovery.results()) this.session.append('tool/result', event.data, { surfaceOp: 'append',
        ...event.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: event.sourceEventSeqs } })
    } finally { stopRecovery() }
    this.session.append('step/end', { turn, step })
    if (promptError === undefined) this.session.append('turn/end', { turn, reason: { kind: 'completed' } })
    else {
      const reason = abort.signal.aborted ? { kind: 'aborted', reason: abort.signal.reason } : { kind: 'error', error: failure(promptError) }
      this.session.append('turn/end', { turn, reason })
      if (!abort.signal.aborted) { this.dispatch.emit('agent/error', { turn, step, error: promptError }); throw promptError }
    }
  }
  #toolUpdate(update) {
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return
    const callId = ToolCallId(update.toolCallId); let record = this.#toolCalls.get(callId)
    if (record === undefined) {
      const name = update.title ?? 'external-tool'; const arguments_ = JSON.stringify(update.rawInput ?? {})
      record = { complete: false }; this.#toolCalls.set(callId, record)
      this.session.append('assistant/message', { turn: this.lastTurn, step: 1,
        message: createAssistantMessage({ content: [{ type: 'tool-call', id: callId, name, arguments: arguments_ }], source: { provider: this.provider, model: this.model } }) }, { surfaceOp: 'append' })
      this.session.append('tool/call', { turn: this.lastTurn, step: 1, callId, name, arguments: arguments_ })
    }
    if (!record.complete && (update.status === 'completed' || update.status === 'failed')) {
      record.complete = true; const content = [{ type: 'text', text: JSON.stringify(update.content ?? update.rawOutput ?? '') }]
      this.session.append('tool/result', { turn: this.lastTurn, step: 1,
        message: createToolResultMessage({ callId, content, isError: update.status === 'failed' }) }, { surfaceOp: 'append' })
    }
  }
  #retirePrompt(promptId) {
    if (this.#retiredPrompts.has(promptId)) return
    this.#retiredPrompts.add(promptId); this.#retiredPromptOrder.push(promptId)
    if (this.#retiredPromptOrder.length > 64) this.#retiredPrompts.delete(this.#retiredPromptOrder.shift())
  }
}
