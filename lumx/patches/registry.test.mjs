import assert from 'node:assert/strict'
import test from 'node:test'

import { assertProductPatchBudget, listProductPatches, PATCH_BUDGET } from './registry.mjs'

test('product patches fit the desktop budget and record their removal path', () => {
  assert.doesNotThrow(assertProductPatchBudget)
  const patches = listProductPatches()
  assert.equal(patches.length, 1)
  assert.equal(PATCH_BUDGET, 12)
  assert.match(patches[0].removal, /Remove/)
  assert.deepEqual(patches[0].removalPaths, ['lumx/desktop/', 'lumx/identity/', 'lumx/patches/registry.mjs'])
  assert.match(patches[0].tests.join('\n'), /node --test/)
})
