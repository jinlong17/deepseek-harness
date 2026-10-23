import assert from 'node:assert/strict'
import { test } from 'node:test'

import { PROTOCOL_VERSION } from '../../apps/cli/node_modules/@agentclientprotocol/sdk/dist/acp.js'
import { initialize } from './b5-external-qwen-support.mjs'

const host = () => ({
  protocolVersion: PROTOCOL_VERSION,
  agentCapabilities: { sessionCapabilities: { resume: {}, list: {}, close: {} } },
})
const client = response => ({ connection: { initialize: async () => response } })

test('official Host ACP accepts the three session capabilities without engine loadSession', async () => {
  assert.deepEqual(await initialize(client(host())), host())
})

test('official Host ACP rejects an incorrect protocol version', async () => {
  await assert.rejects(initialize(client({ ...host(), protocolVersion: -1 })), /Host ACP session capabilities mismatch/)
})

for (const name of ['resume', 'list', 'close']) {
  test(`official Host ACP rejects missing or malformed ${name}`, async () => {
    for (const value of [undefined, null, true, false, [], 'enabled']) {
      const response = host()
      if (value === undefined) delete response.agentCapabilities.sessionCapabilities[name]
      else response.agentCapabilities.sessionCapabilities[name] = value
      await assert.rejects(initialize(client(response)), /Host ACP session capabilities mismatch/)
    }
  })
}

test('engine loadSession cannot replace Host resume', async () => {
  const response = host()
  delete response.agentCapabilities.sessionCapabilities.resume
  response.agentCapabilities.loadSession = true
  await assert.rejects(initialize(client(response)), /Host ACP session capabilities mismatch/)
})
