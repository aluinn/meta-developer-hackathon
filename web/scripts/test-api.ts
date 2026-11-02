// Offline test of src/api.ts with a pretend server (no network, no cost). Run: node scripts/test-api.ts
import { readFileSync } from 'node:fs'
import { ApiError, checkScanFile, processScan } from '../src/api.ts'

const exampleWorld = JSON.parse(readFileSync(new URL('../../shared/example_world.json', import.meta.url), 'utf8'))
const failures: string[] = []
const check = (ok: boolean, what: string) => { if (!ok) failures.push(what) }

type Reply = { status?: number; body?: unknown } | Error
function fakeServer(replies: Record<string, Reply>) {
  const calls: string[] = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url.replace(/[0-9a-f]{32}/, '<id>')}`
    calls.push(key)
    const reply = replies[key]
    if (!reply) throw new Error(`unexpected call: ${key}`)
    if (reply instanceof Error) throw reply
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 })
  }) as typeof fetch
  return calls
}
const ID = 'ab'.repeat(16)
const file = (name: string, bytes = 10) => new File([new Uint8Array(bytes)], name)
async function message(promise: Promise<unknown>): Promise<string> {
  try { await promise; return '(no error)' } catch (e) { return e instanceof ApiError ? e.message : `NOT AN ApiError: ${e}` }
}
const happy: Record<string, Reply> = {
  'POST /scan': { body: { scan_id: ID } },
  'POST /scan/<id>/label': { body: {} },
  'POST /scan/<id>/world': { body: {} },
  'GET /world/<id>': { body: exampleWorld },
}

// 1. the happy path: the right calls, in order, with a status message before each step
const calls = fakeServer(happy)
const statuses: string[] = []
const world = await processScan(file('Three Links bathroom.glb'), (s) => statuses.push(s))
check(JSON.stringify(calls) === JSON.stringify(Object.keys(happy).map((k) => k)), `call order wrong: ${calls}`)
check(statuses.length === 4, `expected 4 status messages, got ${statuses.length}`)
check(world.objects.length === 6, 'the returned world was not parsed')
console.log('happy path calls:', calls.join('  ->  '))
console.log('status messages:', statuses.join(' | '))

// 2. the upload really carries the file in a field called "file"
let sent: FormData | undefined
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  if (url === '/scan') { sent = init?.body as FormData; return new Response(JSON.stringify({ scan_id: ID })) }
  return new Response(JSON.stringify(url.startsWith('/world') ? exampleWorld : {}))
}) as typeof fetch
await processScan(file('room.obj', 123), () => {})
const part = sent?.get('file')
check(part instanceof File && part.name === 'room.obj' && part.size === 123, 'upload form must hold the file in a field called "file"')

// 3. file checks happen before any network call
for (const [name, size, expected] of [['room.usdz', 10, "isn't supported"], ['room.glb', 101 * 1024 * 1024, 'too big'], ['room.glb', 0, 'empty'], ['scan', 10, "isn't supported"]] as const) {
  let thrown = ''
  try { checkScanFile({ name, size }) } catch (e) { thrown = (e as Error).message }
  check(thrown.includes(expected), `${name} (${size} bytes): expected a message containing "${expected}", got "${thrown}"`)
}
check(((): boolean => { try { checkScanFile({ name: 'Room.GLB', size: 5 }); return true } catch { return false } })(), 'upper-case .GLB should be accepted')

// 4. server errors become plain-English messages, whichever step fails
const failAt = async (key: string, reply: Reply) => { fakeServer({ ...happy, [key]: reply }); return message(processScan(file('a.glb'), () => {})) }
const cases: [string, Reply, string][] = [
  ['POST /scan', { status: 413, body: { detail: 'File is larger than 100MB.' } }, 'too big'],
  ['POST /scan', { status: 422, body: { detail: 'Could not read the mesh: boom' } }, "couldn't read that scan file"],
  ['POST /scan/<id>/label', { status: 503, body: { detail: 'MODEL_API_KEY is not set.' } }, 'no API key'],
  ['POST /scan/<id>/label', { status: 502, body: { detail: 'x' } }, 'AI service had a problem'],
  ['POST /scan/<id>/world', { status: 422, body: { detail: 'A2 found no objects in this scan, so there is nothing to give roles to.' } }, "couldn't find any furniture"],
  ['POST /scan/<id>/world', { status: 422, body: { detail: [{ msg: 'field required' }] } }, 'field required'],
  ['GET /world/<id>', { status: 404, body: { detail: 'No world.json for this scan yet.' } }, 'No world.json'],
  ['GET /world/<id>', { status: 500, body: 'not json at all' }, 'error (500)'],
  ['POST /scan', new TypeError('fetch failed'), 'Could not reach the server'],
  ['POST /scan/<id>/label', Object.assign(new Error('aborted'), { name: 'AbortError' }), 'too long'],
]
for (const [key, reply, expected] of cases) {
  const m = await failAt(key, reply)
  console.log(`  ${key.padEnd(24)} -> ${m}`)
  check(m.includes(expected), `${key}: expected "${expected}", got "${m}"`)
}
// a server that answers 200 but with a broken world must not crash the app with a raw error
fakeServer({ ...happy, 'GET /world/<id>': { body: { version: 1 } } })
const broken = await processScan(file('a.glb'), () => {}).then(() => 'no error', (e: Error) => e.message)
check(broken !== 'no error', 'a broken world.json should be rejected')

console.log(failures.length ? `\nFAIL:\n - ${failures.join('\n - ')}` : '\nPASS')
process.exit(failures.length ? 1 : 0)
