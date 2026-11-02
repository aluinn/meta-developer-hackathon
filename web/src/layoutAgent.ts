// The layout agent's side of things, with no three.js or browser code (so it can be tested on its own, node scripts/test-layout.ts):
// - the shapes the server's /layout, /render and /score answers have (docs/architecture.md), and checkers for them;
// - a pretend layout agent, used while USE_FAKE_SERVER is true: it works on ANY world, moving one or two movable objects;
// - the before/after walkability comparison. Every walkability number comes from checkClearance (clearance.ts), never recomputed.

import { checkClearance, personLabel, ROOMY_GAP_CM, type ClearanceResult } from './clearance.ts'
import { parseWorld, type Vec3, type World, type WorldObject } from './world.ts'

// ---------- What the server sends back ----------

export interface LayoutMove {
  position: Vec3
  rotation_y: number
}
export interface LayoutChange {
  id: string
  label: string
  from: LayoutMove
  to: LayoutMove
  reason: string
}
export interface LayoutResult {
  goal: string
  /** The whole room with the moves applied (only movable objects ever move; nothing is added or removed). */
  world: World
  changes: LayoutChange[]
  /** Anything the agent could not do, e.g. "I can't add new furniture". Empty if nothing to say. */
  notes: string
  attempts: number
}
export interface RenderResult {
  /** Web addresses of the two pictures, or null when there are none (the pretend server draws nothing). */
  beforeUrl: string | null
  afterUrl: string | null
  moved: Array<{ id: string; label: string }>
  /** Roughly how much of the photo changed, 0 to 1 (null = could not tell). */
  changedFraction: number | null
  /** The AI probably changed more than the moved furniture. */
  likelyChangedTooMuch: boolean
}
export interface ScoreResult {
  /** How closely the 3D model matches the scanned room, 0 to 100. */
  overallPercent: number
  warnings: string[]
  /** True when the number is made up by the pretend server. */
  pretend: boolean
}

/** The scan id inside world.source_scan ("<32 hex characters>/original.glb"), or null for rooms that were not scanned (the examples). */
export function scanIdOf(world: World): string | null {
  const id = world.source_scan.split('/')[0]
  return /^[0-9a-f]{32}$/i.test(id) ? id : null
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

function asMove(v: unknown): LayoutMove | null {
  if (!isObj(v) || !Array.isArray(v.position) || v.position.length !== 3 || !v.position.every((n) => typeof n === 'number')) return null
  return { position: [v.position[0], v.position[1], v.position[2]], rotation_y: typeof v.rotation_y === 'number' ? v.rotation_y : 0 }
}

/** Check the answer of POST /layout. Throws an Error with a plain message if it isn't what the contract promises. */
export function parseLayoutResponse(data: unknown, goal: string): LayoutResult {
  if (!isObj(data)) throw new Error('no answer')
  const world = parseWorld(data.world)
  const changes: LayoutChange[] = []
  for (const c of Array.isArray(data.changes) ? data.changes : []) {
    if (!isObj(c) || typeof c.id !== 'string') continue
    const from = asMove(c.from)
    const to = asMove(c.to)
    if (!from || !to) continue
    changes.push({
      id: c.id,
      label: typeof c.label === 'string' && c.label !== '' ? c.label : c.id,
      from,
      to,
      reason: typeof c.reason === 'string' ? c.reason : '',
    })
  }
  return {
    goal,
    world,
    changes,
    notes: typeof data.notes === 'string' ? data.notes.trim() : '',
    attempts: typeof data.attempts === 'number' ? data.attempts : 1,
  }
}

// ---------- Floor geometry for the pretend agent ----------

/** A box's footprint on the floor, turned by rotation_y (same convention as three.js and clearance.ts). */
interface Rect {
  cx: number
  cz: number
  hw: number // half the size along the box's own x
  hd: number // half the size along the box's own z
  cos: number
  sin: number
}

const rectOf = (o: { position: Vec3; size: Vec3; rotation_y: number }, x = o.position[0], z = o.position[2]): Rect => ({
  cx: x,
  cz: z,
  hw: o.size[0] / 2,
  hd: o.size[2] / 2,
  cos: Math.cos(o.rotation_y),
  sin: Math.sin(o.rotation_y),
})

/** Do two footprints overlap, or come closer than `gap` metres? (The "separating axis" test: two turned rectangles are apart if some
 *  line can be drawn between them along one of their four edge directions.) */
export function footprintsOverlap(a: Rect, b: Rect, gap = 0): boolean {
  const axes: Array<[number, number]> = [[a.cos, -a.sin], [a.sin, a.cos], [b.cos, -b.sin], [b.sin, b.cos]]
  const reach = (r: Rect, ax: number, az: number) =>
    r.hw * Math.abs(r.cos * ax - r.sin * az) + r.hd * Math.abs(r.sin * ax + r.cos * az)
  for (const [ax, az] of axes) {
    const centres = Math.abs((b.cx - a.cx) * ax + (b.cz - a.cz) * az)
    if (centres > reach(a, ax, az) + reach(b, ax, az) + gap) return false
  }
  return true
}

/** Public so tests can check the pretend agent's moves: the footprint of an object (at its own spot, or at x, z). */
export const footprintOf = rectOf

/** How far a point is from a footprint (0 if inside). */
function distanceToRect(r: Rect, x: number, z: number): number {
  const lx = (x - r.cx) * r.cos - (z - r.cz) * r.sin
  const lz = (x - r.cx) * r.sin + (z - r.cz) * r.cos
  return Math.hypot(Math.max(Math.abs(lx) - r.hw, 0), Math.max(Math.abs(lz) - r.hd, 0))
}

function distanceToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax
  const dz = bz - az
  const length2 = dx * dx + dz * dz
  const t = length2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * dx + (pz - az) * dz) / length2))
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz))
}

