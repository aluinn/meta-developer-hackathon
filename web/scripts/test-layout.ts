// Offline tests of the layout agent pieces (src/layoutAgent.ts, and the Z6 calls in src/api.ts). Run from /web: node scripts/test-layout.ts
import { readFileSync } from 'node:fs'
import { ApiError, checkPhoto, getLayout, getScore, renderBeforeAfter, setFakeServer } from '../src/api.ts'
import { checkClearance, PERSON_WIDTHS } from '../src/clearance.ts'
import { compareClearance, footprintOf, footprintsOverlap, parseLayoutResponse, proposeFakeLayout, scanIdOf, verdictOf, type LayoutResult } from '../src/layoutAgent.ts'
import { parseWorld, type Role, type World, type WorldObject } from '../src/world.ts'

const failures: string[] = []
let passes = 0
const check = (ok: boolean, what: string) => {
  if (ok) passes++
  else failures.push(what)
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`)
}
const load = (path: string) => parseWorld(JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')))
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Everything the contract promises about a layout answer. Returns the problems found (none = fine). */
function problemsWith(before: World, result: LayoutResult): string[] {
  const problems: string[] = []
  const after = result.world
  if (!same(after.objects.map((o) => o.id), before.objects.map((o) => o.id))) problems.push('objects were added, removed or reordered')
  if (!same(after.room, before.room) || !same(after.spawn, before.spawn) || !same(after.goal, before.goal)) problems.push('room, spawn or goal changed')
  if (result.changes.length > 2) problems.push(`${result.changes.length} objects moved (more than 2)`)
  const moved = new Set(result.changes.map((c) => c.id))
  if (moved.size !== result.changes.length) problems.push('an object is listed twice')
  const { min, max } = before.room.bounds
  for (const o of after.objects) {
    const was = before.objects.find((b) => b.id === o.id)
    if (!was) continue
    if (!moved.has(o.id)) {
      if (!same(o, was)) problems.push(`${o.id} changed but is not in the list of changes`)
      continue
    }
    if (was.role !== 'movable') problems.push(`${o.id} is ${was.role}, not movable, but it moved`)
    if (!same(o.size, was.size) || o.rotation_y !== was.rotation_y || o.position[1] !== was.position[1] || o.role !== was.role) problems.push(`${o.id}: more than its x/z position changed`)
    const r = footprintOf(o)
    const halfX = Math.abs(r.cos) * r.hw + Math.abs(r.sin) * r.hd
    const halfZ = Math.abs(r.sin) * r.hw + Math.abs(r.cos) * r.hd
    if (o.position[0] - halfX < min[0] || o.position[0] + halfX > max[0] || o.position[2] - halfZ < min[2] || o.position[2] + halfZ > max[2]) problems.push(`${o.id} is not inside the room`)
    for (const other of after.objects) {
      if (other.id !== o.id && footprintsOverlap(r, footprintOf(other))) problems.push(`${o.id} overlaps ${other.id}`)
    }
    if (Math.hypot(o.position[0] - was.position[0], o.position[2] - was.position[2]) < 0.39) problems.push(`${o.id} hardly moved`)
  }
  for (const c of result.changes) {
    const was = before.objects.find((b) => b.id === c.id)
    const now = after.objects.find((b) => b.id === c.id)
    if (!was || !now) problems.push(`change for unknown object ${c.id}`)
    else if (!same(c.from.position, was.position) || !same(c.to.position, now.position)) problems.push(`change for ${c.id} doesn't match the worlds`)
    if (c.reason.trim() === '' || c.label.trim() === '') problems.push(`change for ${c.id} has no reason or label`)
  }
  return problems
}

