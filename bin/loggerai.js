#!/usr/bin/env node
'use strict'
// npx @loggerai/node test: check this machine can send to LoggerAI.

const loggerai = require('../src/index')

async function test() {
  const key = process.env.LOGGERAI_KEY || ''
  console.log(`@loggerai/node ${loggerai.VERSION}`)
  console.log(`LOGGERAI_KEY: ${key ? key.slice(0, 12) + '…' : '(not set)'}`)
  const client = loggerai.init({ quiet: true, hostMetrics: false, captureConsole: false, healthChecks: { 'loggerai-test': () => true } })
  console.log(`endpoint: ${client.endpoint}`)
  console.log(`service: ${client.service} · environment: ${client.environment} · release: ${client.release || '(none)'}`)
  if (!client.enabled) {
    console.log('Not sending: set LOGGERAI_KEY to the project\'s secret key (sk_live_…) from LoggerAI → Connect.')
    return 1
  }
  await loggerai.track('command', 'loggerai test', () => {})
  const sent = await client.flush(10000)
  await client.close(100)
  if (client.lastError || !sent) {
    console.log(`Failed: ${client.lastError || 'timed out'}`)
    return 1
  }
  console.log('Sent. The project in LoggerAI shows as connected within a few seconds.')
  return 0
}

if (process.argv[2] !== 'test') {
  console.log('usage: npx @loggerai/node test')
  process.exit(2)
}
test().then((code) => process.exit(code), (e) => {
  console.error(e)
  process.exit(1)
})
