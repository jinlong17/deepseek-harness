import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createEligibilityFiles } from './external-session-eligibility-files.mjs'
import { createExternalSessionEligibilityStore } from './external-session-eligibility.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'external-eligibility-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const persistenceRoot = join(root, 'sessions'); mkdirSync(persistenceRoot)
  const eligibilityRoot = join(root, 'receipts')
  const store = createExternalSessionEligibilityStore({ eligibilityRoot, mode: 'developer', persistenceRoot, persistenceScope: persistenceRoot })
  const handle = { header: { version: 4, id: 'session-1', createdAt: 1, isSeeded: false }, inheritedEventCount: 0 }
  const events = [{ seq: 0, type: 'agent/external-engine-bound', data: { version: 1, engineId: 'qwen', nativeSessionId: 'native-1', artifactIdentity: 'tree' } }]
  return { eligibilityRoot, events, handle, persistenceRoot, root, store }
}

test('prepared births are ineligible until synchronous commit and revocation stays ineligible', async t => {
  const { events, handle, store } = fixture(t)
  const prepared = await store.prepareBirth({ ownedCreateHandle: handle, events })
  assert.throws(() => store.verifyCommitted({ ownedWriteHandle: handle, events }), /not committed/)
  prepared.commitSync(); assert.deepEqual(store.verifyCommitted({ ownedWriteHandle: handle, events }).prefixLength, 1)
  prepared.rejectSync('notification-refused'); assert.throws(() => store.verifyCommitted({ ownedWriteHandle: handle, events }), /not committed/)
})

test('accepted births retain eligibility while append-only history grows', async t => {
  const { events, handle, store } = fixture(t); const birth = await store.prepareBirth({ ownedCreateHandle: handle, events })
  birth.commitSync(); birth.accept(); assert.throws(() => birth.rejectSync('late'), /cannot be revoked/)
  const appended = [...events, { seq: 1, type: 'turn/start', data: { turn: 1 } }]
  assert.equal(store.verifyCommitted({ ownedWriteHandle: handle, events: appended }).prefixLength, 1)
})

test('receipt identity refuses altered cut, prefix, header, mode and malformed bytes', async t => {
  const { eligibilityRoot, events, handle, persistenceRoot, store } = fixture(t); const birth = await store.prepareBirth({ ownedCreateHandle: handle, events }); birth.commitSync(); birth.accept()
  assert.throws(() => store.verifyCommitted({ ownedWriteHandle: { ...handle, inheritedEventCount: 1 }, events }), /inheritedEventCount/)
  assert.throws(() => store.verifyCommitted({ ownedWriteHandle: handle, events: [{ ...events[0], data: { ...events[0].data, nativeSessionId: 'other' } }] }), /bindingSha256|prefixSha256/)
  assert.throws(() => store.verifyCommitted({ ownedWriteHandle: { ...handle, header: { ...handle.header, createdAt: 2 } }, events }), /headerSha256/)
  const otherMode = createExternalSessionEligibilityStore({ eligibilityRoot, mode: 'consumer', persistenceRoot, persistenceScope: persistenceRoot })
  assert.throws(() => otherMode.verifyCommitted({ ownedWriteHandle: handle, events }), /ENOENT|not committed/)
  const receipt = join(eligibilityRoot, readdirSync(eligibilityRoot).find(name => name.endsWith('.receipt'))); writeFileSync(receipt, `${readFileSync(receipt, 'utf8').trim()} `)
  assert.throws(() => store.verifyCommitted({ ownedWriteHandle: handle, events }), /schema is invalid/)
})

test('construction refuses overlapping, private and symbolic root layouts before marker IO', t => {
  const root = mkdtempSync(join(tmpdir(), 'external-eligibility-path-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const sessions = join(root, 'sessions'); mkdirSync(sessions)
  const make = eligibilityRoot => createExternalSessionEligibilityStore({ eligibilityRoot, mode: 'developer', persistenceRoot: sessions, persistenceScope: sessions })
  assert.throws(() => make(sessions), /disjoint/); assert.throws(() => make(join(sessions, 'receipts')), /disjoint/)
  assert.throws(() => createExternalSessionEligibilityStore({ eligibilityRoot: root, mode: 'developer', persistenceRoot: join(root, 'sessions', 'nested'), persistenceScope: sessions }), /disjoint/)
  assert.throws(() => make(join(root, '.private', 'receipts')), /private/)
  const alias = join(root, 'alias'); symlinkSync(sessions, alias); assert.throws(() => make(alias), /symbolic link/)
  assert.deepEqual(readdirSync(sessions), [])
})

test('a post-rename commit error revokes the exact committed nonce before reporting failure', async t => {
  const { eligibilityRoot, events, handle, persistenceRoot } = fixture(t); const real = createEligibilityFiles({ eligibilityRoot, persistenceRoot })
  let commit = true; const faulting = { ...real, replaceOwned(...args) { const result = real.replaceOwned(...args); if (commit && args[2] === undefined) { commit = false; throw new Error('synthetic directory fsync ambiguity') }; return result } }
  const store = createExternalSessionEligibilityStore({ eligibilityRoot, mode: 'developer', persistenceRoot, persistenceScope: persistenceRoot }, faulting)
  const birth = await store.prepareBirth({ ownedCreateHandle: handle, events })
  assert.throws(() => birth.commitSync(), /synthetic directory fsync ambiguity/); assert.equal(birth.state(), 'revoked')
  assert.throws(() => store.verifyCommitted({ ownedWriteHandle: handle, events }), /not committed/)
})

test('an ambiguous commit whose exact receipt cannot be revoked is fatal and remains explicit', async t => {
  const { eligibilityRoot, events, handle, persistenceRoot } = fixture(t); const real = createEligibilityFiles({ eligibilityRoot, persistenceRoot })
  let commit = true; const faulting = { ...real, replaceOwned(...args) {
    if (args[2] !== undefined) throw new Error('synthetic revoke failure')
    const result = real.replaceOwned(...args); if (commit) { commit = false; throw new Error('synthetic directory fsync ambiguity') }; return result
  } }
  const store = createExternalSessionEligibilityStore({ eligibilityRoot, mode: 'developer', persistenceRoot, persistenceScope: persistenceRoot }, faulting)
  const birth = await store.prepareBirth({ ownedCreateHandle: handle, events })
  assert.throws(() => birth.commitSync(), error => error?.eligibilityFatal === true && /uncertain/.test(error.message)); assert.equal(birth.state(), 'uncertain')
  assert.equal(store.verifyCommitted({ ownedWriteHandle: handle, events }).prefixLength, 1)
})

test('a committed birth whose later rejection cannot be revoked becomes fatal', async t => {
  const { eligibilityRoot, events, handle, persistenceRoot } = fixture(t); const real = createEligibilityFiles({ eligibilityRoot, persistenceRoot })
  const faulting = { ...real, replaceOwned(...args) { if (args[2] !== undefined) throw new Error('synthetic rejection revoke failure'); return real.replaceOwned(...args) } }
  const store = createExternalSessionEligibilityStore({ eligibilityRoot, mode: 'developer', persistenceRoot, persistenceScope: persistenceRoot }, faulting)
  const birth = await store.prepareBirth({ ownedCreateHandle: handle, events }); birth.commitSync()
  assert.throws(() => birth.rejectSync('notification-refused'), error => error?.eligibilityFatal === true && /uncertain/.test(error.message))
  assert.equal(birth.state(), 'uncertain'); assert.equal(store.verifyCommitted({ ownedWriteHandle: handle, events }).prefixLength, 1)
})
