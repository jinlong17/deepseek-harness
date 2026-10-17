import { Context, Service } from '@deepseek-ai/cordis'
import { Entry, type EntryOptions } from './entry.ts'
import { EntryTree } from './tree.ts'

/** Runtime owner for a list of child loader entries. */
export class EntryGroup {
  static readonly key = Symbol.for('cordis.group')

  public data: EntryOptions[] = []

  constructor(public ctx: Context, public tree: EntryTree) {
    const entry = ctx.fiber.entry
    if (entry) entry.subgroup = this
  }

  get context(): Context {
    return this.ctx
  }

  async create(options: Omit<EntryOptions, 'id'>) {
    const id = this.tree.ensureId(options)
    const existed = this.tree.store[id]
    const entry: Entry = existed ?? (this.tree.store[id] = new Entry(this.ctx.loader))
    const legacyParent = entry.parent
    // Entry may be moved from another group,
    // so we need to update the parent reference.
    entry.parent = this
    // Use `create: true` to replace existing entry.options.
    try {
      await entry.update(options, true, true)
    } catch (error) {
      if (!existed) delete this.tree.store[id]
      else entry.parent = legacyParent
      throw error
    }
    return entry.id
  }

  unlink(options: EntryOptions) {
    const config = this.data
    const index = config.indexOf(options)
    if (index >= 0) config.splice(index, 1)
  }

  remove(id: string, isDispose = false) {
    const entry = this.tree.store[id]
    if (!entry) return
    if (!isDispose) entry.admitRemoval()
    entry.fiber?.dispose()
    if (!isDispose) {
      this.unlink(entry.options)
    }
    delete this.tree.store[id]
    this.context.emit('loader/partial-dispose', entry, entry.options, false)
  }

  async update(config: EntryOptions[]) {
    const oldConfig = this.data as EntryOptions[]
    const oldMap = Object.fromEntries(oldConfig.map(options => [options.id, options]))
    const newMap = Object.fromEntries(config.map(options => [options.id ?? Symbol('anonymous'), options]))
    const accepted = new Map<string, EntryOptions>()
    const ids = Reflect.ownKeys({ ...oldMap, ...newMap }) as string[]
    for (const id of ids) {
      if (newMap[id]) {
        try {
          await this.create(newMap[id])
          accepted.set(id, newMap[id])
        } catch (error) {
          this.ctx.logger.error(error)
          if (oldMap[id]) accepted.set(id, oldMap[id])
        }
      } else {
        try { this.remove(id) } catch (error) {
          this.ctx.logger.error(error)
          accepted.set(id, oldMap[id])
        }
      }
    }
    this.data = [
      ...config.flatMap(row => accepted.get(row.id) ? [accepted.get(row.id)!] : []),
      ...oldConfig.filter(row => accepted.has(row.id) && !newMap[row.id]).map(row => accepted.get(row.id)!),
    ]
  }

  stop() {
    for (const options of this.data) {
      this.remove(options.id, true)
    }
  }
}

/** Plugin that mounts a nested loader entry group. */
export class Group extends EntryGroup {
  static initial: Omit<EntryOptions, 'id'>[] = []
  static readonly [EntryGroup.key] = true

  constructor(public ctx: Context, public config: EntryOptions[]) {
    super(ctx, ctx.fiber.entry!.parent.tree)
    ctx.on('internal/update', (config) => {
      this.update(config)
    })
  }

  async* [Service.init]() {
    yield () => this.stop()
    await this.update(this.config)
  }
}
