import { Context } from '@deepseek-ai/cordis'
import Loader from '../../../vendor/loader/src/index.ts'
import { expect, it, vi } from 'vitest'

function plugin(counter: { value: number }) {
  return () => { counter.value += 1 }
}

it('rejects before provider code or persistent mutation and retains the accepted row', async () => {
  const ctx = new Context()
  const denied = { value: 0 }
  const allowed = { value: 0 }
  await ctx.plugin(Loader, { baseUrl: import.meta.url }).await()
  ctx.loader.builtins.denied = plugin(denied)
  ctx.loader.builtins.allowed = plugin(allowed)
  const phases: string[] = []
  ctx.on('loader/entry-admit', (candidate, next) => {
    phases.push(candidate.phase)
    if (candidate.options.name === 'cordis:denied' && !candidate.effectiveDisabled) throw new Error('policy denied')
    next()
  }, { global: true, prepend: true })

  await expect(ctx.loader.create({ name: 'cordis:denied' })).rejects.toThrow('policy denied')
  expect(denied.value).toBe(0)
  expect(ctx.loader.root.data).toEqual([])
  expect(Object.keys(ctx.loader.store)).toEqual([])

  await ctx.loader.root.update([{ id: 'safe', name: 'cordis:allowed', config: { revision: 1 } }])
  await ctx.loader.await()
  expect(allowed.value).toBe(1)
  await ctx.loader.root.update([
    { id: 'safe', name: 'cordis:allowed', config: { revision: 2 } },
    { id: 'protected', name: 'cordis:denied' },
  ])
  expect(ctx.loader.root.data).toEqual([{ id: 'safe', name: 'cordis:allowed', config: { revision: 2 } }])
  expect(denied.value).toBe(0)
  expect(phases).toContain('pre-import')
  expect(phases).toContain('pre-activate')
  await ctx.fiber.dispose()
})

it('rechecks after an asynchronous import before activation', async () => {
  const ctx = new Context()
  await ctx.plugin(Loader, { baseUrl: import.meta.url }).await()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const activated = vi.fn()
  ctx.loader.builtins.race = (async () => {
    entered.resolve()
    await release.promise
    return activated
  })()
  let deny = false
  ctx.on('loader/entry-admit', (candidate, next) => {
    if (candidate.phase === 'pre-activate' && deny) throw new Error('late denial')
    next()
  }, { global: true, prepend: true })
  const creation = ctx.loader.create({ name: 'cordis:race' })
  await entered.promise
  deny = true
  release.resolve()
  await expect(creation).rejects.toThrow('late denial')
  expect(activated).not.toHaveBeenCalled()
  await ctx.fiber.dispose()
})
