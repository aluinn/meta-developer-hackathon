// Offline tests of the clearance check (src/clearance.ts). Run from /web: node scripts/test-clearance.ts
import { readFileSync } from 'node:fs'
import { buildFloorMap, checkClearance, PERSON_WIDTHS, snapNotes, summarise, type ClearanceResult } from '../src/clearance.ts'
import { parseWorld, type Role, type Vec3, type World, type WorldObject } from '../src/world.ts'

const failures: string[] = []
let passes = 0
const check = (ok: boolean, what: string) => {
  if (ok) passes++
  else failures.push(what)
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`)
}
const near = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance

/** A test room: 6 m (x, -3..3) by 4 m (z, -2..2), 2.5 m tall, floor at `floorY`. */
function room(objects: WorldObject[], spawn: [number, number], goal: [number, number], floorY = 0): World {
  return {
    version: 1,
    source_scan: 'test',
    room: { bounds: { min: [-3, floorY, -2], max: [3, floorY + 2.5, 2] }, floor_y: floorY },
    objects,
    spawn: [spawn[0], floorY, spawn[1]],
    goal: [goal[0], floorY, goal[1]],
  }
}

/** A box standing on the floor (or floating, with `bottom`): centre x/z, size w (x) by d (z), height h. */
function box(id: string, x: number, z: number, w: number, d: number, opts: { h?: number; role?: Role; turn?: number; floorY?: number; bottom?: number } = {}): WorldObject {
  const h = opts.h ?? 0.8
  const bottom = (opts.floorY ?? 0) + (opts.bottom ?? 0)
  const position: Vec3 = [x, bottom + h / 2, z]
  return { id, label: id, role: opts.role ?? 'fixed', confidence: 1, position, size: [w, h, d], rotation_y: opts.turn ?? 0 }
}

/** A wall of boxes across the room at x = 0, from z = -2 to 2, with one gap from z = gapFrom to gapTo. */
function wallWithGap(gapFrom: number, gapTo: number, floorY = 0): WorldObject[] {
  return [
    box('wall_south', 0, (-2 + gapFrom) / 2, 0.2, gapFrom + 2, { floorY }),
    box('wall_north', 0, (gapTo + 2) / 2, 0.2, 2 - gapTo, { floorY }),
  ]
}

const W = PERSON_WIDTHS
const show = (r: ClearanceResult, label: string) => {
  console.log(`       ${summarise(r, label)}`)
  for (const note of snapNotes(r)) console.log(`       ${note}`)
}

// ---- 1. Empty room ----
console.log('\n1. Empty room')
{
  const r = checkClearance(room([], [-2, 0], [2, 0]), W.walking.widthM)
  show(r, 'Walking')
  check(r.reachable, 'goal is reachable')
  check(r.reachablePercent > 99, `about 100% of the open floor is reachable (${r.reachablePercent.toFixed(2)}%)`)
  check(near(r.pathLengthM, 4, 0.02), `path is about 4 m long, a straight line (${r.pathLengthM.toFixed(3)} m)`)
  check(r.path.every((p) => Math.abs(p.z) < 0.03), 'every path point stays on the line z = 0')
  check(r.path.length === 2, `smoothing leaves just the two ends (${r.path.length} points)`)
  check(r.narrowestGapCm === null, `no narrow gaps on the way: it's open all the way (${r.narrowestGapCm})`)
  check(r.snapped.start === null && r.snapped.goal === null, 'nothing was moved')
}

