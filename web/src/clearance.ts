// THE CLEARANCE CHECK (Z4): can a person of a given width still get from the room's start to its goal?
// It works on the world.json BOXES only (not the scan), and has no three.js or browser code, so it can be tested on its own
// (node scripts/test-clearance.ts) and called by the before/after view (Z6) on both layouts.
//
// How it works:
// 1. Lay a grid of 5 cm squares ("cells") over the floor, inside room.bounds.
// 2. For every cell, measure how far its centre is from the nearest obstacle (a box that blocks walking, or a wall).
//    That distance is the cell's "clearance". A cell with clearance 0 is covered by furniture.
// 3. A person of width W fits at a cell if its clearance is at least W/2 (half their width on each side). This is the same as
//    making every obstacle fatter by W/2 ("inflating" it) and treating the person as a dot, which makes the rest simple.
// 4. Find the route that keeps the most room (a "widest path" search), then the shortest route that is just as roomy (A*),
//    and smooth it for drawing.
// 5. Work out the walkability score (defined once, below) and, if there is no route, where it gets blocked.

import type { Vec3, World } from './world.ts'

/** Size of one grid cell, in metres. */
export const CELL_M = 0.05
/**
 * Boxes whose BOTTOM is more than this above the floor are ignored: a person walks under them.
 * This is for things like a high shelf or a wall cupboard, which world.json describes as a box floating in the air.
 * (Measured from room.floor_y, which is not always 0.)
 */
export const HEAD_HEIGHT_M = 2.0
/** If the start or goal has no room for the person (common with real scans, where it can land inside furniture),
 *  we move it to the nearest cell with room, but never further than this. */
export const SNAP_LIMIT_M = 0.5
/** How strongly the route avoids going closer than ROOMY_M to furniture, like a real person (0 = pure shortest route). */
const COMFORT_WEIGHT = 2
/** Safety limit: a huge room (more than about 30 m x 30 m) gets bigger cells, so a phone stays quick. */
const MAX_CELLS = 400_000

/**
 * How wide each kind of person is, in metres. These are ESTIMATES for planning, not measurements:
 * shoulder width when walking, a typical walking frame, and a typical manual wheelchair plus hands on the wheels.
 */
export const PERSON_WIDTHS = {
  walking: { label: 'Walking', widthM: 0.5 },
  walker: { label: 'Walker', widthM: 0.7 },
  wheelchair: { label: 'Wheelchair', widthM: 0.85 },
} as const
export type PersonKind = keyof typeof PERSON_WIDTHS
/** "Walking", "Walker", "Wheelchair", or "Custom width" for anything else. */
export function personLabel(widthM: number): string {
  const kind = (Object.keys(PERSON_WIDTHS) as PersonKind[]).find((k) => Math.abs(PERSON_WIDTHS[k].widthM - widthM) < 1e-6)
  return kind ? PERSON_WIDTHS[kind].label : 'Custom width'
}
/** The range of the "any width" slider. */
export const WIDTH_SLIDER = { minM: 0.4, maxM: 1.2, stepM: 0.05 }

/** A point on the floor (world x and z, metres). Its height is room.floor_y. */
export interface FloorPoint {
  x: number
  z: number
}

/** The start or goal had to be moved so the person fits there. */
export interface Snap {
  from: FloorPoint
  to: FloorPoint
  movedCm: number
}

/**
 * Where the route is blocked, when the goal can't be reached:
 * - 'gap':    the best route has a gap narrower than the person. `gapCm` is its width; `at` is its middle.
 * - 'sealed': furniture closes the goal off completely. `at` is the reachable spot closest to the goal.
 * - 'start' / 'goal': there is no room for the person within SNAP_LIMIT_M of the start / goal. `at` is that point.
 */
export interface Blocked {
  at: FloorPoint
  reason: 'gap' | 'sealed' | 'start' | 'goal'
  gapCm: number | null
}

export interface GridInfo {
  cellM: number
  nx: number // cells along x
  nz: number // cells along z
  minX: number // the grid's corner (room.bounds.min)
  minZ: number
  floorY: number
  openCells: number // cells not covered by furniture
  ms: number // how long the whole check took
}

