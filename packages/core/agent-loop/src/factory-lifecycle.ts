import type { AgentHandle, AgentOptions, SessionStartSource } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import { Context, FiberState } from '@deepseek-ai/cordis'
import type { ReactLoopAgent } from './agent.ts'

const INACTIVE_STATES: ReadonlySet<FiberState> = new Set([FiberState.UNLOADING, FiberState.DISPOSED, FiberState.FAILED])

/** Factory-level ownership: live agent teardowns plus config startup work. */
export class FactoryOwnership {
  private accepting = true
  private readonly teardown = new AbortController()
  private readonly inactive = Promise.withResolvers<void>()
  private readonly liveAgents = new Set<() => Promise<void>>()
  private startupTasks = new Set<Promise<void>>()
  constructor(private readonly fiber: Context['fiber']) {}
  get signal(): AbortSignal { return this.teardown.signal }
  isActive(): boolean { return this.accepting && !INACTIVE_STATES.has(this.fiber.state) }
  track(dispose: () => Promise<void>): () => void { this.liveAgents.add(dispose); return () => { this.liveAgents.delete(dispose) } }
  trackStartup(job: Promise<void>): void {
    this.startupTasks.add(job); const forget = () => { this.startupTasks.delete(job) }; void job.then(forget, forget)
  }
  trackWrapper(job: Promise<unknown>): void { this.trackStartup(job.then(() => undefined, () => undefined)) }
  async waitWhileActive(job: Promise<void>): Promise<void> { await Promise.race([job, this.inactive.promise]) }
  async dispose(): Promise<void> {
    this.accepting = false; this.teardown.abort(new Error('agent loop is not active')); this.inactive.resolve()
    await Promise.all([...[...this.liveAgents].map(dispose => dispose()), ...this.startupTasks])
  }
}

/** Await an operation, or throw the caller/lifecycle abort reason. */
export async function raceAbort<T>(operation: PromiseLike<T> | T, signal: AbortSignal, id: SessionId): Promise<T> {
  const toAbortError = (): Error => signal.reason instanceof Error ? signal.reason : new Error(`agent "${id}" creation aborted`, { cause: signal.reason })
  if (signal.aborted) throw toAbortError()
  const aborted = Promise.withResolvers<never>(); const listener = (): void => { aborted.reject(toAbortError()) }
  signal.addEventListener('abort', listener, { once: true })
  try { return await Promise.race([Promise.resolve(operation), aborted.promise]) } finally { signal.removeEventListener('abort', listener) }
}

/** Start an abortable operation and release a value that arrives after cancellation. */
export async function raceAbortCall<T>(operation: () => PromiseLike<T> | T, signal: AbortSignal, id: SessionId, releaseAbandoned?: (value: T) => void): Promise<T> {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error(`agent "${id}" creation aborted`, { cause: signal.reason })
  const pending = Promise.resolve().then(operation)
  try { return await raceAbort(pending, signal, id) } catch (error: unknown) {
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- signal may abort while awaited.
    if (signal.aborted && releaseAbandoned !== undefined) void pending.then(releaseAbandoned, () => undefined)
    throw error
  }
}

export function assertAgentOptions(options: AgentOptions): void {
  if (options.maxTokens !== undefined && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0)) {
    throw new TypeError('agent maxTokens must be a positive safe integer')
  }
}

export interface StoredSession { readonly handle: SessionHandle; storedCount: number }
export interface PreparedAgent {
  agent: ReactLoopAgent
  signal: AbortSignal
  publish(source: SessionStartSource): Promise<AgentHandle>
  dispose(): Promise<void>
}