// ---- 1. The pretend agent on the real example rooms ----
console.log('\n1. The pretend layout agent on our test rooms')
const rooms: Array<[string, World]> = [
  ['example room', load('../../shared/example_world.json')],
  ['test room (floor_y -1.3, turned sofa)', load('../src/test_world.json')],
  ['narrow-gap room', load('../src/clearance_test_world.json')],
]
for (const [name, world] of rooms) {
  const snapshot = JSON.stringify(world)
  const result = proposeFakeLayout(world, 'make room for a wheelchair')
  const problems = problemsWith(world, result)
  console.log(`       ${name}: moved ${result.changes.map((c) => `${c.label} (${Math.hypot(c.to.position[0] - c.from.position[0], c.to.position[2] - c.from.position[2]).toFixed(1)} m)`).join(', ') || 'nothing'}`)
  check(problems.length === 0, `${name}: only movable objects moved, inside the room, nothing overlapping${problems.length ? ': ' + problems.join('; ') : ''}`)
  check(result.changes.length >= 1, `${name}: at least one object moved`)
  check(JSON.stringify(world) === snapshot, `${name}: the original world was not changed`)
  check(same(proposeFakeLayout(world, 'make room for a wheelchair'), result), `${name}: the same goal gives the same answer`)
}

// ---- 2. Any world, not just those ----
console.log('\n2. Fifty random rooms, with random furniture, turns and floor heights')
{
  let seed = 12345
  const random = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296
  const between = (a: number, b: number) => a + (b - a) * random()
  const roles: Role[] = ['fixed', 'movable', 'movable', 'climbable', 'passable']
  const bad: string[] = []
  let movedTotal = 0
  let noMovable = 0
  for (let n = 0; n < 50; n++) {
    const floorY = [0, -1.3, 0.4][n % 3]
    const w = between(3, 8)
    const d = between(3, 6)
    const objects: WorldObject[] = []
    for (let k = 0; k < Math.floor(between(3, 10)); k++) {
      const size: [number, number, number] = [between(0.3, 2), between(0.1, 2.2), between(0.3, 1.5)]
      objects.push({
        id: `o${k}`, label: `thing ${k}`, role: roles[Math.floor(random() * roles.length)], confidence: 0.9,
        position: [between(-w / 2 + 0.5, w / 2 - 0.5), floorY + size[1] / 2, between(-d / 2 + 0.5, d / 2 - 0.5)],
        size, rotation_y: between(-4, 4),
      })
    }
    const world: World = {
      version: 1, source_scan: 'random', objects,
      room: { bounds: { min: [-w / 2, floorY, -d / 2], max: [w / 2, floorY + 2.5, d / 2] }, floor_y: floorY },
      spawn: [-w / 2 + 0.4, floorY, d / 2 - 0.4], goal: [w / 2 - 0.4, floorY, -d / 2 + 0.4],
    }
    const result = proposeFakeLayout(world, 'move things')
    movedTotal += result.changes.length
    if (!objects.some((o) => o.role === 'movable')) noMovable++
    for (const p of problemsWith(world, result)) bad.push(`room ${n}: ${p}`)
    if (!objects.some((o) => o.role === 'movable') && result.changes.length > 0) bad.push(`room ${n}: moved something with nothing movable`)
  }
  check(bad.length === 0, `50 random rooms: every answer keeps the rules${bad.length ? ': ' + bad.slice(0, 4).join('; ') : ''}`)
  check(movedTotal > 20, `...and it really did move things (${movedTotal} moves; ${noMovable} rooms had nothing movable)`)
}

