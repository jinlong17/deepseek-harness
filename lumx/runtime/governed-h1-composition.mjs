import { installGovernedH1SessionPolicy } from './governed-session-policy.mjs'
import { installLumxGovernance } from './governance.mjs'

/** Install the root-owned policies required by every governed-H1 product host. */
export function installGovernedH1Composition(ctx) {
  const governance = installLumxGovernance(ctx)
  const sessionPolicy = installGovernedH1SessionPolicy(ctx)
  return Object.freeze({
    assertAgent: sessionPolicy.assertAgent,
    rows: governance.rows,
    assertReady() {
      governance.assertReady()
      sessionPolicy.assertReady()
    },
  })
}