// ---- 2. A wall of boxes with a 0.8 m gap (z from -0.4 to 0.4) ----
console.log('\n2. Wall of boxes with a 0.8 m gap, start and goal on opposite sides and offset, so the route must bend')
const gapWorld = room(wallWithGap(-0.4, 0.4), [-2, -1.2], [2, 1.2])
const gapResults: Record<string, ClearanceResult> = {}
for (const kind of ['walking', 'walker', 'wheelchair'] as const) {
  const r = checkClearance(gapWorld, W[kind].widthM)
  gapResults[kind] = r
  show(r, W[kind].label)
}
{
  const { walking, walker, wheelchair } = gapResults
  check(walking.reachable, 'Walking (0.5 m) gets through')
  check(walker.reachable, 'Walker (0.7 m) gets through')
  check(!wheelchair.reachable, 'Wheelchair (0.85 m) does NOT get through')
  check(walking.narrowestGapCm !== null && near(walking.narrowestGapCm, 80, 1), `Walking: narrowest gap is the 80 cm gap, within 1 cm (${walking.narrowestGapCm} cm)`)
  check(walker.narrowestGapCm !== null && near(walker.narrowestGapCm, 80, 1), `Walker: same gap, same answer (${walker.narrowestGapCm} cm)`)
  check(walking.narrowestAt !== null && Math.abs(walking.narrowestAt.x) <= 0.15 && Math.abs(walking.narrowestAt.z) <= 0.1, `Walking: the narrowest spot is in the gap (${JSON.stringify(walking.narrowestAt)})`)
  const b = wheelchair.blockedAt
  check(b?.reason === 'gap', `Wheelchair: blocked by a gap (${b?.reason})`)
  check(b !== null && Math.abs(b.at.x) <= 0.15 && Math.abs(b.at.z) <= 0.1, `Wheelchair: blockedAt is at the gap (${b ? `x ${b.at.x.toFixed(3)}, z ${b.at.z.toFixed(3)}` : 'none'})`)
  check(b?.gapCm !== null && b?.gapCm !== undefined && near(b.gapCm, 80, 1), `Wheelchair: the gap is measured as 80 cm, within 1 cm (${b?.gapCm} cm)`)
  // The same gap, but not lined up with the grid (z from -0.33 to 0.47), still measures 80 cm.
  const shifted = checkClearance(room(wallWithGap(-0.33, 0.47), [-2, -1.2], [2, 1.2]), W.walking.widthM)
  check(shifted.narrowestGapCm !== null && near(shifted.narrowestGapCm, 80, 1), `a gap not lined up with the grid: still 80 cm (${shifted.narrowestGapCm} cm)`)
  check(wheelchair.reachablePercent > 40 && wheelchair.reachablePercent < 55, `Wheelchair: about half the floor (one side of the wall) is reachable (${wheelchair.reachablePercent.toFixed(1)}%)`)
  check(walking.reachablePercent > 93, `Walking: nearly all the floor is reachable (${walking.reachablePercent.toFixed(1)}%)`)
  const wide = checkClearance(gapWorld, 1.2)
  check(!wide.reachable, 'the widest slider setting (1.2 m) is blocked too')
}

// ---- 3. A passable rug over the route; and a high shelf over it ----
console.log('\n3. A passable rug over the whole route, and a shelf whose bottom is 2.1 m up')
{
  const rug = box('rug', 0, 0, 5, 3, { h: 0.02, role: 'passable' })
  const r = checkClearance(room([rug], [-2, 0], [2, 0]), W.wheelchair.widthM)
  show(r, 'Wheelchair')
  check(r.reachable && r.reachablePercent > 99, 'the rug does not block')
  const shelf = box('high_shelf', 0, 0, 0.4, 4, { h: 0.3, bottom: 2.1 })
  const r2 = checkClearance(room([shelf], [-2, 0], [2, 0]), W.wheelchair.widthM)
  check(r2.reachable && r2.reachablePercent > 99, 'a shelf floating above head height does not block')
  const lowShelf = box('low_shelf', 0, 0, 0.4, 4, { h: 0.3, bottom: 1.5 })
  const r3 = checkClearance(room([lowShelf], [-2, 0], [2, 0]), W.wheelchair.widthM)
  check(!r3.reachable, 'the same shelf at 1.5 m up DOES block (and it spans the room)')
}

// ---- 4. A rotated box ----
console.log('\n4. Rotated boxes')
{
  // A 1 m square turned 45 degrees is a diamond: its tips are 0.707 m from the centre, its sides 0.5 m.
  const map = buildFloorMap(room([box('square', 0, 0, 1, 1, { turn: Math.PI / 4 })], [-2, 0], [2, 0]))
  const blocked = (x: number, z: number) => map.clearance[map.cellAt(x, z)] === 0
  check(blocked(0.66, 0.01), 'the diamond tip at x = 0.66 is blocked (an unturned box would end at 0.5)')
  check(!blocked(0.45, 0.45), "the unturned box's corner (0.45, 0.45) is NOT blocked: it's outside the diamond")
  check(blocked(0.3, 0.3), 'a point inside the diamond (0.3, 0.3) is blocked')
  check(near(map.clearanceAt(1.0, 0), 1 - Math.SQRT1_2, 0.001), `clearance at (1, 0) is 1 - 0.707 = 0.293 m (${map.clearanceAt(1.0, 0).toFixed(4)})`)
  // Direction of turning: positive rotation_y is anticlockwise seen from above (same as three.js), so the +x end of a long
  // thin box turned by +0.5 rad moves to (cos 0.5, -sin 0.5) = (0.88, -0.48). Here z points towards you when seen from above.
  const stick = buildFloorMap(room([box('stick', 0, 0, 2, 0.1, { turn: 0.5 })], [-2, 0], [2, 0]))
  const stickBlocked = (x: number, z: number) => stick.clearance[stick.cellAt(x, z)] === 0
  check(stickBlocked(0.85, -0.46), 'a stick turned +0.5 rad covers (0.85, -0.46)')
  check(!stickBlocked(0.85, 0.46), '...and not the mirror image (0.85, +0.46), so the turn goes the same way as three.js')
  // Any angle works: a whole turn later it is the same.
  const full = buildFloorMap(room([box('stick', 0, 0, 2, 0.1, { turn: 0.5 + 2 * Math.PI })], [-2, 0], [2, 0]))
  check(full.clearance.every((c, k) => near(c, stick.clearance[k], 1e-4)), 'rotation 0.5 and 0.5 + 2 pi give the same map')
}

