// Offline test of the toy-sized character running on a scan (as raw triangles), with the real Rapier physics. Run: node scripts/test-tiny-play.ts
import RAPIER from '@dimforge/rapier3d-compat'
import { newMotionState, stepCharacter } from '../src/motion.ts'
import { applyProfile, PROFILES } from '../src/profile.ts'
import { CHARACTER, FIXED_DT, buildPhysicsWorld, createCharacterBody, initPhysics } from '../src/physics.ts'
import type { World } from '../src/world.ts'

await initPhysics()
const failures: string[] = []
const check = (ok: boolean, what: string) => {
  if (!ok) failures.push(what)
}

// A scan is just triangles. Build a floor (slightly ABOVE the world's floor_y, like a real scan), a low sofa and a tall bookshelf.
const vertices: number[] = []
const indices: number[] = []
function quad(a: number[], b: number[], c: number[], d: number[]) {
  const base = vertices.length / 3
  vertices.push(...a, ...b, ...c, ...d)
  indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
}
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) {
  quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]) // bottom
  quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]) // top
  quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0])
  quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1])
  quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0])
  quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1])
}
const FLOOR = 0.02 // the scan's floor sits 2 cm above world.json's floor_y
quad([-3, FLOOR, -3], [-3, FLOOR, 3], [3, FLOOR, 3], [3, FLOOR, -3])
box(1.0, FLOOR, -0.4, 1.8, FLOOR + 0.45, 0.4) // sofa: 45 cm tall
box(-2.0, FLOOR, -0.4, -1.6, FLOOR + 1.3, 0.4) // bookshelf: 1.3 m tall
const scan = { vertices: new Float32Array(vertices), indices: new Uint32Array(indices) }
const world = { room: { bounds: { min: [-3, 0, -3], max: [3, 2.4, 3] }, floor_y: 0 }, objects: [], spawn: [0, 0, 0], goal: [0, 0, 0] } as unknown as World

function newRun(profile: 'tiny' | 'human', start: [number, number, number], withScan = true) {
  const p = applyProfile(profile)
  const { physics } = buildPhysicsWorld(world, withScan ? scan : undefined)
  const body = createCharacterBody(physics, start)
  return { physics, body, state: newMotionState(), p, feetY: () => body.body.translation().y - CHARACTER.height / 2, pos: () => body.body.translation() }
}
type Run = ReturnType<typeof newRun>
function run(r: Run, seconds: number, wishX: number, wishZ: number, jumpAt: number[] = []) {
  const steps = Math.round(seconds / FIXED_DT)
  for (let i = 0; i < steps; i++) stepCharacter(r.physics, r.body, r.state, wishX, wishZ, jumpAt.includes(i))
}

// 1. it is toy-sized, and the human size is untouched
const tiny = applyProfile('tiny')
console.log(`tiny: ${CHARACTER.height} m tall, runs ${tiny.move.runSpeed} m/s, jumps ${(tiny.move.jumpSpeed ** 2 / (2 * tiny.move.gravity)).toFixed(2)} m`)
check(CHARACTER.height < 0.3, 'the character should be small')
applyProfile('human')
check(CHARACTER.height === 1.6 && PROFILES.human.move.runSpeed === 4 && PROFILES.human.move.jumpSpeed === 7 && PROFILES.human.camera.distance === 4 && PROFILES.human.camera.pitch === 0.35, "the human profile must keep Zac's original numbers")

// 2. it lands on the REAL floor (2 cm above floor_y) and stays there
let r = newRun('tiny', [0, 0.02, 0])
run(r, 1, 0, 0)
console.log(`standing: feet at ${r.feetY().toFixed(3)} m (scan floor is 0.020), grounded ${r.state.grounded}`)
check(r.state.grounded && Math.abs(r.feetY() - FLOOR) < 0.015, 'should stand on the scan floor')

// 3. it runs at about the tiny speed
r = newRun('tiny', [-1, FLOOR, 1.5])
run(r, 1, tiny.move.runSpeed, 0)
console.log(`ran for 1 s: moved ${(r.pos().x + 1).toFixed(2)} m`)
check(Math.abs(r.pos().x + 1 - tiny.move.runSpeed) < 0.15, `should cover about ${tiny.move.runSpeed} m in a second`)

// 4. it cannot simply walk up a 45 cm sofa (not a 3 cm step)
r = newRun('tiny', [0, FLOOR, 0])
run(r, 3, tiny.move.runSpeed, 0)
console.log(`walked at the sofa: stopped at x=${r.pos().x.toFixed(2)} (sofa edge at 1.00), feet y=${r.feetY().toFixed(2)}`)
check(r.pos().x < 1.0 && r.feetY() < FLOOR + 0.05, 'a 45 cm sofa should block walking')

// 5. but it can jump onto it: jump 30 cm before the edge, keep moving while in the air, then stop and see where it is
r = newRun('tiny', [0.7, FLOOR, 0])
run(r, 0.6, tiny.move.runSpeed, 0, [0])
run(r, 1, 0, 0)
console.log(`jumped at the sofa: now at x=${r.pos().x.toFixed(2)}, feet y=${r.feetY().toFixed(2)} (sofa top is ${(FLOOR + 0.45).toFixed(2)})`)
check(Math.abs(r.feetY() - (FLOOR + 0.45)) < 0.03 && r.pos().x > 1.0 && r.pos().x < 1.8, 'should be standing on top of the sofa')

// 6. a 1.3 m bookshelf is too tall to jump onto
r = newRun('tiny', [-1.3, FLOOR, 0])
run(r, 0.3, -tiny.move.runSpeed, 0, [0])
run(r, 2, -tiny.move.runSpeed, 0, [30, 90])
console.log(`tried the bookshelf: feet y=${r.feetY().toFixed(2)}, x=${r.pos().x.toFixed(2)}`)
check(r.feetY() < 0.8 && r.pos().x > -1.6, 'should not get onto a 1.3 m bookshelf')

// 7. the invisible room walls hold, and nothing falls through the floor
r = newRun('tiny', [2.5, FLOOR, 2.5])
run(r, 4, tiny.move.runSpeed, tiny.move.runSpeed)
console.log(`ran into the corner: x=${r.pos().x.toFixed(2)} z=${r.pos().z.toFixed(2)} (walls at 3.00)`)
check(r.pos().x < 3.01 && r.pos().z < 3.01 && r.feetY() > -0.05, 'walls must hold and the floor must catch you')

// 8. with NO scan (the example rooms) the old box-based behaviour is unchanged: person-sized, standing on floor_y
r = newRun('human', [0, 0, 0], false)
run(r, 1, 0, 0)
check(r.state.grounded && Math.abs(r.feetY()) < 0.02 && CHARACTER.height === 1.6, 'person-sized play on boxes must still work')

console.log(failures.length ? `\nFAIL:\n - ${failures.join('\n - ')}` : '\nPASS')
process.exit(failures.length ? 1 : 0)