export interface ClearanceResult {
  personWidthM: number
  /** Can the person get from the start to the goal? */
  reachable: boolean
  /** The route, smoothed, from start to goal (empty if not reachable). */
  path: FloorPoint[]
  pathLengthM: number
  /** Walkability score (a): see WALKABILITY SCORE below. 0 to 100. */
  reachablePercent: number
  /** Walkability score (b): see WALKABILITY SCORE below. Null if the goal can't be reached. */
  narrowestGapCm: number | null
  /** Where on the route the narrowest gap is. */
  narrowestAt: FloorPoint | null
  /** Where it's blocked (null if reachable). */
  blockedAt: Blocked | null
  /** Whether the start or goal had to be moved (null = not moved). */
  snapped: { start: Snap | null; goal: Snap | null }
  /** One number per cell (index = i + j * nx): 1 if the person's body can get there from the start. For shading. */
  reachableArea: Uint8Array
  gridInfo: GridInfo
}

/*
 * ===== THE WALKABILITY SCORE (defined here, and only here) =====
 *
 * (a) reachablePercent: of all the open floor in the room (floor not covered by furniture), the percentage that a person
 *     of this width can get to from the start. "Get to" means anywhere their body can reach, not just where their middle
 *     can go, so an empty room scores about 100%. A cramped room, or a part of the room cut off by furniture, scores less.
 *
 * (b) narrowestGapCm: the narrowest gap the person has to get through on the way from start to goal, in cm.
 *     The route we draw is the one that keeps the most room (and, of those, the shortest). All along it we measure the
 *     distance to the nearest obstacle (the "clearance"). The narrowest gap is twice the smallest clearance: the width of the
 *     widest person who could get through. Between two pieces of furniture, that is simply the gap between them.
 *     - The 50 cm around the start and the goal (SNAP_LIMIT_M) don't count. That is where the person stands, which may be
 *       tucked into a corner, and we have already made sure they fit there. Without this rule, a goal in a corner would be
 *       "the narrowest gap" for every width, and the number would say nothing about the layout.
 *     - Gaps wider than 2 x ROOMY_M (1.2 m) aren't narrow: null means "no gaps narrower than 1.2 m on the way".
 *
 * Plus `reachable`: can they get from the start to the goal at all?
 *
 * Accuracy: the grid is 5 cm, but each cell is checked at 25 points (see FloorMap.room), so gaps are measured to about 1 cm,
 * then rounded down. That is much finer than the sizes from phone LiDAR, which are themselves estimates.
 */
/** Clearance at which a route counts as roomy (a gap of 1.2 m, the widest setting on the slider). Also the "comfort" distance. */
const ROOMY_M = 0.6
/** The same, as a gap in cm: gaps this wide or wider are not reported as "narrow". */
export const ROOMY_GAP_CM = ROOMY_M * 200

// ---------- The floor map: every cell's clearance ----------

/** A box's footprint on the floor: a rectangle, possibly turned. */
interface Footprint {
  cx: number
  cz: number
  cos: number
  sin: number
  halfW: number // half the size along the box's own x
  halfD: number // half the size along the box's own z
}

export interface FloorMap {
  cellM: number
  nx: number
  nz: number
  minX: number
  minZ: number
  /** Clearance of each cell's centre, metres. 0 = covered by furniture, or outside the room. */
  clearance: Float32Array
  /**
   * The most room anywhere in each cell (the best of 5 x 5 points across it, edges included), metres. The person's middle can
   * be anywhere in a cell, so they fit in it if this is at least half their width. The fit decision AND every gap we report
   * both come from these numbers, so a reported gap can never disagree with the verdict.
   */
  room: Float32Array
  /** The point in cell `index` with the most room. */
  roomiestPoint: (index: number) => FloorPoint
  openCells: number
  /** The cell that point (x, z) is in, or -1 if it's outside the grid. */
  cellAt: (x: number, z: number) => number
  /** The centre of cell `index`. */
  centre: (index: number) => FloorPoint
  /** Exact clearance at any point (not just cell centres). */
  clearanceAt: (x: number, z: number) => number
}

/** The boxes that block walking: every role except passable, and not floating above head height. */
function blockingFootprints(world: World): Footprint[] {
  const floorY = world.room.floor_y
  const out: Footprint[] = []
  for (const o of world.objects) {
    if (o.role === 'passable') continue // rugs, open doors: you walk over or through them
    const bottom = o.position[1] - o.size[1] / 2
    const top = o.position[1] + o.size[1] / 2
    if (bottom - floorY > HEAD_HEIGHT_M) continue // floats above head height (a high shelf): you walk under it
    if (top <= floorY) continue // entirely under the floor: can't be in the way
    out.push({
      cx: o.position[0],
      cz: o.position[2],
      cos: Math.cos(o.rotation_y),
      sin: Math.sin(o.rotation_y),
      halfW: o.size[0] / 2,
      halfD: o.size[2] / 2,
    })
  }
  return out
}