// ---- 5. floor_y = -1.3 ----
console.log('\n5. The 0.8 m gap room again, with the floor at y = -1.3')
{
  const low = room(wallWithGap(-0.4, 0.4, -1.3), [-2, -1.2], [2, 1.2], -1.3)
  for (const kind of ['walking', 'walker', 'wheelchair'] as const) {
    const r = checkClearance(low, W[kind].widthM)
    show(r, W[kind].label)
    const same = gapResults[kind]
    check(r.reachable === same.reachable && r.narrowestGapCm === same.narrowestGapCm && near(r.reachablePercent, same.reachablePercent, 1e-9), `${W[kind].label}: same answer as with the floor at 0`)
  }
  // Head height is measured from floor_y: with the floor at -1.3, a box whose bottom is at y = 1.0 is 2.3 m up.
  const shelf = box('shelf', 0, 0, 0.4, 4, { h: 0.3, bottom: 2.3, floorY: -1.3 })
  check(checkClearance(room([shelf], [-2, 0], [2, 0], -1.3), 0.5).reachable, 'a box 2.3 m above floor_y = -1.3 (bottom at y = 1.0) does not block')
  const lowBox = box('box', 0, 0, 0.4, 4, { h: 0.3, bottom: 1.5, floorY: -1.3 })
  check(!checkClearance(room([lowBox], [-2, 0], [2, 0], -1.3), 0.5).reachable, 'a box 1.5 m above floor_y = -1.3 (bottom at y = 0.2) blocks')
}

// ---- 6. Start inside an object; start and goal cut off ----
console.log('\n6. Start inside a box, and other blocked cases')
{
  const r = checkClearance(room([box('crate', -2, 0, 0.4, 0.4)], [-2, 0], [2, 0]), W.walking.widthM)
  show(r, 'Walking')
  check(r.snapped.start !== null, 'the start was moved (snapped)')
  check(r.snapped.start !== null && r.snapped.start.movedCm <= 50 && r.snapped.start.movedCm >= 40, `...by about 45 cm: out of the box plus half the person (${r.snapped.start?.movedCm} cm)`)
  check(r.reachable, 'and the goal is still reachable')
  const s = r.snapped.start
  check(s !== null && r.path[0].x === s.to.x && r.path[0].z === s.to.z, 'the route begins where the start was moved to')

  const deep = checkClearance(room([box('big', -2, 0, 1.6, 1.6)], [-2, 0], [2, 0]), W.walking.widthM)
  show(deep, 'Walking')
  check(!deep.reachable && deep.blockedAt?.reason === 'start', 'a start deep inside a big box (no room within 50 cm): blocked, reason "start"')

  // The goal inside a closed pen of boxes (no gap at all).
  const pen = [box('n', 2, 1, 1.2, 0.2), box('s', 2, -1, 1.2, 0.2), box('e', 2.5, 0, 0.2, 1.8), box('w', 1.5, 0, 0.2, 1.8)]
  const sealed = checkClearance(room(pen, [-2, 0], [2, 0]), W.walking.widthM)
  show(sealed, 'Walking')
  check(!sealed.reachable && sealed.blockedAt?.reason === 'sealed', 'goal inside a closed pen: blocked, reason "sealed"')
  const at = sealed.blockedAt?.at
  check(at !== undefined && at.x < 1.4 && at.x > 1.0 && Math.abs(at.z) < 0.2, `...marked just outside the pen, closest to the goal (${at ? `x ${at.x.toFixed(2)}, z ${at.z.toFixed(2)}` : 'none'})`)
}