/** The room edge must stay this far from furniture. */
const WALL_MARGIN_M = 0.05
/** Moved furniture keeps this far from other furniture. */
const NEIGHBOUR_GAP_M = 0.1
/** ...and this far from the start and the goal, so the person is never boxed in. */
const END_CLEARANCE_M = 0.6
/** The pretend agent looks this far from an object's old spot for a new one ("nearby"). */
const SEARCH_RADIUS_M = 2.2
const SEARCH_STEP_M = 0.1
/** It must really move: at least this far. */
const MIN_MOVE_M = 0.4
/** Moves at most this many objects. */
const MAX_MOVED = 2
/** An object this close to the walking route (edge to route) counts as "in the way". */
const IN_THE_WAY_M = 1.2
/** The pretend agent tries candidates like a wheelchair user would need: the widest of the three people. */
const TEST_WIDTH_M = 0.85

interface Candidate {
  x: number
  z: number
  score: number
}

/** Where could this object go? Inside the room, clear of everything else and of the start and goal. Best few first. */
function candidateSpots(world: World, obj: WorldObject, others: Rect[]): Candidate[] {
  const { min, max } = world.room.bounds
  const home = rectOf(obj)
  const spawn = world.spawn
  const goal = world.goal
  const reachOfBox = Math.hypot(home.hw, home.hd)
  const out: Candidate[] = []
  const steps = Math.ceil(SEARCH_RADIUS_M / SEARCH_STEP_M)
  for (let j = -steps; j <= steps; j++) {
    for (let i = -steps; i <= steps; i++) {
      const x = obj.position[0] + i * SEARCH_STEP_M
      const z = obj.position[2] + j * SEARCH_STEP_M
      const move = Math.hypot(x - obj.position[0], z - obj.position[2])
      if (move < MIN_MOVE_M || move > SEARCH_RADIUS_M) continue
      const r = rectOf(obj, x, z)
      // Inside the room: the turned box's outline must fit between the walls.
      const halfX = Math.abs(r.cos) * r.hw + Math.abs(r.sin) * r.hd
      const halfZ = Math.abs(r.sin) * r.hw + Math.abs(r.cos) * r.hd
      if (x - halfX < min[0] + WALL_MARGIN_M || x + halfX > max[0] - WALL_MARGIN_M) continue
      if (z - halfZ < min[2] + WALL_MARGIN_M || z + halfZ > max[2] - WALL_MARGIN_M) continue
      if (others.some((o) => footprintsOverlap(r, o, NEIGHBOUR_GAP_M))) continue
      if (distanceToRect(r, spawn[0], spawn[2]) < END_CLEARANCE_M || distanceToRect(r, goal[0], goal[2]) < END_CLEARANCE_M) continue
      // Better: further from the walking route (spawn to goal), tucked against a wall, and not too far to carry.
      const awayFromRoute = distanceToSegment(x, z, spawn[0], spawn[2], goal[0], goal[2]) - reachOfBox
      const againstWall = Math.min(x - halfX - min[0], max[0] - x - halfX, z - halfZ - min[2], max[2] - z - halfZ) < 0.15 ? 0.3 : 0
      out.push({ x, z, score: Math.min(awayFromRoute, 1.6) + againstWall - 0.25 * move })
    }
  }
  return out.sort((a, b) => b.score - a.score)
}