/** Distance from point (x, z) to a footprint. 0 if the point is inside it or on its edge. */
function distanceToFootprint(f: Footprint, x: number, z: number): number {
  const dx = x - f.cx
  const dz = z - f.cz
  // Turn the point into the box's own frame by undoing the box's turn. three.js's rotation.y = a takes a point (lx, lz) on the
  // box to (lx cos a + lz sin a, -lx sin a + lz cos a) in the world, so going back the other way is:
  const lx = dx * f.cos - dz * f.sin
  const lz = dx * f.sin + dz * f.cos
  const outX = Math.max(Math.abs(lx) - f.halfW, 0) // how far outside the box's sides, along each of its own directions
  const outZ = Math.max(Math.abs(lz) - f.halfD, 0)
  return Math.hypot(outX, outZ)
}

export function buildFloorMap(world: World): FloorMap {
  const { min, max } = world.room.bounds
  const minX = min[0]
  const minZ = min[2]
  const sizeX = Math.max(0, max[0] - minX)
  const sizeZ = Math.max(0, max[2] - minZ)
  let cellM = CELL_M
  while ((sizeX / cellM) * (sizeZ / cellM) > MAX_CELLS) cellM *= 2
  // The last cell in a row may stick out past the wall; its centre then counts as outside the room (clearance 0).
  const nx = Math.ceil(sizeX / cellM - 1e-9)
  const nz = Math.ceil(sizeZ / cellM - 1e-9)
  const footprints = blockingFootprints(world)

  /** Distance from (x, z) to the nearest wall or to the nearest of `boxes`. */
  const clearanceAmong = (boxes: Footprint[], x: number, z: number): number => {
    // The room's edges count as walls.
    let c = Math.min(x - minX, max[0] - x, z - minZ, max[2] - z)
    if (c <= 0) return 0
    for (const f of boxes) {
      c = Math.min(c, distanceToFootprint(f, x, z))
      if (c === 0) return 0
    }
    return c
  }
  const clearanceAt = (x: number, z: number): number => clearanceAmong(footprints, x, z)

  // The 5 x 5 points across a cell (as fractions of a cell from its centre) used for `room`. The centre comes first.
  const SPOTS = [0, -0.5, -0.25, 0.25, 0.5]
  const roomiestIn = (boxes: Footprint[], cx: number, cz: number): { room: number; at: FloorPoint } => {
    let best = { room: -1, at: { x: cx, z: cz } }
    for (const a of SPOTS) {
      for (const b of SPOTS) {
        const x = cx + a * cellM
        const z = cz + b * cellM
        const c = clearanceAmong(boxes, x, z)
        if (c > best.room) best = { room: c, at: { x, z } }
      }
    }
    return best
  }

  const clearance = new Float32Array(nx * nz)
  const room = new Float32Array(nx * nz)
  let openCells = 0
  for (let j = 0; j < nz; j++) {
    const z = minZ + (j + 0.5) * cellM
    for (let i = 0; i < nx; i++) {
      const x = minX + (i + 0.5) * cellM
      const c = clearanceAt(x, z)
      clearance[i + j * nx] = c
      if (c > 0) openCells++
      // Only boxes this close to the centre can be the nearest one for some point in the cell, so skip the rest (it's faster).
      const nearby = footprints.filter((f) => distanceToFootprint(f, x, z) <= c + 1.5 * cellM)
      room[i + j * nx] = roomiestIn(nearby, x, z).room
    }
  }

  const centre = (index: number): FloorPoint => ({
    x: minX + ((index % nx) + 0.5) * cellM,
    z: minZ + (Math.floor(index / nx) + 0.5) * cellM,
  })

  return {
    cellM,
    nx,
    nz,
    minX,
    minZ,
    clearance,
    room,
    roomiestPoint: (index) => {
      const c = centre(index)
      return roomiestIn(footprints, c.x, c.z).at
    },
    openCells,
    clearanceAt,
    cellAt: (x, z) => {
      const i = Math.floor((x - minX) / cellM)
      const j = Math.floor((z - minZ) / cellM)
      return i < 0 || j < 0 || i >= nx || j >= nz ? -1 : i + j * nx
    },
    centre,
  }
}

