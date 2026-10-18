import { agentEvents } from '../../packages/core/agent/lib/index.js'
import { createScope } from '../../packages/core/scope/lib/index.js'
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
  #frameRevision = 0
  #maintenance
  #running
  #toolCalls = new Map()

  constructor({ ctx, engine, handleId, id, model, nativeSessionId, options, parentAgent, provider, session }) {
    this.id = id; this.options = Object.freeze({ ...options, provider, model }); this.session = session
    this.engine = engine; this.handleId = handleId; this.nativeSessionId = nativeSessionId; this.model = model; this.provider = provider
    this.scope = createScope(ctx, this, parentAgent === undefined ? undefined : { parent: parentAgent }); this.ctx = this.scope.ctx
    this.dispatch = agentEvents(ctx, this); this.inbox = new ExternalInbox(session, this.dispatch)
    this.lastTurn = Math.max(0, ...session.snapshotEvents().filter(event => event.type === 'turn/start').map(event => event.data.turn))
  }
  get status() { return this.#running === undefined ? 'idle' : 'running' }
  emitFrame(frame) { this.dispatch.emit('agent/assistant-stream', { frame: { ...frame, revision: ++this.#frameRevision } }) }
  send(message, target, wakeup) { this.#assertLive(); this.inbox.append(target, message); if (wakeup) this.#wake() }
  followup(message) { this.send(message, 'next-turn', true) }
  steer(message) { this.send(message, 'next-step', true) }
  inject(message) { this.send(message, 'next-step', false) }
  cancel(cause, options = {}) {
    if (!options.keepInbox) this.inbox.clear()
    this.#abort?.abort(cause); if (this.#abort !== undefined) void this.engine.cancel({ handleId: this.handleId, promptId: this.#running?.promptId ?? 'none' }).catch(() => {})
  }
  whenIdle() { return this.#running?.done ?? this.#maintenance ?? Promise.resolve() }
  runMaintenance(job) {
    this.#assertLive(); if (this.#running !== undefined || this.#maintenance !== undefined) throw new Error(`agent "${this.id}" already has active work`)
    const abort = new AbortController(); this.#abort = abort
    return (this.#maintenance = Promise.resolve().then(() => job(abort.signal)).finally(() => { this.#abort = undefined; this.#maintenance = undefined; if (this.inbox.hasPending) this.#wake() }))
  }
  onUpdate(promptId, params) {
    if (this.#running?.promptId !== promptId) throw new Error('external Qwen update does not match the active prompt')
    this.#running.attempt.update(params); this.#toolUpdate(params.update)
  }
  async requestPermission(promptId, params) {
    if (this.#running?.promptId !== promptId) return { outcome: { outcome: 'cancelled' } }
    const approval = this.ctx.get('approval'); const callId = params.toolCall?.toolCallId
    if (approval === undefined || typeof callId !== 'string') return { outcome: { outcome: 'cancelled' } }
    const result = await approval.request({ agent: this, callId: ToolCallId(callId), toolName: params.toolCall.title ?? 'external-tool' })
    if (result !== 'allowed-once' && result !== 'rejected') return { outcome: { outcome: 'cancelled' } }
    const wanted = result === 'allowed-once' ? 'allow_once' : 'reject_once'
    const option = params.options.find(value => value.kind === wanted)
    return option === undefined ? { outcome: { outcome: 'cancelled' } } : { outcome: { outcome: 'selected', optionId: option.optionId } }
  }
  async dispose() { this.#disposed = true; this.cancel({ kind: 'disposed' }, { keepInbox: true }); await this.whenIdle().catch(() => {}); return this.engine.dispose({ handleId: this.handleId }) }

  #assertLive() { if (this.#disposed) throw new Error(`external agent "${this.id}" is disposed`) }
  #wake() {
    if (this.#disposed || this.#running !== undefined || this.#maintenance !== undefined) return
    const running = { done: undefined, promptId: undefined, attempt: undefined }; this.#running = running
    const done = this.#drive(running); running.done = done
    this.dispatch.emit('agent/status', { status: 'running' })
    void done.finally(() => { this.#running = undefined; this.#abort = undefined; this.dispatch.emit('agent/status', { status: 'idle' }); if (this.inbox.hasPending) this.#wake() }).catch(() => {})
  }
  async #drive(running) {
    const turn = ++this.lastTurn; const step = 1; const abort = new AbortController(); this.#abort = abort
    this.session.append('turn/start', { turn }); const messages = this.inbox.claim(turn)
    if (messages.length === 0) { this.session.append('turn/end', { turn, reason: { kind: 'completed' } }); return }
    this.session.append('step/start', { turn, step }); for (const message of messages) this.session.append('user/message', message, { surfaceOp: 'append' })
    const promptId = `${this.id}:${turn}:${step}`; const attempt = new ExternalAttempt(this, turn, step, ++this.#attempt)
    running.promptId = promptId; running.attempt = attempt
    try {
      await this.engine.prompt({ prompt: textContent(messages) }, { handleId: this.handleId, promptId, signal: abort.signal })
      abort.signal.throwIfAborted(); attempt.finish(); this.session.append('step/end', { turn, step }); this.session.append('turn/end', { turn, reason: { kind: 'completed' } })
    } catch (error) {
      attempt.abandon(abort.signal.aborted); this.session.append('step/end', { turn, step })
      const reason = abort.signal.aborted ? { kind: 'aborted', reason: abort.signal.reason } : { kind: 'error', error: failure(error) }
      this.session.append('turn/end', { turn, reason }); if (!abort.signal.aborted) this.dispatch.emit('agent/error', { turn, step, error }); throw error
    }
  }
  #toolUpdate(update) {
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return
    const callId = ToolCallId(update.toolCallId); let record = this.#toolCalls.get(callId)
    if (record === undefined) {
      record = { complete: false }; this.#toolCalls.set(callId, record)
      this.session.append('tool/call', { turn: this.lastTurn, step: 1, callId, name: update.title ?? 'external-tool', arguments: JSON.stringify(update.rawInput ?? {}) })
    }
    if (!record.complete && (update.status === 'completed' || update.status === 'failed')) {
      record.complete = true; const content = [{ type: 'text', text: JSON.stringify(update.content ?? update.rawOutput ?? '') }]
      this.session.append('tool/result', { turn: this.lastTurn, step: 1,
        message: createToolResultMessage({ callId, content, isError: update.status === 'failed' }) })
    }
  }
}
