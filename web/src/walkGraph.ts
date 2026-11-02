// A map of where the character can stand on the real scan, and how those spots connect. The course generator (course.ts) and the
// moving flag's brain (game.ts) both work on this map. No three.js or Rapier in here, so it can be tested on its own.
//
// The room is cut into a grid. In every grid column we look for each "surface" the character could stand on (the floor, a sofa
// seat, a table top), and every such spot is a node. Two neighbouring nodes are joined if you can WALK between them (heights
// within a small step) or JUMP between them (jump up, or drop down, a bit more than a step but within the jump height).

import type { Vec3 } from './world.ts'

export type NodeId = number
export interface GraphNode {
  x: number
  y: number // the height of the surface (where the feet go)
  z: number
}
export interface Edge {
  to: NodeId
  cost: number
  jump: boolean // needs a jump up (or a drop down); walking is not enough
}
export interface Graph {
  cell: number // metres between neighbouring grid columns
  nodes: GraphNode[]
  adj: Edge[][]
  /** The node nearest to a point (heights count too, so a sofa top is not mistaken for the floor under it). Null if none is close. */
  nearest: (x: number, y: number, z: number) => NodeId | null
}

/** Finds the standable surfaces in the column at (x, z): the heights, top to bottom. */
export interface Probe {
  surfaces: (x: number, z: number) => number[]
}

export interface GraphOptions {
  min: Vec3
  max: Vec3 // the room's bounds
  cell: number
  margin: number // stay this far from the room's edges (the walls)
  stepUp: number // height differences up to this can be walked
  jumpUp: number // ...up to this can be jumped (up) or dropped (down)
}

const FORWARD = [[1, -1], [1, 0], [1, 1], [0, 1]] // each pair of neighbours is looked at once, from one side

export function buildGraph(probe: Probe, o: GraphOptions): Graph {
  const x0 = o.min[0] + o.margin
  const z0 = o.min[2] + o.margin
  const nx = Math.max(0, Math.floor((o.max[0] - o.margin - x0) / o.cell) + 1)
  const nz = Math.max(0, Math.floor((o.max[2] - o.margin - z0) / o.cell) + 1)
  const nodes: GraphNode[] = []
  const columns: NodeId[][] = new Array(nx * nz)
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const x = x0 + i * o.cell
      const z = z0 + j * o.cell
      columns[i * nz + j] = probe.surfaces(x, z).map((y) => nodes.push({ x, y, z }) - 1)
    }
  }

  const adj: Edge[][] = nodes.map(() => [])
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      for (const a of columns[i * nz + j]) {
        for (const [di, dj] of FORWARD) {
          const ni = i + di
          const nj = j + dj
          if (ni < 0 || ni >= nx || nj < 0 || nj >= nz) continue
          for (const b of columns[ni * nz + nj]) {
            const dh = Math.abs(nodes[b].y - nodes[a].y)
            const flat = Math.hypot(di, dj) * o.cell
            if (dh <= o.stepUp) {
              adj[a].push({ to: b, cost: flat, jump: false })
              adj[b].push({ to: a, cost: flat, jump: false })
            } else if (dh <= o.jumpUp) {
              const cost = flat + 4 * o.cell + 3 * dh // jumping is worse than walking, so routes avoid it unless they must
              adj[a].push({ to: b, cost, jump: true })
              adj[b].push({ to: a, cost, jump: true })
            }
          }
        }
      }
    }
  }

  function nearest(x: number, y: number, z: number): NodeId | null {
    const ci = Math.round((x - x0) / o.cell)
    const cj = Math.round((z - z0) / o.cell)
    for (const reach of [1, 3, 6]) {
      let best: NodeId | null = null
      let bestD = Infinity
      for (let i = Math.max(0, ci - reach); i <= Math.min(nx - 1, ci + reach); i++) {
        for (let j = Math.max(0, cj - reach); j <= Math.min(nz - 1, cj + reach); j++) {
          for (const id of columns[i * nz + j]) {
            const n = nodes[id]
            const d = Math.hypot(n.x - x, n.z - z) + Math.abs(n.y - y) * 2
            if (d < bestD) {
              bestD = d
              best = id
            }
          }
        }
      }
      if (best !== null) return best
    }
    return null
  }
  return { cell: o.cell, nodes, adj, nearest }
}

// ---- shortest paths (Dijkstra) ----

class MinHeap {
  private items: Array<[number, number]> = []
  get size(): number {
    return this.items.length
  }
  push(cost: number, node: number): void {
    const a = this.items
    a.push([cost, node])
    let i = a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (a[p][0] <= a[i][0]) break
      ;[a[p], a[i]] = [a[i], a[p]]
      i = p
    }
  }
  pop(): [number, number] {
    const a = this.items
    const top = a[0]
    const last = a.pop() as [number, number]
    if (a.length > 0) {
      a[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < a.length && a[l][0] < a[m][0]) m = l
        if (r < a.length && a[r][0] < a[m][0]) m = r
        if (m === i) break
        ;[a[m], a[i]] = [a[i], a[m]]
        i = m
      }
    }
    return top
  }
}

export interface Paths {
  cost: Float64Array // path cost from the start to every node (Infinity if you cannot get there)
  prev: Int32Array // the node before this one on the cheapest path (-1 at the start and for unreachable nodes)
}

/** Cheapest paths from `from` to every node. `maxCost` stops the search early; `allowJumps: false` walks only. */
export function shortestPaths(g: Graph, from: NodeId, maxCost = Infinity, allowJumps = true): Paths {
  const cost = new Float64Array(g.nodes.length).fill(Infinity)
  const prev = new Int32Array(g.nodes.length).fill(-1)
  const heap = new MinHeap()
  cost[from] = 0
  heap.push(0, from)
  while (heap.size > 0) {
    const [c, n] = heap.pop()
    if (c > cost[n]) continue
    for (const e of g.adj[n]) {
      if (e.jump && !allowJumps) continue
      const next = c + e.cost
      if (next < cost[e.to] && next <= maxCost) {
        cost[e.to] = next
        prev[e.to] = n
        heap.push(next, e.to)
      }
    }
  }
  return { cost, prev }
}

/** The nodes from the start to `target` (start first), or [] if there is no path. */
export function pathTo(paths: Paths, target: NodeId): NodeId[] {
  if (!Number.isFinite(paths.cost[target])) return []
  const out: NodeId[] = []
  for (let n = target; n !== -1; n = paths.prev[n]) out.push(n)
  return out.reverse()
}