// ---------- Moving between cells ----------

// The 8 directions: 4 straight (length 1 cell) and 4 diagonal (about 1.41 cells). Kept as plain number lists because this is
// the busiest code in the check (it runs about 100,000 times per check).
const STEP_I = [1, -1, 0, 0, 1, 1, -1, -1]
const STEP_J = [0, 0, 1, -1, 1, -1, 1, -1]
const STEP_LENGTH = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2]

/**
 * Call `visit(next, stepCells, diagonal corners...)` for each neighbour of `cell` that `ok` allows.
 * A diagonal step is only allowed if both cells beside it are ok too, so the route can't cut a corner past a blocked cell.
 */
function forEachNeighbour(
  map: FloorMap,
  cell: number,
  ok: (cell: number) => boolean,
  visit: (next: number, stepCells: number, sideA: number, sideB: number) => void,
): void {
  const { nx, nz } = map
  const i = cell % nx
  const j = (cell - i) / nx
  for (let s = 0; s < 8; s++) {
    const ni = i + STEP_I[s]
    const nj = j + STEP_J[s]
    if (ni < 0 || nj < 0 || ni >= nx || nj >= nz) continue
    const next = ni + nj * nx
    if (!ok(next)) continue
    if (s >= 4) {
      const sideA = ni + j * nx
      const sideB = i + nj * nx
      if (!ok(sideA) || !ok(sideB)) continue
      visit(next, STEP_LENGTH[s], sideA, sideB)
    } else {
      visit(next, STEP_LENGTH[s], -1, -1)
    }
  }
}

/** A small priority queue: pop() always gives back the value with the smallest key. */
class MinHeap {
  private keys: number[] = []
  private values: number[] = []
  get size(): number {
    return this.values.length
  }
  private swap(a: number, b: number): void {
    const k = this.keys[a]
    this.keys[a] = this.keys[b]
    this.keys[b] = k
    const v = this.values[a]
    this.values[a] = this.values[b]
    this.values[b] = v
  }
  push(key: number, value: number): void {
    const k = this.keys
    k.push(key)
    this.values.push(value)
    let i = k.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (k[p] <= k[i]) break
      this.swap(p, i)
      i = p
    }
  }
  /** Removes the smallest; returns [key, value]. */
  pop(): [number, number] {
    const k = this.keys
    const v = this.values
    const top: [number, number] = [k[0], v[0]]
    const lastK = k.pop() as number
    const lastV = v.pop() as number
    if (k.length > 0) {
      k[0] = lastK
      v[0] = lastV
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < k.length && k[l] < k[m]) m = l
        if (r < k.length && k[r] < k[m]) m = r
        if (m === i) break
        this.swap(m, i)
        i = m
      }
    }
    return top
  }
}

/** Follow the "came from" links back from `end` to the start. Returns the cells, start first. */
function walkBack(cameFrom: Int32Array, end: number): number[] {
  const cells: number[] = []
  for (let c = end; c !== -1; c = cameFrom[c]) cells.push(c)
  return cells.reverse()
}

// ---------- The steps of the check ----------

/** A point in `cell` where a person with this radius fits: its centre if possible, else its roomiest point. */
function spotIn(map: FloorMap, cell: number, radius: number): FloorPoint {
  return map.clearance[cell] >= radius ? map.centre(cell) : map.roomiestPoint(cell)
}

/** The cell for the start or goal: the one it's in if the person fits there, else the nearest cell within SNAP_LIMIT_M where they fit. */
function placePoint(map: FloorMap, p: FloorPoint, radius: number): { cell: number; snap: Snap | null } | null {
  const fits = (cell: number) => map.room[cell] >= radius
  const own = map.cellAt(p.x, p.z)
  if (own !== -1 && fits(own)) return { cell: own, snap: null }
  const reach = Math.ceil(SNAP_LIMIT_M / map.cellM) + 1
  const ci = Math.floor((p.x - map.minX) / map.cellM)
  const cj = Math.floor((p.z - map.minZ) / map.cellM)
  let best = -1
  let bestDistance = Infinity
  for (let j = Math.max(0, cj - reach); j <= Math.min(map.nz - 1, cj + reach); j++) {
    for (let i = Math.max(0, ci - reach); i <= Math.min(map.nx - 1, ci + reach); i++) {
      const cell = i + j * map.nx
      if (!fits(cell)) continue
      const c = map.centre(cell)
      const d = Math.hypot(c.x - p.x, c.z - p.z)
      if (d <= SNAP_LIMIT_M && d < bestDistance) {
        best = cell
        bestDistance = d
      }
    }
  }
  if (best === -1) return null
  const to = spotIn(map, best, radius)
  return { cell: best, snap: { from: p, to, movedCm: Math.round(Math.hypot(to.x - p.x, to.z - p.z) * 100) } }
}