// ---- 7. The example room, and Zac's narrow-gap copy of it ----
const load = (path: string) => parseWorld(JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')))
for (const [title, path] of [
  ['shared/example_world.json', '../../shared/example_world.json'],
  ['src/clearance_test_world.json (table and chair moved to make a 78 cm gap by the bookshelf)', '../src/clearance_test_world.json'],
] as const) {
  console.log(`\n7. ${title}`)
  const world = load(path)
  const results: Record<string, ClearanceResult> = {}
  for (const kind of ['walking', 'walker', 'wheelchair'] as const) {
    const r = checkClearance(world, W[kind].widthM)
    results[kind] = r
    show(r, W[kind].label)
    const at = r.blockedAt?.at ?? r.narrowestAt
    console.log(`       route ${r.pathLengthM.toFixed(2)} m through ${r.path.length} points; ${r.blockedAt ? 'blocked' : 'narrowest'} at ${at ? `x ${at.x.toFixed(2)}, z ${at.z.toFixed(2)}` : '-'}; ${r.gridInfo.nx} x ${r.gridInfo.nz} cells; ${r.gridInfo.ms.toFixed(1)} ms`)
  }
  if (path.includes('example')) {
    check(results.walking.reachable && results.walker.reachable && results.wheelchair.reachable, 'example room: all three can reach the goal')
    // The goal is tucked 25 cm from the bookshelf's corner. That is not a gap you pass through, so it must not be the answer.
    const gaps = [results.walking, results.walker, results.wheelchair].map((r) => r.narrowestGapCm)
    check(gaps.every((g) => g === null || g > 100), `the goal's corner is not reported as the narrowest gap (${gaps.join(', ')})`)
  } else {
    check(results.walking.reachable && results.walker.reachable, 'narrow-gap room: Walking and Walker still get through')
    check(results.walking.narrowestGapCm !== null && near(results.walking.narrowestGapCm, 78, 1), `narrow-gap room: Walking squeezes through the 78 cm gap (${results.walking.narrowestGapCm} cm)`)
    const b = results.wheelchair.blockedAt
    check(!results.wheelchair.reachable && b?.reason === 'gap' && b.gapCm !== null && near(b.gapCm, 78, 1), `narrow-gap room: Wheelchair is blocked by the 78 cm gap (${b?.gapCm} cm)`)
    check(b !== null && b !== undefined && b.at.x > 1.87 && b.at.x < 2.65 && b.at.z > -1.35 && b.at.z < -0.85, 'narrow-gap room: marked between the chair and the bookshelf')
  }
}

// ---- 8. Speed ----
console.log('\n8. Speed')
{
  const example = load('../../shared/example_world.json')
  const time = (world: World, width: number, runs: number) => {
    const t0 = performance.now()
    for (let k = 0; k < runs; k++) checkClearance(world, width)
    return (performance.now() - t0) / runs
  }
  time(example, 0.5, 5) // warm up
  const exampleMs = time(example, 0.85, 50)
  console.log(`       example room (6 x 5 m, ${120 * 100} cells): ${exampleMs.toFixed(1)} ms per check`)
  // A big, busy room: 10 x 8 m with 40 boxes at odd angles.
  const objects: WorldObject[] = []
  for (let k = 0; k < 40; k++) {
    objects.push(box(`b${k}`, -4 + (k % 8) * 1.1, -3 + Math.floor(k / 8) * 1.4, 0.6, 0.4, { turn: k * 0.37 }))
  }
  const big: World = { ...room(objects, [-4.6, -3.6], [4.6, 3.6]), room: { bounds: { min: [-5, 0, -4], max: [5, 2.5, 4] }, floor_y: 0 } }
  let bigMs = 0
  for (const width of [0.5, 0.85]) {
    const ms = time(big, width, 20)
    bigMs = Math.max(bigMs, ms)
    const r = checkClearance(big, width)
    console.log(`       big room (10 x 8 m, 40 boxes, ${r.gridInfo.nx * r.gridInfo.nz} cells), ${width} m wide: ${ms.toFixed(1)} ms per check (${r.reachable ? 'reachable' : 'blocked'})`)
  }
  check(exampleMs < 50 && bigMs < 100, 'fast enough on a laptop (a phone is roughly 3 to 5 times slower; the budget there is 200 ms)')
}

console.log(`\n${passes} passed, ${failures.length} failed`)
if (failures.length > 0) {
  console.log('FAILED:\n' + failures.map((f) => `  - ${f}`).join('\n'))
  process.exit(1)
}
