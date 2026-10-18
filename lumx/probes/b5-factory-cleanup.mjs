function aggregate(primary, failures) {
  if (primary !== undefined && failures.length) {
    throw new AggregateError([primary, ...failures], 'controller failure plus cleanup failure')
  }
  if (primary !== undefined) throw primary
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'controller cleanup failed')
}

export function requireB5HostFactory(factory) {
  if (
    typeof factory?.makeB5HostLaunchInput !== 'function'
    || typeof factory.runB5HostScenario !== 'function'
    || typeof factory.closeB5HostFactory !== 'function'
  ) {
    throw new Error('controller module contract')
  }
  return factory
}

export async function closeB5HostOwners({ host, retained, factory, primary }) {
  const failures = []
  for (const close of [
    host === undefined ? undefined : () => host.shutdown(),
    retained === undefined ? undefined : () => retained.cleanup(),
    factory === undefined ? undefined : () => factory.closeB5HostFactory(),
  ]) {
    if (close === undefined) continue
    try {
      await close()
    } catch (error) {
      failures.push(error)
    }
  }
  aggregate(primary, failures)
}