/** Every cell the person's middle can get to from `start` (a "flood fill"). */
function floodFill(map: FloorMap, start: number, fits: (cell: number) => boolean): Uint8Array {
  const reached = new Uint8Array(map.nx * map.nz)
  const queue = new Int32Array(map.nx * map.nz)
  let head = 0
  let tail = 0
  reached[start] = 1
  queue[tail++] = start
  while (head < tail) {
    forEachNeighbour(map, queue[head++], fits, (next) => {
      if (reached[next]) return
      reached[next] = 1
      queue[tail++] = next
    })
  }
  return reached
}

/**
 * Every open cell the person's BODY can reach: within half their width of somewhere their middle can get to.
 * (Only the edge of the reached area needs stamping: the inside is reached already.)
 */
function bodyArea(map: FloorMap, reached: Uint8Array, radius: number): Uint8Array {
  const area = new Uint8Array(reached)
  const r = radius + map.cellM / 2 // the person can be anywhere in their cell, so allow half a cell more
  const rc = Math.ceil(r / map.cellM)
  const stamp: Array<[number, number]> = []
  for (let dj = -rc; dj <= rc; dj++) {
    for (let di = -rc; di <= rc; di++) if (Math.hypot(di, dj) * map.cellM <= r) stamp.push([di, dj])
  }
  const { nx, nz } = map
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      if (!reached[i + j * nx]) continue
      const onEdge =
        i === 0 || j === 0 || i === nx - 1 || j === nz - 1 ||
        !reached[i - 1 + j * nx] || !reached[i + 1 + j * nx] || !reached[i + (j - 1) * nx] || !reached[i + (j + 1) * nx]
      if (!onEdge) continue
      for (const [di, dj] of stamp) {
        const si = i + di
        const sj = j + dj
        if (si < 0 || sj < 0 || si >= nx || sj >= nz) continue
        const cell = si + sj * nx
        if (map.clearance[cell] > 0) area[cell] = 1 // only open floor counts
      }
    }
  }
  return area
}

/** Shortest route from start to goal over the cells `fits` allows (A*). Prefers to keep ROOMY_M from furniture. */
function aStar(map: FloorMap, start: number, goal: number, fits: (cell: number) => boolean): number[] {
  const n = map.nx * map.nz
  const cost = new Float64Array(n).fill(Infinity) // cheapest known cost from the start, in cells
  const cameFrom = new Int32Array(n).fill(-1)
  const done = new Uint8Array(n)
  const gi = goal % map.nx
  const gj = Math.floor(goal / map.nx)
  // Guess of the remaining cost: the "octile" distance (straight and diagonal steps on an empty grid). Never too high, so A* is exact.
  const guess = (cell: number): number => {
    const di = Math.abs((cell % map.nx) - gi)
    const dj = Math.abs(Math.floor(cell / map.nx) - gj)
    return Math.max(di, dj) + (Math.SQRT2 - 1) * Math.min(di, dj)
  }
  // Each step costs its length, plus extra when it is close to furniture (less than ROOMY_M away).
  const nearFurniture = (cell: number): number =>
    1 + (COMFORT_WEIGHT * Math.max(0, ROOMY_M - map.room[cell])) / ROOMY_M

  const open = new MinHeap()
  cost[start] = 0
  open.push(guess(start), start)
  while (open.size > 0) {
    const [, cell] = open.pop()
    if (done[cell]) continue
    if (cell === goal) break
    done[cell] = 1
    forEachNeighbour(map, cell, fits, (next, length) => {
      const c = cost[cell] + length * nearFurniture(next)
      if (c < cost[next]) {
        cost[next] = c
        cameFrom[next] = cell
        open.push(c + guess(next), next)
      }
    })
  }
  return Number.isFinite(cost[goal]) ? walkBack(cameFrom, goal) : []
}

