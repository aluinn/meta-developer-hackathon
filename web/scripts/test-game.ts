// Offline test of the race rules (game.ts) on a flat pretend room. No physics, no browser. Run: node scripts/test-game.ts
import { generateCourse, type Course } from '../src/course.ts'
import { Game, ITEM_KINDS, TUNING, type GameEvent, type ItemKind } from '../src/game.ts'
import { buildGraph } from '../src/walkGraph.ts'
import type { Vec3 } from '../src/world.ts'

const failures: string[] = []
const check = (ok: boolean, what: string) => {
  if (!ok) failures.push(what)
}
const UNIT = 0.22
const RUN = 1.1
const DT = 1 / 60

const graph = buildGraph({ surfaces: () => [0] }, { min: [-2, 0, -2], max: [2, 2, 2], cell: 0.1, margin: 0.06, stepUp: 0.03, jumpUp: 0.4 })
function makeGame(seed = 3): Game {
  const course = generateCourse(graph, [-1.5, 0, 1.5], { seed, checkpoints: 4, hazards: 3, unit: UNIT, runSpeed: RUN, elevatedMin: 0.11 }) as Course
  return new Game(course, { unit: UNIT, runSpeed: RUN, seed })
}
/** Advance the game; `at` is where the player stands (a fixed spot, or a function of time). Returns every event. */
function run(game: Game, seconds: number, at: Vec3 | ((t: number) => Vec3), safe = false): GameEvent[] {
  const events: GameEvent[] = []
  for (let t = 0; t < seconds; t += DT) {
    if (safe) game.invulnerable = 99
    events.push(...game.update(DT, typeof at === 'function' ? at(t) : at))
  }
  return events
}
const kinds = (events: GameEvent[], type: string) => events.filter((e) => e.type === type)
const FAR_FROM_EVERYTHING: Vec3 = [-1.9, 0, 1.9]
function startRunning(game: Game): void {
  run(game, TUNING.countdownSeconds + 0.1, game.startPos)
  game.invulnerable = 0
}

// ---- 1. the countdown ----
let game = makeGame()
console.log(`course: ${game.course.checkpoints.length} gates, ${game.course.items.length} boxes, ${game.course.hazards.length} hazards; time limit ${game.totalTime} s`)
check(game.phase === 'countdown' && !game.modifiers().canMove, 'the race starts with a countdown, and you cannot move yet')
let events = run(game, TUNING.countdownSeconds - 0.2, game.startPos)
check(game.phase === 'countdown' && game.timeLeft === game.totalTime, 'the clock must not run during the countdown')
events = run(game, 0.4, game.startPos)
check(game.phase === 'running' && kinds(events, 'go').length === 1 && game.modifiers().canMove, 'GO! after the countdown, and you can move')

// ---- 2. running out of time ----
game = makeGame()
startRunning(game)
events = run(game, game.totalTime + 2, FAR_FROM_EVERYTHING, true)
check(game.phase === 'lost' && kinds(events, 'lose').length === 1 && game.timeLeft === 0, 'time runs out: you lose, once')
check(run(game, 2, FAR_FROM_EVERYTHING).length === 0 && !game.modifiers().canMove, 'after losing, nothing more happens and you cannot move')

// ---- 3. checkpoints: in order, with bonus time ----
game = makeGame()
startRunning(game)
const cps = game.course.checkpoints
events = run(game, 0.1, cps[1].pos, true)
check(game.cpIndex === 0 && kinds(events, 'checkpoint').length === 0, 'a gate out of order does not count')
const before = game.timeLeft
events = run(game, 0.05, cps[0].pos, true)
check(game.cpIndex === 1 && kinds(events, 'checkpoint').length === 1, 'the first gate counts')
check(game.timeLeft > before + TUNING.checkpointBonus - 0.2, `a gate adds ${TUNING.checkpointBonus} seconds`)
for (let i = 1; i < cps.length; i++) events = run(game, 0.05, cps[i].pos, true)
check(game.cpIndex === cps.length && kinds(events, 'flagUnlocked').length === 1, 'the last gate unlocks the flag')
check(game.respawnPoint()[0] === cps[cps.length - 1].pos[0], 'after a fall you restart at the last gate you passed')
game = makeGame()
check(game.respawnPoint()[0] === game.startPos[0], 'before any gate you restart at the start')

