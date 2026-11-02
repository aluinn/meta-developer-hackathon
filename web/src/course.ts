// Plans a race course on the real scan: where the checkpoint gates, item boxes, spiky hazards and the flag go.
// It only uses the walkable map (walkGraph.ts), so it works on ANY scan and can be tested without a browser.
//
// The ideas: checkpoints are spread around the room and visited in a sensible order; one is up on a piece of furniture when
// something can be climbed, so the player must jump; hazards patrol across the route; item boxes lie along it (and one is a reward
// for climbing); the flag starts far from the last checkpoint.

import { pathTo, shortestPaths, type Graph, type NodeId, type Paths } from './walkGraph.ts'
import type { Vec3 } from './world.ts'

export interface CourseSpot {
  node: NodeId
  pos: Vec3 // where the feet go
}
export interface HazardDef {
  a: Vec3
  b: Vec3 // it rolls back and forth between these two points
  speed: number // metres per second
  radius: number
}
export interface Course {
  graph: Graph
  start: NodeId
  checkpoints: CourseSpot[] // in the order they must be visited
  items: CourseSpot[]
  hazards: HazardDef[]
  flagStart: NodeId
  routeLength: number // metres along the planned route, spawn to the last checkpoint
  climbs: boolean // true if at least one checkpoint needs a jump up onto something
}

export interface CourseOptions {
  seed: number
  checkpoints: number // how many gates (fewer if the room is tiny)
  hazards: number
  unit: number // the character's height: everything scales with it
  runSpeed: number
  elevatedMin: number // a surface this much above the floor counts as "up on something"
}

/** A small seedable random number generator, so a course can be repeated (and tested). */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pos = (g: Graph, n: NodeId): Vec3 => [g.nodes[n].x, g.nodes[n].y, g.nodes[n].z]
const dist = (g: Graph, a: NodeId, b: NodeId) =>
  Math.hypot(g.nodes[a].x - g.nodes[b].x, (g.nodes[a].y - g.nodes[b].y) * 2, g.nodes[a].z - g.nodes[b].z)
const flat = (g: Graph, a: NodeId, b: NodeId) => Math.hypot(g.nodes[a].x - g.nodes[b].x, g.nodes[a].z - g.nodes[b].z)