/**
 * The route whose tightest spot is as wide as possible (a "widest path" search). `room(cell)` is how much room a cell gives:
 * its clearance, or Infinity for cells that shouldn't count. Returns the route's cells (start first) and the room at its
 * tightest spot, or null if `ok` allows no route at all.
 */
function widestRoute(
  map: FloorMap,
  start: number,
  goal: number,
  ok: (cell: number) => boolean,
  room: (cell: number) => number,
): { cells: number[]; room: number } | null {
  const n = map.nx * map.nz
  const widest = new Float64Array(n).fill(-1) // the roomiest "tightest spot so far" of any route found to each cell
  const cameFrom = new Int32Array(n).fill(-1)
  const queue = new MinHeap() // keys are negative, so the ROOMIEST comes out first
  widest[start] = room(start)
  queue.push(-widest[start], start)
  while (queue.size > 0) {
    const [negative, cell] = queue.pop()
    if (-negative < widest[cell]) continue // an old entry
    if (cell === goal) break
    forEachNeighbour(map, cell, ok, (next, _length, sideA, sideB) => {
      // A diagonal step squeezes past the two cells beside it, so they count as part of the route too.
      let w = Math.min(widest[cell], room(next))
      if (sideA !== -1) w = Math.min(w, room(sideA), room(sideB))
      if (w > widest[next]) {
        widest[next] = w
        cameFrom[next] = cell
        queue.push(-w, next)
      }
    })
  }
  return widest[goal] < 0 ? null : { cells: walkBack(cameFrom, goal), room: widest[goal] }
}

/**
 * Which cell of a route is the tightest (ignoring cells where `skip` is true)? Returns its position in `cells`, or -1.
 * A gap usually has some depth (the thickness of the furniture), so several cells in a row tie: we take the middle one.
 */
function tightestOnRoute(map: FloorMap, cells: number[], skip: (cell: number) => boolean = () => false): number {
  let tightest = Infinity
  for (const c of cells) if (!skip(c)) tightest = Math.min(tightest, map.room[c])
  if (tightest === Infinity) return -1
  let best: [number, number] = [-1, -1]
  let runStart = -1
  for (let k = 0; k <= cells.length; k++) {
    const tied = k < cells.length && !skip(cells[k]) && map.room[cells[k]] <= tightest + 1e-6
    if (tied && runStart === -1) runStart = k
    if (!tied && runStart !== -1) {
      if (best[0] === -1 || k - 1 - runStart > best[1] - best[0]) best = [runStart, k - 1]
      runStart = -1
    }
  }
  return Math.floor((best[0] + best[1]) / 2)
}

/**
 * The gap at a cell: twice the room there, in whole cm, and the point in the middle of it. Rounded DOWN, so a gap never looks
 * wider than it is (and "a 85 cm gap" can never be shown for a gap that is really 84.9 cm and blocks an 85 cm wheelchair).
 */
function gapAt(map: FloorMap, cell: number): { cm: number; at: FloorPoint } {
  return { cm: Math.floor(map.room[cell] * 200 + 1e-4), at: map.roomiestPoint(cell) }
}

/**
 * Smooth the zig-zag grid route for drawing: from each point, jump straight to the furthest later point you can see.
 * A shortcut must leave room for the person, and (away from the start and goal) must not pass closer to furniture than the
 * grid route did over the same stretch, unless it stays at least ROOMY_M away. So smoothing never makes the route tighter.
 */
function smoothRoute(map: FloorMap, points: FloorPoint[], radius: number, nearEnds: (p: FloorPoint) => boolean): FloorPoint[] {
  if (points.length <= 2) return points
  const clear = points.map((p) => (nearEnds(p) ? Infinity : map.clearanceAt(p.x, p.z)))
  // Is the straight line from a to b roomy enough? Checked every quarter of a cell.
  const lineClear = (a: FloorPoint, b: FloorPoint, need: number): boolean => {
    const samples = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / (map.cellM / 4)))
    for (let s = 1; s < samples; s++) {
      const q = { x: a.x + ((b.x - a.x) * s) / samples, z: a.z + ((b.z - a.z) * s) / samples }
      if (map.clearanceAt(q.x, q.z) < (nearEnds(q) ? radius : need)) return false
    }
    return true
  }
  const out = [points[0]]
  let anchor = 0
  while (anchor < points.length - 1) {
    let next = anchor + 1
    let stretchMin = Math.min(clear[anchor], clear[anchor + 1])
    for (let k = anchor + 2; k < points.length; k++) {
      stretchMin = Math.min(stretchMin, clear[k])
      if (!lineClear(points[anchor], points[k], Math.max(radius, Math.min(stretchMin, ROOMY_M)))) break
      next = k
    }
    out.push(points[next])
    anchor = next
  }
  return out
}