// ---- 3. Edge cases ----
console.log('\n3. Edge cases')
{
  const base = load('../../shared/example_world.json')
  const none = { ...base, objects: base.objects.map((o) => ({ ...o, role: o.role === 'movable' ? ('fixed' as const) : o.role })) }
  const r = proposeFakeLayout(none, 'put the table next to the sofa')
  check(r.changes.length === 0 && r.notes !== '' && same(r.world, none), `nothing movable: no changes and a note ("${r.notes}")`)
  const add = proposeFakeLayout(base, 'add a desk by the window')
  check(/can't add/i.test(add.notes), `asking to add furniture gets a note ("${add.notes}")`)
  const tiny = { ...base, room: { ...base.room, bounds: { min: [-0.5, 0, -0.5] as [number, number, number], max: [0.5, 2.5, 0.5] as [number, number, number] } }, objects: [{ ...base.objects[2], position: [0, 0.2, 0] as [number, number, number] }], spawn: [-0.4, 0, -0.4] as [number, number, number], goal: [0.4, 0, 0.4] as [number, number, number] }
  const t = proposeFakeLayout(tiny, 'make room')
  check(t.changes.length === 0 && t.notes !== '', `a room with nowhere to put it: no changes and a note ("${t.notes}")`)
  check(scanIdOf(base) === null, 'the example room has no scan id')
  check(scanIdOf({ ...base, source_scan: `${'ab'.repeat(16)}/original.glb` }) === 'ab'.repeat(16), 'a scanned room: the scan id comes from source_scan')
  check(scanIdOf({ ...base, source_scan: 'not-an-id/original.glb' }) === null, 'a source_scan that is not 32 hex characters gives no scan id')
}

// ---- 4. Before and after walkability: the numbers come from checkClearance ----
console.log('\n4. Before / after walkability')
{
  const gapWorld = rooms[2][1]
  const result = proposeFakeLayout(gapWorld, 'make room for a wheelchair')
  const widths = [PERSON_WIDTHS.walking.widthM, PERSON_WIDTHS.walker.widthM, PERSON_WIDTHS.wheelchair.widthM]
  for (const w of widths) {
    const cmp = compareClearance(gapWorld, result.world, w)
    const strip = (r: ReturnType<typeof checkClearance>) => JSON.stringify({ ...r, gridInfo: { ...r.gridInfo, ms: 0 } })
    check(strip(cmp.before) === strip(checkClearance(gapWorld, w)) && strip(cmp.after) === strip(checkClearance(result.world, w)), `${cmp.label}: before and after are exactly checkClearance's results`)
    console.log(`       ${cmp.label}: Before: ${cmp.beforeText}. After: ${cmp.afterText}. ${cmp.verdictText}`)
  }
  const wheelchair = compareClearance(gapWorld, result.world, PERSON_WIDTHS.wheelchair.widthM)
  check(!wheelchair.before.reachable, 'narrow-gap room: the wheelchair is blocked before')
  check(wheelchair.after.reachable && wheelchair.verdict === 'better', 'narrow-gap room: the suggested layout fixes it (reachable after, verdict "better")')
  const reversed = compareClearance(result.world, gapWorld, PERSON_WIDTHS.wheelchair.widthM)
  check(reversed.verdict === 'worse', 'the same two rooms the other way round: "worse"')
  check(compareClearance(gapWorld, gapWorld, 0.85).verdict === 'same', 'a room against itself: "same"')
  const example = rooms[0][1]
  const exampleResult = proposeFakeLayout(example, 'make room for a wheelchair')
  const e = compareClearance(example, exampleResult.world, 0.85)
  check(e.after.reachable, `example room after: still reachable (${e.verdict})`)
  check(verdictOf(e.before, e.before) === 'same', 'verdictOf: equal results are "same"')
}

// ---- 5. Answers from the real server are checked ----
console.log('\n5. The server\'s /layout answer is checked')
{
  const base = rooms[0][1]
  const good = { scan_id: 'x', goal: 'g', world: base, changes: [{ id: 'table_1', label: 'coffee table', from: { position: [0, 0.2, 0], rotation_y: 0 }, to: { position: [1, 0.2, 0], rotation_y: 0 }, reason: 'because' }, { nonsense: true }], notes: ' hello ', attempts: 2 }
  const parsed = parseLayoutResponse(good, 'g')
  check(parsed.changes.length === 1 && parsed.notes === 'hello' && parsed.attempts === 2, 'a good answer is read; a malformed change is dropped; notes are trimmed')
  let threw = false
  try { parseLayoutResponse({ world: { nope: 1 } }, 'g') } catch { threw = true }
  check(threw, 'an answer whose world is invalid is refused')
  threw = false
  try { parseLayoutResponse(null, 'g') } catch { threw = true }
  check(threw, 'an empty answer is refused')
}

// ---- 6. Every error code gives a friendly message (with a pretend fetch) ----
console.log('\n6. Error messages, with a pretend server')
setFakeServer(false)
const realFetch = globalThis.fetch
const scanId = 'ab'.repeat(16)
const world = rooms[0][1]
const photo = new File([new Uint8Array(100)], 'room.jpg', { type: 'image/jpeg' })
function pretend(status: number, body: unknown, asJson = true): void {
  globalThis.fetch = (async () => new Response(asJson ? JSON.stringify(body) : String(body), { status, headers: { 'Content-Type': asJson ? 'application/json' : 'text/html' } })) as typeof fetch
}
async function messageOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
    return 'NO ERROR'
  } catch (err) {
    return err instanceof ApiError ? err.message : `CRASH: ${String(err)}`
  }
}
const friendly = (m: string) => m.length > 15 && !/NO ERROR|CRASH|undefined|object Object|^The server returned an error/.test(m)
const calls: Record<string, () => Promise<unknown>> = {
  '/layout': () => getLayout('make room for a wheelchair', world, scanId),
  '/render': () => renderBeforeAfter(scanId, photo, world, world),
  '/score': () => getScore(scanId),
}
const codes: Record<string, Array<[number, unknown, boolean]>> = {
  '/layout': [[422, { detail: { message: "Muse Spark's layout was rejected twice; nothing was changed.", problems: ['x'] } }, true], [422, { detail: 'world does not match' }, true], [503, { detail: 'MODEL_API_KEY is not set.' }, true], [502, { detail: 'Muse failed' }, true], [404, { detail: 'No world.json' }, true], [503, '<html>Service Unavailable</html>', false], [502, 'Bad gateway', false], [429, { detail: '' }, true]],
  '/render': [[422, { detail: 'Nothing moved between old_world and new_world' }, true], [415, { detail: 'Could not read the photo.' }, true], [413, { detail: 'Photo is larger than 15MB.' }, true], [502, { detail: 'Muse Image failed' }, true], [503, { detail: 'MODEL_API_KEY is not set.' }, true], [503, 'down', false]],
  '/score': [[404, { detail: 'Needs a labelled scan' }, true], [503, { detail: 'MODEL_API_KEY is not set.' }, true], [502, 'Bad gateway', false]],
}
for (const [path, list] of Object.entries(codes)) {
  for (const [status, body, asJson] of list) {
    pretend(status, body, asJson)
    const m = await messageOf(calls[path])
    check(friendly(m), `${path} ${status}${asJson ? '' : ' (no JSON, e.g. from the host)'}: "${m}"`)
  }
}
// The network being down, and a successful answer that is not what we expect.
globalThis.fetch = (async () => { throw new TypeError('fetch failed') }) as typeof fetch
for (const [path, run] of Object.entries(calls)) check(friendly(await messageOf(run)) && /reach the server/.test(await messageOf(run)), `${path}: server unreachable: "${await messageOf(run)}"`)
pretend(200, { nope: true })
for (const [path, run] of Object.entries(calls)) check(friendly(await messageOf(run)), `${path}: a 200 with an unexpected body: "${await messageOf(run)}"`)
pretend(200, 'not json at all', false)
for (const [path, run] of Object.entries(calls)) check(friendly(await messageOf(run)), `${path}: a 200 that isn't JSON: "${await messageOf(run)}"`)
// No scan id (the example rooms), with the real server.
{
  // /layout still works for a built-in room: the whole room is sent, with a placeholder scan id.
  let sent = ''
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    sent = typeof init?.body === 'string' ? init.body : ''
    return new Response(JSON.stringify({ scan_id: '0'.repeat(32), goal: 'make room', world, changes: [], notes: '', attempts: 1 }), { status: 200 })
  }) as typeof fetch
  await getLayout('make room', world, null)
  check(JSON.parse(sent).scan_id === '0'.repeat(32) && 'world' in JSON.parse(sent), 'a room with no scan id: /layout is sent the room with a placeholder id')
}
check(/wasn't scanned/.test(await messageOf(() => getScore(null))), 'a room with no scan id: /score says why')
check(/wasn't scanned/.test(await messageOf(() => renderBeforeAfter(null, photo, world, world))), 'a room with no scan id: /render says why')
check(/few letters|goal first/.test(await messageOf(() => getLayout('  ', world, scanId))), 'an empty goal is refused before asking the server')

// ---- 7. Good answers from a pretend server ----
console.log('\n7. Good answers from a pretend server')
{
  let seen = ''
  let sentBody = ''
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen = String(url)
    sentBody = typeof init?.body === 'string' ? init.body : init?.body instanceof FormData ? [...init.body.keys()].join(',') : ''
    if (seen.startsWith('/layout')) return new Response(JSON.stringify({ scan_id: scanId, goal: 'g', world, changes: [], notes: 'nothing to do', attempts: 1 }), { status: 200 })
    if (seen.startsWith('/render')) return new Response(JSON.stringify({ before_url: `/render/${scanId}/before`, after_url: `/render/${scanId}/after`, moved: [{ id: 'table_1', label: 'coffee table', from: [0, 0, 0], to: [1, 0, 0] }], changed_fraction: 0.4, likely_changed_too_much: true }), { status: 200 })
    return new Response(JSON.stringify({ overall_percent: 44.2, objects: [], warnings: ['grey render'] }), { status: 200 })
  }) as typeof fetch
  const layout = await getLayout('make room', world, scanId)
  check(seen === '/layout' && JSON.parse(sentBody).scan_id === scanId && JSON.parse(sentBody).goal === 'make room' && layout.notes === 'nothing to do', 'getLayout posts {scan_id, goal, world} to the relative path /layout')
  const render = await renderBeforeAfter(scanId, photo, world, world)
  check(seen === '/render' && sentBody === 'scan_id,photo,old_world,new_world', `renderBeforeAfter posts the four form fields to /render (${sentBody})`)
  check(render.beforeUrl?.startsWith(`/render/${scanId}/before?t=`) === true && render.likelyChangedTooMuch && render.changedFraction === 0.4 && render.moved[0]?.label === 'coffee table', 'the render answer is read (pictures, warning flag, moved list)')
  const score = await getScore(scanId)
  check(seen === `/score/${scanId}` && score.overallPercent === 44.2 && score.warnings[0] === 'grey render' && !score.pretend, 'getScore reads /score/{scan_id}')
}
globalThis.fetch = realFetch

