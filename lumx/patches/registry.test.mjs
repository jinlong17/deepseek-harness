import assert from 'node:assert/strict'
import test from 'node:test'

import { assertProductPatchBudget, listProductPatches, PATCH_BUDGET } from './registry.mjs'

test('product patches fit the desktop budget and record their removal path', () => {
  assert.doesNotThrow(assertProductPatchBudget)
  const patches = listProductPatches()
  assert.equal(patches.length, 9)
  assert.equal(PATCH_BUDGET, 12)
  assert.match(patches[0].removal, /Remove/)
  assert.deepEqual(patches[0].removalPaths, ['lumx/desktop/', 'lumx/identity/', 'lumx/patches/registry.mjs'])
  assert.match(patches[0].tests.join('\n'), /node --test/)
  assert.deepEqual(patches.map(patch => patch.id), [
    'G9-1-B1', 'G9-1-B2', 'G9-1-P4', 'G9-1-P5', 'G9-1-P6', 'G9-1-P7', 'G9-1-P8', 'G9-1-P9', 'G9-1-P3',
  ])
  assert.deepEqual(patches[1].removalPaths, ['lumx/runtime/', 'lumx/patches/registry.mjs'])
  assert.match(patches[5].purpose, /Broker-only/)
  assert.match(patches[5].upstream, /P4\/P5/)
  assert.match(patches[6].removalPaths.join('\n'), /external-engine-owner/)
  assert.match(patches[7].purpose, /ownership refusal/)
  assert.match(patches[8].tests.join('\n'), /native-host/)
})