const toPoint = (v: Vec3): FloorPoint => ({ x: v[0], z: v[2] })

// The floor map doesn't depend on the person's width, so we keep the last few: dragging the width slider then skips the
// slowest part. A room is recognised by its contents (not by being the same object), so a changed room always gets a new map.
const recentMaps = new Map<string, FloorMap>()
function floorMapFor(world: World): FloorMap {
  const key = JSON.stringify([world.room, world.objects])
  let map = recentMaps.get(key)
  if (!map) {
    map = buildFloorMap(world)
    if (recentMaps.size >= 4) recentMaps.delete(recentMaps.keys().next().value as string) // forget the oldest
    recentMaps.set(key, map)
  }
  return map
}

// ---------- The one function to call ----------

/**
 * Check whether a person `personWidthM` wide can get from world.spawn to world.goal, and score how walkable the room is.
 * Z6 calls this on both the before and after layouts. Takes a few milliseconds for a normal room.
 */
export function checkClearance(world: World, personWidthM: number): ClearanceResult {
  const startTime = performance.now()
  const map = floorMapFor(world)
  const radius = personWidthM / 2
  const fits = (cell: number) => map.room[cell] >= radius
  const spawn = toPoint(world.spawn)
  const goalPoint = toPoint(world.goal)

  const result: ClearanceResult = {
    personWidthM,
    reachable: false,
    path: [],
    pathLengthM: 0,
    reachablePercent: 0,
    narrowestGapCm: null,
    narrowestAt: null,
    blockedAt: null,
    snapped: { start: null, goal: null },
    reachableArea: new Uint8Array(map.nx * map.nz),
    gridInfo: {
      cellM: map.cellM,
      nx: map.nx,
      nz: map.nz,
      minX: map.minX,
      minZ: map.minZ,
      floorY: world.room.floor_y,
      openCells: map.openCells,
      ms: 0,
    },
  }
  const finish = (): ClearanceResult => {
    result.gridInfo.ms = performance.now() - startTime
    return result
  }

  const start = placePoint(map, spawn, radius)
  if (!start) {
    result.blockedAt = { at: spawn, reason: 'start', gapCm: null }
    return finish()
  }
  result.snapped.start = start.snap

  // (a) How much of the floor can they get to?
  const reached = floodFill(map, start.cell, fits)
  result.reachableArea = bodyArea(map, reached, radius)
  let areaCells = 0
  for (const v of result.reachableArea) areaCells += v
  result.reachablePercent = map.openCells === 0 ? 0 : (100 * areaCells) / map.openCells

  const goal = placePoint(map, goalPoint, radius)
  if (!goal) {
    result.blockedAt = { at: goalPoint, reason: 'goal', gapCm: null }
    return finish()
  }
  result.snapped.goal = goal.snap

  if (!reached[goal.cell]) {
    // No route. Find where it's blocked: the tightest spot on the best "almost" route (the roomiest route over any open floor)...
    const almost = widestRoute(map, start.cell, goal.cell, (cell) => map.room[cell] > 0, (cell) => map.room[cell])
    if (almost) {
      const gap = gapAt(map, almost.cells[tightestOnRoute(map, almost.cells)])
      result.blockedAt = { at: gap.at, reason: 'gap', gapCm: gap.cm }
    } else {
      // ...or, if furniture seals the goal off completely, the reachable spot that gets closest to the goal.
      let closest = start.cell
      let closestDistance = Infinity
      for (let cell = 0; cell < reached.length; cell++) {
        if (!reached[cell]) continue
        const c = map.centre(cell)
        const d = Math.hypot(c.x - goalPoint.x, c.z - goalPoint.z)
        if (d < closestDistance) {
          closest = cell
          closestDistance = d
        }
      }
      result.blockedAt = { at: map.centre(closest), reason: 'sealed', gapCm: null }
    }
    return finish()
  }

  // There is a route. The 50 cm around the start and goal (where they may have been moved to) don't count towards gaps.
  const startAt = start.snap ? start.snap.to : spawn
  const goalAt = goal.snap ? goal.snap.to : goalPoint
  const nearEnds = (p: FloorPoint) =>
    Math.hypot(p.x - startAt.x, p.z - startAt.z) <= SNAP_LIMIT_M || Math.hypot(p.x - goalAt.x, p.z - goalAt.z) <= SNAP_LIMIT_M
  const isNearEnds = new Uint8Array(map.nx * map.nz) // worked out once per cell, as it's asked about very often
  for (let cell = 0; cell < isNearEnds.length; cell++) isNearEnds[cell] = nearEnds(map.centre(cell)) ? 1 : 0
  const cellNearEnds = (cell: number) => isNearEnds[cell] === 1

  // How roomy is the roomiest route? Then take the shortest route that is that roomy (anything over ROOMY_M is roomy enough).
  const roomiest = widestRoute(map, start.cell, goal.cell, fits, (cell) => (cellNearEnds(cell) ? Infinity : map.room[cell]))
  const need = Math.max(radius, Math.min(roomiest ? roomiest.room : radius, ROOMY_M))
  const cells = aStar(map, start.cell, goal.cell, (cell) => fits(cell) && (cellNearEnds(cell) || map.room[cell] >= need))

  // Begin and end exactly at the start and goal (or where they were moved to). In between, a point in each cell with room.
  const points = [startAt, ...cells.slice(1, -1).map((cell) => spotIn(map, cell, need)), goalAt]
  result.reachable = true
  result.path = smoothRoute(map, points, radius, nearEnds)
  for (let k = 1; k < result.path.length; k++) {
    result.pathLengthM += Math.hypot(result.path[k].x - result.path[k - 1].x, result.path[k].z - result.path[k - 1].z)
  }

  // (b) The narrowest gap on the way: twice the smallest room on the route, away from the start and goal.
  const k = tightestOnRoute(map, cells, cellNearEnds)
  if (k !== -1 && map.room[cells[k]] < ROOMY_M) {
    const gap = gapAt(map, cells[k])
    result.narrowestGapCm = gap.cm
    result.narrowestAt = gap.at
  }
  return finish()
}