// ---- 4. item boxes ----
game = makeGame()
startRunning(game)
const [box0, box1] = game.items
events = run(game, 0.05, box0.pos, true)
check(game.held !== null && kinds(events, 'item').length === 1 && !box0.active, 'touching a box gives an item and uses the box up')
const first = game.held
events = run(game, 0.5, box0.pos, true)
check(kinds(events, 'item').length === 0 && game.held === first, 'a used-up box gives nothing')
events = run(game, 1, box1.pos, true)
check(kinds(events, 'itemFull').length === 1 && box1.active && game.held === first, 'a second box while holding an item says "full" once, and stays for later')
run(game, TUNING.itemRespawnSeconds + 1, FAR_FROM_EVERYTHING, true)
check(box0.active, 'a used box comes back after a while')
const counts: Record<string, number> = {}
for (let i = 0; i < 300; i++) {
  const g = makeGame(i + 1)
  startRunning(g)
  g.invulnerable = 99
  g.update(DT, g.items[0].pos)
  counts[g.held ?? 'none'] = (counts[g.held ?? 'none'] ?? 0) + 1
}
console.log('item mix over 300 boxes:', JSON.stringify(counts))
check(ITEM_KINDS.every((k) => (counts[k] ?? 0) > 10), 'every kind of item should come up')

// ---- 5. what each item does ----
for (const kind of ITEM_KINDS) {
  game = makeGame()
  startRunning(game)
  game.give(kind)
  events = game.useItem()
  const m = game.modifiers()
  check(kinds(events, 'use').length === 1 && game.held === null, `${kind}: using it empties your hand`)
  if (kind === 'boost') check(m.speedMult === TUNING.boostSpeed, 'boost: runs faster')
  if (kind === 'spring') check(m.jumpSpeedMult === TUNING.springJump, 'super jump: jumps higher')
  if (kind === 'wings') check(m.flying, 'wings: flying')
  if (kind === 'shield') check(game.effects.shield > 10, 'shield: protects')
  if (kind === 'freeze') check(game.flag.tired >= 3.9 && game.flag.frozen, 'freeze: the flag is frozen')
  const lasts = run(game, 20, FAR_FROM_EVERYTHING, true)
  check(kinds(lasts, 'effectEnd').some((e) => e.type === 'effectEnd' && e.kind === kind) || kind === 'freeze', `${kind}: wears off`)
  check(game.modifiers().speedMult === 1 && !game.modifiers().flying && game.modifiers().jumpSpeedMult === 1, `${kind}: back to normal afterwards`)
}
check(makeGame().useItem().length === 0, 'using nothing does nothing')

// ---- 6. hazards ----
game = makeGame()
startRunning(game)
const h0 = game.hazards[0]
let reversed = false
let lastDir = h0.dir
let maxOff = 0
for (let t = 0; t < 30; t += DT) {
  game.invulnerable = 99
  game.update(DT, FAR_FROM_EVERYTHING)
  if (h0.dir !== lastDir) reversed = true
  lastDir = h0.dir
  // distance from the segment a-b
  const [ax, , az] = h0.def.a
  const [bx, , bz] = h0.def.b
  const l2 = (bx - ax) ** 2 + (bz - az) ** 2
  const u = Math.max(0, Math.min(1, ((h0.pos[0] - ax) * (bx - ax) + (h0.pos[2] - az) * (bz - az)) / l2))
  maxOff = Math.max(maxOff, Math.hypot(h0.pos[0] - (ax + u * (bx - ax)), h0.pos[2] - (az + u * (bz - az))))
}
check(reversed && maxOff < 1e-6, 'a hazard rolls back and forth along its line')
game = makeGame()
startRunning(game)
let t0 = game.timeLeft
events = game.update(DT, [game.hazards[0].pos[0], 0, game.hazards[0].pos[2]])
check(kinds(events, 'hit').length === 1 && game.stun > 0.9 && game.hits === 1 && !game.modifiers().canMove, 'a hazard hit stuns you')
check(game.timeLeft < t0 - TUNING.hitPenalty + 0.1, `a hit costs ${TUNING.hitPenalty} seconds`)
events = game.update(DT, [game.hazards[0].pos[0], 0, game.hazards[0].pos[2]])
check(kinds(events, 'hit').length === 0, 'right after a hit you are safe for a moment')
run(game, TUNING.stunSeconds + 0.1, FAR_FROM_EVERYTHING, false)
check(game.modifiers().canMove, 'the stun wears off')
game = makeGame()
startRunning(game)
game.give('shield')
game.useItem()
t0 = game.timeLeft
events = game.update(DT, [game.hazards[0].pos[0], 0, game.hazards[0].pos[2]])
check(events.some((e) => e.type === 'hit' && e.blocked) && game.stun === 0 && game.hits === 0 && game.effects.shield === 0 && game.timeLeft > t0 - 0.1, 'a shield blocks one hit, with no stun and no time lost, and is used up')
game = makeGame()
startRunning(game)
events = game.update(DT, [game.hazards[0].pos[0], game.hazards[0].def.radius * 2 + 0.02, game.hazards[0].pos[2]])
check(kinds(events, 'hit').length === 0, 'you can jump over a hazard')