// ---- 8. Photos ----
console.log('\n8. Photo checks')
{
  const msg = (f: { name: string; size: number; type: string }) => { try { checkPhoto(f); return 'ok' } catch (e) { return (e as Error).message } }
  check(msg({ name: 'a.jpg', size: 10, type: 'image/jpeg' }) === 'ok' && msg({ name: 'a.png', size: 10, type: 'image/png' }) === 'ok' && msg({ name: 'a.webp', size: 10, type: 'image/webp' }) === 'ok', 'JPEG, PNG and WebP are accepted')
  check(/HEIC/.test(msg({ name: 'IMG_1.HEIC', size: 10, type: 'image/heic' })) && /HEIC/.test(msg({ name: 'IMG_1.heic', size: 10, type: '' })), 'HEIC is refused with a friendly message')
  check(/JPEG, PNG or WebP/.test(msg({ name: 'a.gif', size: 10, type: 'image/gif' })), 'other types are refused')
  check(/15 MB/.test(msg({ name: 'a.jpg', size: 16 * 1024 * 1024, type: 'image/jpeg' })), 'over 15 MB is refused')
  check(/empty/.test(msg({ name: 'a.jpg', size: 0, type: 'image/jpeg' })), 'an empty photo is refused')
}

// ---- 9. The pretend server (USE_FAKE_SERVER = true) ----
console.log('\n9. The pretend server')
setFakeServer(true)
{
  const t0 = performance.now()
  const layout = await getLayout('make room for a wheelchair', world, null)
  const ms = performance.now() - t0
  check(layout.changes.length >= 1 && ms >= 1400 && ms < 4000, `pretend /layout waits about 1.5 s (${ms.toFixed(0)} ms) and moves something`)
  const score = await getScore(null)
  check(score.overallPercent === 72 && score.pretend, 'pretend /score is 72%, marked as pretend')
  const render = await renderBeforeAfter(null, photo, world, layout.world)
  check(render.beforeUrl === null && render.afterUrl === null, 'pretend /render returns no pictures')
}

console.log(`\n${passes} passed, ${failures.length} failed`)
if (failures.length > 0) {
  console.log('FAILED:\n' + failures.map((f) => `  - ${f}`).join('\n'))
  process.exit(1)
}
