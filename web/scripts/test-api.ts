// Offline test of src/api.ts with a pretend server (no network, no cost). Run: node scripts/test-api.ts
import { readFileSync } from 'node:fs'
import { ApiError, checkScanFile, generateCharacter, layout, layoutErrorMessage, processScan, scanIdOf, setFakeServer, setPollInterval } from '../src/api.ts'
import { parseWorld } from '../src/world.ts'

setPollInterval(0) // do not wait between progress checks in tests
const exampleWorld = JSON.parse(readFileSync(new URL('../../shared/example_world.json', import.meta.url), 'utf8'))
const failures: string[] = []
const check = (ok: boolean, what: string) => {
  if (!ok) failures.push(what)
}

type Reply = { status?: number; body?: unknown } | Error
/** A pretend server. An array of replies is handed out one per call; the last one repeats. */
function fakeServer(replies: Record<string, Reply | Reply[]>) {
  const calls: string[] = []
  const used: Record<string, number> = {}
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url.replace(/[0-9a-f]{32}/, '<id>')}`
    calls.push(key)
    const entry = replies[key]
    if (!entry) throw new Error(`unexpected call: ${key}`)
    const n = (used[key] = (used[key] ?? 0) + 1)
    const reply = Array.isArray(entry) ? entry[Math.min(n, entry.length) - 1] : entry
    if (reply instanceof Error) throw reply
    const body = reply.body instanceof Uint8Array || typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {})
    return new Response(body as BodyInit, { status: reply.status ?? 200 })
  }) as typeof fetch
  return calls
}
const ID = 'ab'.repeat(16)
const file = (name: string, bytes = 10) => new File([new Uint8Array(bytes)], name)
async function message(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    return '(no error)'
  } catch (e) {
    return e instanceof ApiError ? e.message : `NOT AN ApiError: ${e}`
  }
}
const job = (state: string, step: string, percent = 0, error_kind: string | null = null) => ({ status: 200, body: { state, step, percent, error_kind } })
const progress = [job('queued', 'queued'), job('running', 'rendering'), job('running', 'labelling', 0), job('running', 'labelling', 40), job('running', 'labelling', 40), job('running', 'labelling', 90), job('running', 'roles'), job('done', 'done', 100)]
const happy: Record<string, Reply | Reply[]> = {
  'POST /scan': { body: { scan_id: ID } },
  'POST /scan/<id>/process': { status: 202, body: { state: 'queued' } },
  'GET /scan/<id>/status': progress,
  'GET /world/<id>': { body: exampleWorld },
}

// 1. the happy path: the right calls, in order; a message for each step; the same message is not repeated
let calls = fakeServer(happy)
const statuses: string[] = []
const world = await processScan(file('Three Links bathroom.glb'), (s) => statuses.push(s))
console.log('calls (first and last few):', [...calls.slice(0, 3), '...', ...calls.slice(-2)].join('  ->  '))
console.log('status messages:', statuses.join(' | '))
check(calls[0] === 'POST /scan' && calls[1] === 'POST /scan/<id>/process' && calls.at(-1) === 'GET /world/<id>', `call order wrong: ${calls}`)
check(calls.filter((c) => c === 'GET /scan/<id>/status').length === progress.length, 'should poll the status until the job is done')
check(statuses[0] === 'Uploading your scan…' && statuses.at(-1) === 'Building your room…', 'first and last messages wrong')
check(statuses.includes('Waiting for the server…') && statuses.includes('Preparing your scan…') && statuses.includes('Working out what each thing is…'), 'missing a step message')
check(statuses.includes('Looking for furniture… 40%') && statuses.includes('Looking for furniture… 90%'), 'progress percentages should be shown')
check(statuses.filter((s) => s === 'Looking for furniture… 40%').length === 1, 'an unchanged message should not be repeated')
check(world.objects.length === 6, 'the returned world was not parsed')

// 2. the upload really carries the file in a field called "file"
let sent: FormData | undefined
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  if (url === '/scan') {
    sent = init?.body as FormData
    return new Response(JSON.stringify({ scan_id: ID }))
  }
  if (url.endsWith('/status')) return new Response(JSON.stringify({ state: 'done', step: 'done', percent: 100 }))
  return new Response(JSON.stringify(url.startsWith('/world') ? exampleWorld : {}))
}) as typeof fetch
await processScan(file('room.obj', 123), () => {})
const part = sent?.get('file')
check(part instanceof File && part.name === 'room.obj' && part.size === 123, 'upload form must hold the file in a field called "file"')

// 3. file checks happen before any network call
for (const [name, size, expected] of [['room.usdz', 10, "isn't supported"], ['room.glb', 101 * 1024 * 1024, 'too big'], ['room.glb', 0, 'empty'], ['scan', 10, "isn't supported"]] as const) {
  let thrown = ''
  try {
    checkScanFile({ name, size })
  } catch (e) {
    thrown = (e as Error).message
  }
  check(thrown.includes(expected), `${name} (${size} bytes): expected a message containing "${expected}", got "${thrown}"`)
}
check(((): boolean => { try { checkScanFile({ name: 'Room.GLB', size: 5 }); return true } catch { return false } })(), 'upper-case .GLB should be accepted')

// 4. failures at each step become plain-English messages
const failAt = async (key: string, reply: Reply | Reply[]) => {
  fakeServer({ ...happy, [key]: reply })
  return message(processScan(file('a.glb'), () => {}))
}
const cases: [string, Reply | Reply[], string][] = [
  ['POST /scan', { status: 413, body: { detail: 'File is larger than 100MB.' } }, 'too big'],
  ['POST /scan', { status: 422, body: { detail: 'Could not read the mesh: boom' } }, "couldn't read that scan file"],
  ['POST /scan', { status: 502, body: '<html>502 Bad Gateway</html>' }, 'busy or restarting'],
  ['POST /scan', { status: 503, body: '<html>service unavailable</html>' }, 'busy or restarting'],
  ['POST /scan', new TypeError('fetch failed'), 'Could not reach the server'],
  ['POST /scan/<id>/process', { status: 404, body: { detail: 'No such scan.' } }, 'No such scan'],
  ['POST /scan/<id>/process', { status: 504, body: '<html>gateway timeout</html>' }, 'busy or restarting'],
  ['GET /world/<id>', { status: 404, body: { detail: 'No world.json for this scan yet.' } }, 'No world.json'],
  ['GET /world/<id>', { status: 500, body: 'not json at all' }, 'error (500)'],
]
for (const [key, reply, expected] of cases) {
  const m = await failAt(key, reply)
  console.log(`  ${key.padEnd(26)} -> ${m}`)
  check(m.includes(expected), `${key}: expected "${expected}", got "${m}"`)
}

// 5. the background job can fail, and says why
const jobFails: [string, string][] = [
  ['no_key', 'no API key'], ['no_objects', "couldn't find any furniture"], ['ai_service', 'AI service had a problem'], ['out_of_memory', 'too big for the free server'], ['failed', 'Something went wrong'], ['something_new', 'Something went wrong'],
]
for (const [kind, expected] of jobFails) {
  const m = await failAt('GET /scan/<id>/status', [job('running', 'labelling', 10), job('error', 'labelling', 10, kind)])
  console.log(`  job error '${kind}'`.padEnd(30), '->', m)
  check(m.includes(expected), `job error ${kind}: expected "${expected}", got "${m}"`)
}

// 6. the server restarted and forgot the job (status 404); and flaky connections while waiting
const restarted = await failAt('GET /scan/<id>/status', [job('running', 'labelling', 20), { status: 404, body: { detail: 'No job for this scan' } }])
console.log('  server forgot the job       ->', restarted)
check(restarted.includes('restarted'), 'a 404 on status should say the server restarted')
const flaky = await failAt('GET /scan/<id>/status', [new TypeError('fetch failed'), new TypeError('fetch failed'), job('running', 'labelling', 50), job('done', 'done', 100)])
check(flaky === '(no error)', `two dropped checks in a row should be tolerated, got "${flaky}"`)
const dead = await failAt('GET /scan/<id>/status', [new TypeError('fetch failed')])
console.log('  connection lost for good    ->', dead)
check(dead.includes('Could not reach the server'), 'five failed checks in a row should give up')

// 7. a server that answers 200 but with a broken world must not crash the app with a raw error
fakeServer({ ...happy, 'GET /world/<id>': { body: { version: 1 } } })
const broken = await processScan(file('a.glb'), () => {}).then(() => 'no error', (e: Error) => e.message)
check(broken !== 'no error', 'a broken world.json should be rejected')

// 8. the character maker: a picture comes back as a data URL; every refusal is shown in the server's own friendly words
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 250, 251, 252])
let sentBody = ''
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  sentBody = String(init?.body)
  return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } })
}) as typeof fetch
const url = await generateCharacter('  a sleepy red panda  ')
check(url.startsWith('data:image/png;base64,') && Uint8Array.from(atob(url.split(',')[1]), (c) => c.charCodeAt(0)).every((b, i) => b === png[i]), 'the picture should come back as a data URL with the same bytes')
check(JSON.parse(sentBody).description === 'a sleepy red panda', 'the description should be trimmed and sent as JSON')
for (const [text, expected] of [['hi', '3 to 80'], ['x'.repeat(81), '3 to 80']] as const) {
  fakeServer({})
  const m = await message(generateCharacter(text))
  check(m.includes(expected), `a description of ${text.length} characters should be refused before sending, got "${m}"`)
}
const characterCases: [Reply, string][] = [
  [{ status: 422, body: { detail: "That description isn't allowed. Describe an original character." } }, "isn't allowed"],
  [{ status: 429, body: { detail: 'Slow down a little: you can make another character in 6 seconds.' } }, 'Slow down a little'],
  [{ status: 503, body: { detail: 'The server is busy with another job. Try again in a minute.' } }, 'busy with another job'],
  [{ status: 502, body: { detail: 'The drawing service had a problem. Please try again in a moment.' } }, 'drawing service had a problem'],
  [{ status: 502, body: '<html>502 Bad Gateway</html>' }, 'busy or restarting'],
  [{ status: 429, body: '<html>too many</html>' }, 'Too many requests'],
  [new TypeError('fetch failed'), 'Could not reach the server'],
]
for (const [reply, expected] of characterCases) {
  fakeServer({ 'POST /character': reply })
  const m = await message(generateCharacter('a happy cloud'))
  console.log(`  /character -> ${m}`)
  check(m.includes(expected), `/character: expected "${expected}", got "${m}"`)
}


// ---- /layout (the Layout tab's Rearrange) ----
const room = parseWorld(exampleWorld)
const moved = JSON.parse(JSON.stringify(exampleWorld))
moved.objects[2].position = [0.5, 0.2, 0.0] // the coffee table, 0.5 m to the side
const answer = {
  scan_id: ID, goal: 'g', world: moved,
  changes: [{ id: 'table_1', label: 'coffee table', from: { position: [0, 0.2, 0], rotation_y: 0.3 }, to: { position: [0.5, 0.2, 0], rotation_y: 0.3 }, reason: 'Clears the path.' }],
  notes: 'No window to put things by.', attempts: 2, spawn_to_goal_walkable: { before: false, after: true },
}
setFakeServer(false)
let layoutBody: Record<string, unknown> = {}
globalThis.fetch = (async (_url: string, init?: RequestInit) => {
  layoutBody = JSON.parse(String(init?.body))
  return new Response(JSON.stringify(answer), { status: 200 })
}) as typeof fetch
const scanned = { ...room, source_scan: `${ID}/original.glb` }
const got = await layout('  make room for a wheelchair ', scanned)
check(layoutBody.scan_id === ID && layoutBody.goal === 'make room for a wheelchair' && JSON.stringify(layoutBody.world).includes(ID), 'layout: sends scan_id (from source_scan), the trimmed goal, and the world')
check(got.changes.length === 1 && got.changes[0].to.position[0] === 0.5 && got.notes === 'No window to put things by.' && got.attempts === 2, 'layout: changes, notes and attempts come through')
check(got.spawnToGoalWalkable.before === false && got.spawnToGoalWalkable.after === true && got.world.objects[2].position[0] === 0.5, 'layout: walkable flags and the new world come through')
await layout('make room', room)
check(layoutBody.scan_id === '0'.repeat(32), 'layout: a room with no uploaded scan sends a placeholder id')
check(scanIdOf(scanned) === ID && scanIdOf(room) === '0'.repeat(32), 'scanIdOf works')
check((await message(layout('hi', room))).includes('what you want'), 'layout: a too-short goal is refused before any call')
const layoutReplies: Array<[string, number, unknown, RegExp]> = [
  ['422 rejected', 422, { detail: { message: 'rejected twice', problems: ['x'] } }, /valid arrangement.*nothing was changed/i],
  ['422 bad world', 422, { detail: 'world does not match' }, /valid arrangement/i],
  ['503 with a message', 503, { detail: 'MODEL_API_KEY is not set' }, /not set up.*API key/i],
  ['502 from the AI', 502, { detail: 'upstream' }, /AI service had a problem/i],
  ['500 from the server', 500, { detail: 'boom' }, /error 500/],
  ['503 from the hosting layer', 503, 'upstream unavailable', /Couldn't reach the server/],
  ['200 but nonsense', 200, { hello: 1 }, /wasn't what we expected/],
]
for (const [name, status, body, expected] of layoutReplies) {
  globalThis.fetch = (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as typeof fetch
  const m = await message(layout('make room for a wheelchair', room))
  check(expected.test(m), `layout ${name}: got "${m}"`)
}
globalThis.fetch = (async () => { throw new TypeError('fetch failed') }) as typeof fetch
check(/Couldn't reach the server/.test(await message(layout('make room for a wheelchair', room))), 'layout: network failure message')
globalThis.fetch = (async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e }) as typeof fetch
check(/took too long/.test(await message(layout('make room for a wheelchair', room))), 'layout: timeout message')
check([422, 503, 502, 418].every((code) => layoutErrorMessage(code).length > 10), 'layoutErrorMessage covers every code')
// the pretend server (config.ts USE_FAKE_SERVER): moves the first movable object 0.5 m towards the middle
setFakeServer(true)
const fake = await layout('anything goes', room)
const before = room.objects.find((o) => o.id === fake.changes[0]?.id)
const after = fake.world.objects.find((o) => o.id === fake.changes[0]?.id)
check(fake.changes.length === 1 && before !== undefined && after !== undefined && before.role === 'movable', 'fake layout: moves one movable object')
if (before && after) {
  const d = Math.hypot(after.position[0] - before.position[0], after.position[2] - before.position[2])
  check(d > 0 && d <= 0.5 + 1e-6, `fake layout: moved ${d} m`)
  check(Math.hypot(after.position[0], after.position[2]) < Math.hypot(before.position[0], before.position[2]) + 1e-9, 'fake layout: towards the centre')
}
const fixedOnly = { ...room, objects: room.objects.filter((o) => o.role !== 'movable') }
check((await layout('anything goes', fixedOnly)).changes.length === 0, 'fake layout: nothing movable, nothing changes')
setFakeServer(false)

console.log(failures.length ? `\nFAIL:\n - ${failures.join('\n - ')}` : '\nPASS')
process.exit(failures.length ? 1 : 0)