/** A copy of the world with one object put somewhere else. */
function withMoved(world: World, id: string, x: number, z: number): World {
  return {
    ...world,
    objects: world.objects.map((o) => (o.id === id ? { ...o, position: [x, o.position[1], z] as Vec3 } : o)),
  }
}

/** Is the room better walkable (for a wheelchair) than another? Used to pick between candidate spots. */
function walkScore(world: World): number {
  const r = checkClearance(world, TEST_WIDTH_M)
  const gap = r.narrowestGapCm ?? ROOMY_GAP_CM
  return (r.reachable ? 1000 : 0) + gap * 2 + r.reachablePercent
}

/** Time the pretend agent pretends to think, in milliseconds (the real one takes a while). */
export const FAKE_LAYOUT_MS = 1500

/**
 * The pretend layout agent. It finds the movable objects closest to the walking route and moves one or two of them to a nearby
 * open spot, trying the best few spots with the clearance check and keeping the one that leaves the most room. Deterministic: the same
 * world and goal always give the same answer. Works on any world (a room with nothing movable gets no changes and a note saying so).
 */
export function proposeFakeLayout(world: World, goal: string): LayoutResult {
  const result = (worldAfter: World, changes: LayoutChange[], notes: string): LayoutResult => ({ goal, world: worldAfter, changes, notes, attempts: 1 })
  const wantsAdding = /\b(add|buy|bring in|get me|get a|new (sofa|table|chair|desk|shelf|bed))\b/i.test(goal)
  const addNote = wantsAdding ? "I can't add new furniture, so I only moved what is already in the room." : ''

  const movable = world.objects.filter((o) => o.role === 'movable')
  if (movable.length === 0) {
    return result(world, [], `${addNote} This room has no movable furniture, so nothing could be moved.`.trim())
  }

  const [sx, , sz] = world.spawn
  const [gx, , gz] = world.goal
  const inTheWay = (o: WorldObject) => distanceToSegment(o.position[0], o.position[2], sx, sz, gx, gz) - Math.hypot(o.size[0], o.size[2]) / 2
  const order = [...movable].sort((a, b) => inTheWay(a) - inTheWay(b))
  const chosen = order.filter((o, k) => k === 0 || inTheWay(o) < IN_THE_WAY_M).slice(0, MAX_MOVED)

  let current = world
  const changes: LayoutChange[] = []
  for (const obj of chosen) {
    const others = current.objects.filter((o) => o.id !== obj.id).map((o) => rectOf(o))
    const best = candidateSpots(current, obj, others).slice(0, 8)
    if (best.length === 0) continue // nowhere to put it
    let pick = best[0]
    let pickScore = -Infinity
    for (const spot of best) {
      const s = walkScore(withMoved(current, obj.id, spot.x, spot.z)) + spot.score * 0.01 // the clearance check decides; the spot's own score breaks ties
      if (s > pickScore) {
        pickScore = s
        pick = spot
      }
    }
    const wasInTheWay = inTheWay(obj) < IN_THE_WAY_M
    changes.push({
      id: obj.id,
      label: obj.label,
      from: { position: obj.position, rotation_y: obj.rotation_y },
      to: { position: [pick.x, obj.position[1], pick.z], rotation_y: obj.rotation_y },
      reason: wasInTheWay
        ? 'It was on the walking route from the start to the goal, so it is moved to the side to leave a wider gap.'
        : 'Moved to the side to open up more floor space.',
    })
    current = withMoved(current, obj.id, pick.x, pick.z)
  }
  const nothing = changes.length === 0 ? 'There was no free spot nearby to move anything to.' : ''
  return result(current, changes, [addNote, nothing].filter(Boolean).join(' '))
}

