// Offline test of src/api.ts with a pretend server (no network, no cost). Run: node scripts/test-api.ts
import { readFileSync } from 'node:fs'
import { ApiError, checkScanFile, processScan, setPollInterval } from '../src/api.ts'

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
    return new Response(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 })
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

console.log(failures.length ? `\nFAIL:\n - ${failures.join('\n - ')}` : '\nPASS')
process.exit(failures.length ? 1 : 0)