// ---- 7. the flag ----
game = makeGame()
startRunning(game)
const flagStart = [...game.flag.pos]
let travelled = 0
let prev = [...game.flag.pos]
let maxStep = 0
for (let t = 0; t < 12; t += DT) {
  game.invulnerable = 99
  game.update(DT, FAR_FROM_EVERYTHING)
  travelled += Math.hypot(game.flag.pos[0] - prev[0], game.flag.pos[2] - prev[2])
  maxStep = Math.max(maxStep, Math.hypot(game.flag.pos[0] - prev[0], game.flag.pos[2] - prev[2]))
  prev = [...game.flag.pos]
  check(Math.abs(game.flag.pos[0]) <= 2 && Math.abs(game.flag.pos[2]) <= 2 && Math.abs(game.flag.pos[1]) < 0.05, 'the flag stays on the ground inside the room')
}
console.log(`locked flag wandered ${travelled.toFixed(2)} m in 12 s (patrol speed ${(RUN * TUNING.flagPatrolSpeed).toFixed(2)} m/s)`)
check(travelled > 1 && Math.hypot(game.flag.pos[0] - flagStart[0], game.flag.pos[2] - flagStart[2]) >= 0 && maxStep / DT < RUN * TUNING.flagPatrolSpeed * 1.2, 'while locked the flag wanders slowly')
game = makeGame()
startRunning(game)
game.invulnerable = 99
events = game.update(DT, [game.flag.pos[0], 0, game.flag.pos[2]])
check(game.phase === 'running' && kinds(events, 'flagLocked').length === 1, 'touching the flag before passing every gate does not win')
events = game.update(DT, [game.flag.pos[0], 0, game.flag.pos[2]])
check(kinds(events, 'flagLocked').length === 0, '...and the warning is not repeated every frame')

