const PORT = Number(process.env.PORT || 8787)
// End-to-end protocol test: speak the gateway's WebSocket dialect to the brain.
// Run: JARVIS_ALLOW_NO_ORIGIN=1 node bridge/server.mjs &  then  node test-brain.mjs
import { WebSocket } from 'ws'

const ws = new WebSocket(`ws://localhost:${PORT}/`)
const waiters = []

function next(pred, label, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const w = { pred, resolve, label }
    waiters.push(w)
    setTimeout(() => {
      if (waiters.includes(w)) {
        reject(new Error(`timeout waiting for ${label}`))
      }
    }, timeoutMs)
  })
}

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString())
  // console.log('<<', JSON.stringify(msg).slice(0, 160))
  for (let i = waiters.length - 1; i >= 0; i--) {
    if (waiters[i].pred(msg)) {
      const w = waiters.splice(i, 1)[0]
      w.resolve(msg)
    }
  }
})

ws.on('open', async () => {
  try {
    const ready = await next((m) => m.type === 'ready', 'ready')
    console.log('READY servers:', ready.servers.join(','))

    // --- Turn 1: plain Q&A with streaming ---
    ws.send(JSON.stringify({ type: 'ask', text: 'In one short sentence: what is the speed of light?', id: 'a1' }))
    let text = ''
    let gotFirstDelta = false
    const t1 = Date.now()
    while (true) {
      const m = await next((m) => m.type === 'text' && m.ask === 'a1', 'text a1')
      if (!gotFirstDelta) { gotFirstDelta = true; console.log(`first delta after ${Date.now() - t1}ms`) }
      text += m.delta
      // race with done — done arrives via a different waiter
      break
    }
    const done1 = await next((m) => m.type === 'done' && m.ask === 'a1', 'done a1')
    console.log('TURN1 done text:', JSON.stringify(done1.text).slice(0, 120))

    // --- Turn 2: tool use (image_search + blade) ---
    ws.send(JSON.stringify({ type: 'ask', text: 'Show me some pictures of the SR-71 Blackbird.', id: 'a2' }))
    const badge = await next((m) => m.type === 'tool' && m.ask === 'a2', 'tool badge a2')
    console.log('TURN2 tool badge:', badge.name)
    const blade = await next((m) => m.type === 'blade', 'blade a2')
    console.log('TURN2 blade:', blade.blade.kind, blade.blade.title, 'images:', blade.blade.images?.length ?? 0, 'size:', blade.blade.size)
    const done2 = await next((m) => m.type === 'done' && m.ask === 'a2', 'done a2')
    console.log('TURN2 done:', JSON.stringify(done2.text).slice(0, 120))

    // --- Turn 3: ui control ---
    ws.send(JSON.stringify({ type: 'ask', text: 'Turn the interface amber for a moment, then answer with just: done.', id: 'a3' }))
    const ui = await next((m) => m.type === 'ui' && m.op === 'patch' && m.args?.accent, 'ui patch a3')
    console.log('TURN3 ui patch:', JSON.stringify(ui.args).slice(0, 120))
    await next((m) => m.type === 'done' && m.ask === 'a3', 'done a3')

    // --- Turn 4: barge-in ---
    ws.send(JSON.stringify({ type: 'ask', text: 'Tell me a very long story about the history of aviation.', id: 'a4' }))
    await next((m) => m.type === 'text' && m.ask === 'a4', 'text a4')
    ws.send(JSON.stringify({ type: 'interrupt' }))
    await new Promise((r) => setTimeout(r, 600))
    ws.send(JSON.stringify({ type: 'ask', text: 'What is two plus two? Answer with the number only.', id: 'a5' }))
    const done5 = await next((m) => m.type === 'done' && m.ask === 'a5', 'done a5')
    console.log('TURN4 barge-in survived; turn5 text:', JSON.stringify(done5.text))
    console.log('ALL PROTOCOL CHECKS PASSED')
    ws.close()
    process.exit(0)
  } catch (err) {
    console.error('FAIL:', err.message)
    process.exit(1)
  }
})

ws.on('error', (e) => {
  console.error('socket error:', e.message)
  process.exit(1)
})
