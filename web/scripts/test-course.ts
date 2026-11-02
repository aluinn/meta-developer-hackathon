// Offline test of the walkable map and the course generator on a pretend scan, with real Rapier. Run: node scripts/test-course.ts
import { generateCourse, makeRng, type Course } from '../src/course.ts'
import { createProbe } from '../src/probe.ts'
import { applyProfile } from '../src/profile.ts'
import { CHARACTER, buildPhysicsWorld, initPhysics } from '../src/physics.ts'
import { buildGraph, pathTo, shortestPaths } from '../src/walkGraph.ts'
import { MOVE } from '../src/motion.ts'
import type { World } from '../src/world.ts'

await initPhysics()
const failures: string[] = []
const check = (ok: boolean, what: string) => {
  if (!ok) failures.push(what)
}

// ---- a pretend scan, as raw triangles: floor, ceiling, sofa (45 cm), ottoman (27 cm), table (70 cm), tall shelf (1.3 m) ----
const vertices: number[] = []
const indices: number[] = []
function quad(a: number[], b: number[], c: number[], d: number[]) {
  const base = vertices.length / 3
  vertices.push(...a, ...b, ...c, ...d)
  indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
}
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) {
  quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1])
  quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0])
  quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0])
  quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1])
  quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0])
  quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1])
}
const F = 0.02
quad([-3, F, -3], [-3, F, 3], [3, F, 3], [3, F, -3]) // floor
quad([-3, 2.4, -3], [3, 2.4, -3], [3, 2.4, 3], [-3, 2.4, 3]) // ceiling
box(1.0, F, -0.4, 1.8, F + 0.45, 0.4) // sofa
box(-1.2, F, 1.2, -0.7, F + 0.27, 1.7) // ottoman
box(-0.5, F, -1.8, 0.5, F + 0.7, -1.2) // table: too high to jump onto
box(-2.4, F, -0.5, -2.0, F + 1.3, 0.5) // shelf: much too high
const scan = { vertices: new Float32Array(vertices), indices: new Uint32Array(indices) }
const world = { room: { bounds: { min: [-3, 0, -3], max: [3, 2.4, 3] }, floor_y: 0 }, objects: [], spawn: [-2, 0, 2], goal: [0, 0, 0] } as unknown as World

const profile = applyProfile('tiny')
const { physics } = buildPhysicsWorld(world, scan)
const jumpHeight = MOVE.jumpSpeed ** 2 / (2 * MOVE.gravity)
const probe = createProbe(physics, 2.5, CHARACTER.height)
const options = { min: world.room.bounds.min, max: world.room.bounds.max, cell: 0.1, margin: CHARACTER.radius * 1.2, stepUp: CHARACTER.stepHeight, jumpUp: jumpHeight * 0.85 } as const
let t = performance.now()
const graph = buildGraph(probe, options as never)
console.log(`walkable map: ${graph.nodes.length} spots, ${graph.adj.reduce((n, a) => n + a.length, 0) / 2} links, built in ${Math.round(performance.now() - t)} ms (jump height ${jumpHeight.toFixed(2)} m)`)

const heights = (pred: (y: number) => boolean) => graph.nodes.filter((n) => pred(n.y)).length
check(heights((y) => Math.abs(y - F) < 0.011) > 1000, 'the floor should have lots of spots')
check(heights((y) => Math.abs(y - (F + 0.45)) < 0.011) > 20, 'the sofa top should have spots')
check(heights((y) => Math.abs(y - (F + 0.27)) < 0.011) > 10, 'the ottoman top should have spots')
check(heights((y) => Math.abs(y - (F + 1.3)) < 0.011) > 5, 'the shelf top has spots (they just cannot be reached)')
// nothing under the table or in the sofa: spots inside furniture would be wrong
const inside = graph.nodes.filter((n) => n.x > -0.45 && n.x < 0.45 && n.z > -1.75 && n.z < -1.25 && n.y < 0.5 && n.y > 0.05)
check(inside.length === 0, `no spots inside the table (found ${inside.length})`)
check(graph.nodes.every((n) => n.x > -3 && n.x < 3 && n.z > -3 && n.z < 3), 'all spots are inside the room')

// ---- reachability from the spawn: sofa and ottoman can be jumped onto, the table and shelf cannot ----
const start = graph.nearest(-2, F, 2) as number
const paths = shortestPaths(graph, start)
const reach = (x: number, y: number, z: number) => Number.isFinite(paths.cost[graph.nearest(x, y, z) as number])
check(reach(1.4, F + 0.45, 0), 'the sofa top should be reachable (by jumping)')
check(reach(-0.95, F + 0.27, 1.45), 'the ottoman top should be reachable')
check(!reach(0, F + 0.7, -1.5), 'the table top must NOT be reachable (too high)')
check(!reach(-2.2, F + 1.3, 0), 'the shelf top must NOT be reachable')
const sofaPath = pathTo(paths, graph.nearest(1.4, F + 0.45, 0) as number)
check(sofaPath.some((n, i) => i > 0 && graph.adj[sofaPath[i - 1]].find((e) => e.to === n)?.jump), 'the way onto the sofa should include a jump')
const walkOnly = shortestPaths(graph, start, Infinity, false)
check(!Number.isFinite(walkOnly.cost[graph.nearest(1.4, F + 0.45, 0) as number]), 'walking alone cannot get onto the sofa')