// ---------- Before and after walkability ----------

export type Verdict = 'better' | 'worse' | 'same'

export interface Comparison {
  widthM: number
  label: string
  before: ClearanceResult
  after: ClearanceResult
  beforeText: string
  afterText: string
  verdict: Verdict
  /** One sentence, e.g. "Better: the goal is now reachable." */
  verdictText: string
}

/** One short phrase for a result, e.g. "blocked at a 77 cm gap, 54% of floor reachable" or "goal reachable, 81% of floor reachable, narrowest gap 95 cm". */
export function describeState(r: ClearanceResult): string {
  const floor = `${Math.round(r.reachablePercent)}% of floor reachable`
  if (r.reachable) {
    const gap = r.narrowestGapCm === null ? `no gaps under ${ROOMY_GAP_CM} cm` : `narrowest gap ${r.narrowestGapCm} cm`
    return `goal reachable, ${floor}, ${gap}`
  }
  const b = r.blockedAt
  const why =
    b?.reason === 'gap' ? `blocked at a ${b.gapCm} cm gap` : b?.reason === 'sealed' ? 'goal closed off by furniture' : b?.reason === 'start' ? 'no room at the start' : 'no room at the goal'
  return `${why}, ${floor}`
}

/** A change in "floor reachable" smaller than this many points is noise (moving a table nearer a wall can shave a point or two), so it doesn't make a layout better or worse. */
const MEANINGFUL_FLOOR_POINTS = 3

/** Better, worse or the same? First whether the goal can be reached, then the tightest gap (3 cm or more counts), then the floor reachable (3 points or more). */
export function verdictOf(before: ClearanceResult, after: ClearanceResult): Verdict {
  if (before.reachable !== after.reachable) return after.reachable ? 'better' : 'worse'
  // For a blocked room the "gap" is the gap that blocks; if there isn't one (sealed), count it as 0.
  const gapOf = (r: ClearanceResult): number => (r.reachable ? (r.narrowestGapCm ?? Infinity) : (r.blockedAt?.gapCm ?? 0))
  const gb = gapOf(before)
  const ga = gapOf(after)
  if (ga !== gb && !(Number.isFinite(ga) && Number.isFinite(gb) && Math.abs(ga - gb) < 3)) return ga > gb ? 'better' : 'worse'
  const diff = after.reachablePercent - before.reachablePercent
  if (Math.abs(diff) >= MEANINGFUL_FLOOR_POINTS) return diff > 0 ? 'better' : 'worse'
  return 'same'
}

const VERDICT_TEXT: Record<Verdict, (b: ClearanceResult, a: ClearanceResult) => string> = {
  better: (b, a) => (!b.reachable && a.reachable ? 'Better: the goal can now be reached.' : 'Better: more room to get through.'),
  worse: (b, a) => (b.reachable && !a.reachable ? 'Worse: the goal can no longer be reached.' : 'Worse: less room to get through.'),
  same: () => 'About the same.',
}

/** Walkability of the original room and the suggested one, for a person this wide. Both come from checkClearance. */
export function compareClearance(before: World, after: World, widthM: number): Comparison {
  const b = checkClearance(before, widthM)
  const a = checkClearance(after, widthM)
  const verdict = verdictOf(b, a)
  return {
    widthM,
    label: `${personLabel(widthM)} (${widthM.toFixed(2).replace(/0$/, '')} m)`,
    before: b,
    after: a,
    beforeText: describeState(b),
    afterText: describeState(a),
    verdict,
    verdictText: VERDICT_TEXT[verdict](b, a),
  }
}