export function generateCourse(g: Graph, spawn: Vec3, o: CourseOptions): Course | null {
  const rng = makeRng(o.seed)
  const start = g.nearest(spawn[0], spawn[1], spawn[2])
  if (start === null) return null
  const fromStart = shortestPaths(g, start)
  const reachable: NodeId[] = []
  let spread = 0
  for (let n = 0; n < g.nodes.length; n++) {
    if (Number.isFinite(fromStart.cost[n])) {
      reachable.push(n)
      spread = Math.max(spread, fromStart.cost[n])
    }
  }
  if (reachable.length < 20 || spread < g.cell * 8) return null // too small a place to race in

  const floorY = g.nodes[start].y
  const isUp = (n: NodeId) => g.nodes[n].y - floorY >= o.elevatedMin
  const minSep = Math.max(g.cell * 6, spread * 0.12)

  // ---- checkpoints: one up on furniture if possible, the rest spread out (farthest-point sampling) ----
  const chosen: NodeId[] = []
  const farFromAll = (n: NodeId) => Math.min(dist(g, n, start), ...chosen.map((c) => dist(g, n, c)))
  const raised = reachable.filter((n) => isUp(n) && fromStart.cost[n] >= spread * 0.25 && !chosen.some((c) => flat(g, n, c) < minSep))
  if (raised.length > 0 && o.checkpoints >= 3) {
    raised.sort((a, b) => fromStart.cost[b] - fromStart.cost[a])
    chosen.push(raised[Math.floor(rng() * Math.min(raised.length, Math.max(1, Math.ceil(raised.length * 0.3))))])
  }
  while (chosen.length < o.checkpoints) {
    let best: NodeId | null = null
    let bestD = 0
    for (const n of reachable) {
      if (isUp(n) && chosen.some((c) => isUp(c))) continue // one raised gate is enough
      const d = farFromAll(n)
      if (d > bestD && d >= minSep && fromStart.cost[n] >= g.cell * 4) {
        bestD = d
        best = n
      }
    }
    if (best === null) break
    chosen.push(best)
  }
  if (chosen.length < 2) return null

  // ---- visiting order: always go to the nearest gate you have not been to (by walking distance) ----
  const order: NodeId[] = []
  const legs: NodeId[][] = []
  let here = start
  let paths: Paths = fromStart
  const left = new Set(chosen)
  while (left.size > 0) {
    let next: NodeId | null = null
    for (const n of left) if (next === null || paths.cost[n] < paths.cost[next]) next = n
    if (next === null || !Number.isFinite(paths.cost[next])) return null
    legs.push(pathTo(paths, next))
    order.push(next)
    left.delete(next)
    here = next
    paths = shortestPaths(g, here)
  }
  const last = order[order.length - 1]
  let routeLength = 0
  for (const leg of legs) for (let i = 1; i < leg.length; i++) routeLength += flat(g, leg[i - 1], leg[i])

  const taken: NodeId[] = [start, ...order]
  const free = (n: NodeId, sep: number) => !taken.some((t) => flat(g, n, t) < sep)

  // ---- hazards: roll back and forth across the route, away from the start and the gates ----
  const hazards: HazardDef[] = []
  const safe = g.cell * (g.cell > 0.2 ? 3 : 5) // clear space around the start and gates, in metres (a coarse map has fewer, bigger cells)
  for (let attempt = 0; attempt < o.hazards * 8 && hazards.length < o.hazards; attempt++) {
    const leg = legs[attempt % legs.length]
    if (leg.length < 5) continue
    const i = Math.floor(leg.length * (0.3 + rng() * 0.4))
    const centre = leg[i]
    if (i < 2 || i > leg.length - 3) continue // reachSide looks two steps either way along the path
    if (!free(centre, safe) || hazards.some((h) => Math.hypot(h.a[0] - g.nodes[centre].x, h.a[2] - g.nodes[centre].z) < safe * 1.2)) continue
    const before = g.nodes[leg[i - 2]]
    const after = g.nodes[leg[i + 2]]
    const tx = after.x - before.x
    const tz = after.z - before.z
    const len = Math.hypot(tx, tz) || 1
    const px = -tz / len // sideways to the direction of travel
    const pz = tx / len
    const reachSide = (sign: number): NodeId => {
      let edge = centre
      for (let k = 1; k <= 5; k++) {
        const c = g.nearest(g.nodes[centre].x + px * sign * g.cell * k, g.nodes[centre].y, g.nodes[centre].z + pz * sign * g.cell * k)
        if (c === null || Math.abs(g.nodes[c].y - g.nodes[centre].y) > g.cell * 0.6 || flat(g, c, centre) < g.cell * k * 0.6) break
        edge = c
      }
      return edge
    }
    const a = reachSide(1)
    const b = reachSide(-1)
    if (flat(g, a, b) < g.cell * 3) continue // not enough flat ground to roll on
    hazards.push({ a: pos(g, a), b: pos(g, b), speed: o.runSpeed * (0.32 + rng() * 0.18), radius: o.unit * 0.28 })
  }

  // ---- item boxes: along the route, plus one as a reward up on furniture ----
  const items: CourseSpot[] = []
  const wanted = Math.max(3, order.length + 2)
  const tryItem = (n: NodeId): boolean => {
    if (!free(n, g.cell * 3) || items.some((it) => flat(g, n, it.node) < g.cell * 4)) return false
    items.push({ node: n, pos: pos(g, n) })
    return true
  }
  const reward = reachable.filter((n) => isUp(n) && free(n, g.cell * 3))
  if (reward.length > 0) tryItem(reward[Math.floor(rng() * reward.length)])
  for (let attempt = 0; attempt < 60 && items.length < wanted; attempt++) {
    const leg = legs[attempt % legs.length]
    if (leg.length < 6) continue
    const along = leg[Math.floor(leg.length * (0.25 + rng() * 0.5))]
    const near = g.nearest(g.nodes[along].x + (rng() - 0.5) * g.cell * 5, g.nodes[along].y, g.nodes[along].z + (rng() - 0.5) * g.cell * 5)
    if (near !== null && Number.isFinite(fromStart.cost[near])) tryItem(near)
  }

  // ---- the flag starts far from the last gate, on the floor level if possible ----
  const fromLast = shortestPaths(g, last)
  let flagStart: NodeId | null = null
  // Rules in order of preference. Being well away from the spawn matters most (or the flag is "caught" at the very start); being clear of the
  // gates matters less, and is given up first in a small room where four gates leave little space.
  const rules: Array<[number, number]> = [[1.5, 0.9], [1.2, 0.5], [1.0, 0], [0.6, 0], [0, 0]] // [distance from the spawn, distance from gates], both times minSep
  for (const [fromSpawn, fromGates] of rules) {
    for (const n of reachable) {
      if (!Number.isFinite(fromLast.cost[n]) || isUp(n)) continue
      if (flat(g, n, start) < minSep * fromSpawn || order.some((t) => flat(g, n, t) < minSep * fromGates)) continue
      if (flagStart === null || fromLast.cost[n] > fromLast.cost[flagStart]) flagStart = n
    }
    if (flagStart !== null) break
  }

  return {
    graph: g,
    start,
    checkpoints: order.map((n) => ({ node: n, pos: pos(g, n) })),
    items,
    hazards,
    flagStart: flagStart ?? last,
    routeLength,
    climbs: order.some((n) => isUp(n)),
  }
}