// ---- the course ----
const opts = { seed: 7, checkpoints: 4, hazards: 3, unit: CHARACTER.height, runSpeed: MOVE.runSpeed, elevatedMin: CHARACTER.height * 0.5 }
t = performance.now()
const course = generateCourse(graph, [-2, F, 2], opts) as Course
console.log(`course made in ${Math.round(performance.now() - t)} ms: ${course.checkpoints.length} checkpoints, ${course.items.length} item boxes, ${course.hazards.length} hazards, route ${course.routeLength.toFixed(1)} m, climbs: ${course.climbs}`)
console.log('checkpoints:', course.checkpoints.map((c) => c.pos.map((v) => v.toFixed(2)).join(',')).join('  ->  '))
check(course !== null && course.checkpoints.length >= 3, 'should make at least 3 checkpoints')
check(course.climbs, 'one checkpoint should be up on the furniture, so the player must jump')
for (const c of course.checkpoints) check(Number.isFinite(paths.cost[c.node]), 'every checkpoint must be reachable')
const sep = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[2] - b[2])
for (let i = 0; i < course.checkpoints.length; i++) {
  for (let j = i + 1; j < course.checkpoints.length; j++) check(sep(course.checkpoints[i].pos, course.checkpoints[j].pos) > 0.5, 'checkpoints should be well apart')
}
check(course.items.length >= 3, 'should have at least 3 item boxes')
check(course.items.some((it) => it.pos[1] - F > CHARACTER.height * 0.5), 'one item box should sit up on the furniture as a reward')
for (const it of course.items) check(Number.isFinite(paths.cost[it.node]), 'every item box must be reachable')
check(course.hazards.length >= 1, 'should have hazards')
for (const h of course.hazards) {
  check(Math.hypot(h.a[0] - h.b[0], h.a[2] - h.b[2]) >= 0.3, 'a hazard needs room to roll')
  check(Math.abs(h.a[1] - h.b[1]) < 0.06, 'a hazard rolls on level ground')
  check(sep(h.a, [-2, 0, 2]) > 0.4 && sep(h.b, [-2, 0, 2]) > 0.4, 'no hazard right on the start')
}
check(Math.abs(graph.nodes[course.flagStart].y - F) < 0.05, 'the flag starts on the floor level')
const fs = graph.nodes[course.flagStart]
check(Math.hypot(fs.x - -2, fs.z - 2) > 1.0, `the flag must not start near the spawn (it started ${Math.hypot(fs.x + 2, fs.z - 2).toFixed(2)} m away)`)
for (const c of course.checkpoints) check(Math.hypot(fs.x - c.pos[0], fs.z - c.pos[2]) > 0.4, 'the flag must not start on top of a gate')
check(Number.isFinite(shortestPaths(graph, course.checkpoints.at(-1)!.node).cost[course.flagStart]), 'the flag must be reachable from the last gate')

// ---- same seed = same course; different seed = different course; a tiny or empty place = no course ----
const again = generateCourse(graph, [-2, F, 2], opts) as Course
check(JSON.stringify(again.checkpoints.map((c) => c.node)) === JSON.stringify(course.checkpoints.map((c) => c.node)), 'the same seed should make the same course')
const others = [1, 2, 3, 4, 5].map((seed) => (generateCourse(graph, [-2, F, 2], { ...opts, seed }) as Course).items.map((i) => i.node).join(','))
check(new Set(others).size > 1, 'different seeds should move the item boxes')
// a coarse map for a person-sized character (the built-in example room: 6 x 5 m, 0.4 m cells) still gets a proper course
const coarse = buildGraph({ surfaces: () => [0] }, { min: [-3, 0, -2.5], max: [3, 2.5, 2.5], cell: 0.4, margin: 0.3, stepUp: 0.3, jumpUp: 1.0 })
const roomy = generateCourse(coarse, [-2.2, 0, 1.8], { seed: 5, checkpoints: 4, hazards: 3, unit: 1.6, runSpeed: 4, elevatedMin: 0.8 }) as Course
console.log(`person-sized room: ${roomy.checkpoints.length} gates, ${roomy.items.length} boxes, ${roomy.hazards.length} hazards`)
check(roomy.checkpoints.length >= 3 && roomy.hazards.length >= 1 && roomy.items.length >= 3, 'a person-sized room on a coarse map should still get gates, boxes AND hazards')
const emptyGraph = buildGraph({ surfaces: () => [] }, options as never)
check(generateCourse(emptyGraph, [0, 0, 0], opts) === null, 'no ground at all: no course')
const tinyGraph = buildGraph({ surfaces: (x, z) => (Math.abs(x) < 0.2 && Math.abs(z) < 0.2 ? [0] : []) }, options as never)
check(generateCourse(tinyGraph, [0, 0, 0], opts) === null, 'a room too small to race in: no course')
check(makeRng(1)() !== makeRng(2)() && makeRng(5)() === makeRng(5)(), 'the random generator should be seedable')

console.log(failures.length ? `\nFAIL:\n - ${failures.join('\n - ')}` : '\nPASS')
process.exit(failures.length ? 1 : 0)