function unlocked(seed = 3): Game {
  const g = makeGame(seed)
  startRunning(g)
  g.cpIndex = g.course.checkpoints.length
  return g
}
game = unlocked()
const fx = game.flag.pos
const chaser: Vec3 = [fx[0] + 0.4, 0, fx[2]]
const gap0 = Math.hypot(chaser[0] - fx[0], chaser[2] - fx[2])
run(game, 3, chaser, true)
const gap1 = Math.hypot(chaser[0] - game.flag.pos[0], chaser[2] - game.flag.pos[2])
console.log(`flag runs away: gap ${gap0.toFixed(2)} m -> ${gap1.toFixed(2)} m after 3 s`)
check(gap1 > gap0 + 0.5, 'once unlocked, the flag runs away from you')
game = unlocked()
events = run(game, 6, [0, 0, 0], true)
check(kinds(events, 'flagTired').length >= 1, 'the fleeing flag gets tired')
const tiredAt = game.flag.tired > 0 ? game.flag.pos.slice() : null
game = unlocked()
let seenTired = false
let moveWhileTired = 0
let lastPos = [...game.flag.pos]
for (let t = 0; t < 8; t += DT) {
  game.invulnerable = 99
  game.update(DT, [0, 0, 0])
  if (game.flag.tired > 0 && seenTired) moveWhileTired += Math.hypot(game.flag.pos[0] - lastPos[0], game.flag.pos[2] - lastPos[2])
  if (game.flag.tired > 0) seenTired = true
  lastPos = [...game.flag.pos]
}
void tiredAt
check(seenTired && moveWhileTired < 1e-6, 'a tired flag stands still')
game = unlocked()
game.give('freeze')
game.useItem()
const frozenPos = [...game.flag.pos]
run(game, 3.5, [0, 0, 0], true)
check(Math.hypot(game.flag.pos[0] - frozenPos[0], game.flag.pos[2] - frozenPos[2]) < 1e-6, 'a frozen flag does not move')
run(game, 2, [0, 0, 0], true)
check(Math.hypot(game.flag.pos[0] - frozenPos[0], game.flag.pos[2] - frozenPos[2]) > 0.1, '...and moves again when the freeze ends')
game = unlocked()
game.flag.tired = 5
const beforeTag = game.timeLeft
const tagPlayer: Vec3 = [game.flag.pos[0], 0, game.flag.pos[2]] // where you stand when you catch it
events = game.update(DT, tagPlayer)
check(game.phase === 'running' && game.tags === 1 && kinds(events, 'tag').length === 1 && kinds(events, 'win').length === 0, 'the first catch is a tag, not yet a win')
check(game.timeLeft > beforeTag + TUNING.tagBonus - 0.1, `a tag adds ${TUNING.tagBonus} seconds`)
const sent = Math.hypot(game.flag.pos[0] - tagPlayer[0], game.flag.pos[2] - tagPlayer[2])
console.log(`after a tag the flag reappears ${sent.toFixed(2)} m away`)
check(sent > 1.5 && game.flag.tired === 0, 'after a tag the flag reappears far away and takes off')
check(game.update(DT, tagPlayer).filter((e) => e.type === 'tag').length === 0, 'standing where you caught it does not tag again')
for (let n = 2; n <= TUNING.tagsNeeded; n++) {
  game.flag.tired = 5
  events = game.update(DT, [game.flag.pos[0], 0, game.flag.pos[2]])
}
check(game.phase === 'won' && game.tags === TUNING.tagsNeeded && kinds(events, 'win').length === 1, `catching the flag ${TUNING.tagsNeeded} times wins`)
check(!game.modifiers().canMove && run(game, 1, [0, 0, 0]).length === 0, 'after winning the race is over')
game = unlocked()

// ---- 8. how hard is it? a perfect chaser that heads straight for the flag, at different speeds ----
function chase(speed: number, seed: number, seconds = 60): number | null {
  const g = unlocked(seed)
  const p: Vec3 = [...g.startPos] as Vec3
  for (let t = 0; t < seconds; t += DT) {
    g.invulnerable = 99
    const dx = g.flag.pos[0] - p[0]
    const dz = g.flag.pos[2] - p[2]
    const d = Math.hypot(dx, dz) || 1
    const step = Math.min(d, speed * DT)
    p[0] += (dx / d) * step
    p[2] += (dz / d) * step
    g.update(DT, p)
    if (g.phase === 'won') return t
  }
  return null
}
const seeds = [1, 2, 3, 4, 5, 6, 7, 8]
const average = (xs: Array<number | null>) => {
  const done = xs.filter((x): x is number => x !== null)
  return done.length ? done.reduce((a, b) => a + b, 0) / done.length : Infinity
}
const slowTimes = seeds.map((s) => chase(0.55, s))
const normalTimes = seeds.map((s) => chase(RUN, s))
const boostTimes = seeds.map((s) => chase(RUN * TUNING.boostSpeed, s))
console.log(`all ${TUNING.tagsNeeded} tags by a PERFECT chaser: slow runner ${slowTimes.filter((x) => x !== null).length}/8; normal runner ${normalTimes.filter((x) => x !== null).length}/8 in ${average(normalTimes).toFixed(0)} s on average; boosted runner ${boostTimes.filter((x) => x !== null).length}/8 in ${average(boostTimes).toFixed(0)} s`)
check(slowTimes.filter((x) => x !== null).length === 0, 'a slow runner cannot catch the flag')
check(normalTimes.filter((x) => x !== null).length >= 6 && average(normalTimes) >= 10, 'even a perfect normal runner needs a real chase (10+ s) to land all the tags')
check(average(boostTimes) < average(normalTimes) * 0.6, 'a Boost makes the chase much shorter')

console.log(failures.length ? `\nFAIL:\n - ${failures.join('\n - ')}` : '\nPASS')
process.exit(failures.length ? 1 : 0)