// ---------- Plain-English summary (for the screen, the tests and Z6) ----------

/** e.g. "Wheelchair (0.85 m): goal reachable. 78% of the floor reachable. Narrowest gap: 92 cm." */
export function summarise(result: ClearanceResult, label: string): string {
  const who = `${label} (${result.personWidthM.toFixed(2).replace(/0$/, '')} m)`
  const floor = `${Math.round(result.reachablePercent)}% of the floor reachable.`
  if (result.reachable) {
    const gap =
      result.narrowestGapCm === null ? `No gaps narrower than ${ROOMY_GAP_CM} cm on the way.` : `Narrowest gap: ${result.narrowestGapCm} cm.`
    return `${who}: goal reachable. ${floor} ${gap}`
  }
  return `${who}: goal NOT reachable. ${floor} ${blockedReason(result)}`
}

/** Why the goal can't be reached, in words. Empty if it can. */
export function blockedReason(result: ClearanceResult): string {
  const b = result.blockedAt
  if (!b) return ''
  const need = Math.round(result.personWidthM * 100)
  switch (b.reason) {
    case 'gap':
      return `Blocked by a ${b.gapCm} cm gap (needs ${need} cm).`
    case 'sealed':
      return 'Furniture closes the goal off completely.'
    case 'start':
      return `No room to start: nothing ${need} cm wide is free within ${SNAP_LIMIT_M * 100} cm of the start.`
    case 'goal':
      return `No room at the goal: nothing ${need} cm wide is free within ${SNAP_LIMIT_M * 100} cm of it.`
  }
}

/** Notes about the start or goal being moved, e.g. "The goal was moved 6 cm so there is room for this width." */
export function snapNotes(result: ClearanceResult): string[] {
  const notes: string[] = []
  const { start, goal } = result.snapped
  if (start) notes.push(`The start was inside or too close to furniture for this width, so it was moved ${start.movedCm} cm.`)
  if (goal) notes.push(`The goal was inside or too close to furniture for this width, so it was moved ${goal.movedCm} cm.`)
  return notes
}
