// The rules of the race. No drawing, no physics, no browser: it is told where the player is each frame and says what happened
// (events) and what the player may do right now (modifiers). That keeps every rule testable on its own.
//
// The race: pass the checkpoint gates in order (each gives bonus time) while a countdown runs, avoid the rolling spiky hazards, grab
// item boxes for power-ups, then CATCH THE FLAG. The flag wanders until the last gate is passed, then runs away from you, getting
// tired every few seconds.

import { makeRng, type Course, type HazardDef } from './course.ts'
import { pathTo, shortestPaths, type NodeId } from './walkGraph.ts'
import type { Vec3 } from './world.ts'

export const ITEM_KINDS = ['boost', 'spring', 'wings', 'shield', 'freeze', 'heart'] as const
export type ItemKind = (typeof ITEM_KINDS)[number]

export const ITEM_INFO: Record<ItemKind, { name: string; seconds: number; blurb: string; weight: number }> = {
  boost: { name: 'Boost', seconds: 4, blurb: 'Run much faster', weight: 28 },
  spring: { name: 'Super jump', seconds: 10, blurb: 'Jump twice as high', weight: 20 },
  wings: { name: 'Wings', seconds: 6, blurb: 'Hold Jump to fly', weight: 14 },
  shield: { name: 'Shield', seconds: 12, blurb: 'Blocks one hit', weight: 22 },
  freeze: { name: 'Freeze', seconds: 4, blurb: 'Freezes the flag', weight: 16 },
  heart: { name: 'Extra life', seconds: 0, blurb: 'Get a life back', weight: 18 }, // only rolled when you are down a life
}

export const TUNING = {
  countdownSeconds: 3,
  checkpointBonus: 8, // seconds added at every gate
  lives: 3, // you lose one when a hazard hits you; at none, the race is over. Falling never costs a life.
  stunSeconds: 0.8,
  invulnerableSeconds: 2,
  itemRespawnSeconds: 12,
  boostSpeed: 1.9, // times the normal run speed
  springJump: 1.45, // times the normal jump speed (which is about twice the height)
  flagFleeSpeed: 1.0, // times the player's run speed
  flagPatrolSpeed: 0.35,
  flagRunSeconds: 5, // the fleeing flag gets tired after this long...
  flagTiredSeconds: 1.0, // ...and stands still for this long
  flagDashSpeed: 1.9, // times its normal speed, in a burst when you get close
  flagDashSeconds: 0.5,
  flagDashCooldown: 2.5,
  flagDashTrigger: 3, // it dashes when you are within this many character-heights
  tagsNeeded: 3, // you must catch the flag this many times; it comes back faster each time
  tagBonus: 5, // seconds added for each catch
  flagFasterPerTag: 0.1, // its speed grows by this much per catch
}

export type GameEvent =
  | { type: 'go' }
  | { type: 'checkpoint'; index: number; total: number; bonus: number }
  | { type: 'flagUnlocked' }
  | { type: 'flagLocked' } // you touched the flag before passing every gate
  | { type: 'item'; kind: ItemKind }
  | { type: 'itemFull' } // you touched a box while already holding an item
  | { type: 'use'; kind: ItemKind }
  | { type: 'effectEnd'; kind: ItemKind }
  | { type: 'hit'; blocked: boolean; dirX: number; dirZ: number }
  | { type: 'life'; lives: number; reason: 'hazard' | 'heart' } // your life count changed
  | { type: 'livesFull' } // you tried to use an Extra life while at full health
  | { type: 'flagTired' }
  | { type: 'flagDash' }
  | { type: 'tag'; n: number; of: number }
  | { type: 'win'; timeLeft: number; hits: number }
  | { type: 'lose'; reason: 'time' | 'lives' }

export type Phase = 'countdown' | 'running' | 'won' | 'lost'

interface HazardState {
  def: HazardDef
  t: number // 0..1 along a -> b
  dir: 1 | -1
  pos: Vec3
}

interface FlagState {
  pos: Vec3
  node: NodeId // the node it is heading for, or standing on
  path: NodeId[] // the route it is following (the first is where it is now)
  step: number // index of the node it is walking away from
  along: number // metres into the current step
  tired: number // seconds left standing still
  frozen: boolean // true while the tiredness comes from a Freeze item
  runTimer: number // seconds spent fleeing since the last rest
  dash: number // seconds left in a burst of speed
  dashCooldown: number // seconds until it can dash again
  think: number // seconds until it decides where to run next
}

export interface ItemBox {
  pos: Vec3
  active: boolean
  respawn: number
  touchedWhileFull: boolean
}

export class Game {
  phase: Phase = 'countdown'
  countdown = TUNING.countdownSeconds
  timeLeft: number
  readonly totalTime: number
  cpIndex = 0 // the next gate to pass
  held: ItemKind | null = null
  effects: Record<ItemKind, number> = { boost: 0, spring: 0, wings: 0, shield: 0, freeze: 0, heart: 0 }
  stun = 0
  invulnerable = 0
  hits = 0
  lives: number = TUNING.lives
  tags = 0 // how many times the flag has been caught
  readonly hazards: HazardState[]
  readonly items: ItemBox[]
  readonly flag: FlagState
  readonly course: Course
  private cfg: { unit: number; runSpeed: number; seed: number }
  private rng: () => number
  private flagWarned = 0
  private patrolRange: number

  constructor(course: Course, cfg: { unit: number; runSpeed: number; seed: number }) {
    this.course = course
    this.cfg = cfg
    this.rng = makeRng(cfg.seed * 7919 + 13)
    this.timeLeft = this.totalTime = Math.round(25 + course.routeLength / (cfg.runSpeed * 0.6) + 15 * TUNING.tagsNeeded)
    this.hazards = course.hazards.map((def, i) => ({ def, t: (i * 0.37) % 1, dir: i % 2 === 0 ? 1 : -1, pos: [...def.a] as Vec3 }))
    this.hazards.forEach((h) => this.placeHazard(h))
    this.items = course.items.map((it) => ({ pos: it.pos, active: true, respawn: 0, touchedWhileFull: false }))
    const n = course.graph.nodes[course.flagStart]
    this.flag = { pos: [n.x, n.y, n.z], node: course.flagStart, path: [course.flagStart], step: 0, along: 0, tired: 0, frozen: false, runTimer: 0, dash: 0, dashCooldown: 0, think: 0 }
    this.patrolRange = cfg.unit * 10
  }

  get flagUnlocked(): boolean {
    return this.cpIndex >= this.course.checkpoints.length
  }
  get startPos(): Vec3 {
    const n = this.course.graph.nodes[this.course.start]
    return [n.x, n.y, n.z]
  }
  /** Where to put the player after a fall: the last gate passed, or the start. */
  respawnPoint(): Vec3 {
    return this.cpIndex > 0 ? this.course.checkpoints[this.cpIndex - 1].pos : this.startPos
  }

  /** What the player may do right now. */
  modifiers(): { speedMult: number; jumpSpeedMult: number; flying: boolean; canMove: boolean } {
    return {
      speedMult: this.effects.boost > 0 ? TUNING.boostSpeed : 1,
      jumpSpeedMult: this.effects.spring > 0 ? TUNING.springJump : 1,
      flying: this.effects.wings > 0,
      canMove: this.phase === 'running' && this.stun <= 0,
    }
  }

  /** Use the held item. */
  useItem(): GameEvent[] {
    if (this.phase !== 'running' || this.held === null) return []
    const kind = this.held
    if (kind === 'heart' && this.lives >= TUNING.lives) return [{ type: 'livesFull' }] // keep it for when you need it
    this.held = null
    if (kind === 'heart') {
      this.lives++
      return [{ type: 'use', kind }, { type: 'life', lives: this.lives, reason: 'heart' }]
    }
    if (kind === 'freeze') {
      this.flag.tired = Math.max(this.flag.tired, ITEM_INFO.freeze.seconds)
      this.flag.frozen = true
      this.effects.freeze = ITEM_INFO.freeze.seconds
    } else {
      this.effects[kind] = ITEM_INFO[kind].seconds
    }
    return [{ type: 'use', kind }]
  }

  /** For tests and cheats: put an item in your hand. */
  give(kind: ItemKind): void {
    this.held = kind
  }

  update(dt: number, player: Vec3): GameEvent[] {
    const events: GameEvent[] = []
    if (this.phase === 'countdown') {
      this.countdown -= dt
      if (this.countdown <= 0) {
        this.phase = 'running'
        events.push({ type: 'go' })
      }
      return events
    }
    if (this.phase !== 'running') return events

    this.timeLeft -= dt
    if (this.timeLeft <= 0) {
      this.timeLeft = 0
      this.phase = 'lost'
      events.push({ type: 'lose', reason: 'time' })
      return events
    }
    this.stun = Math.max(0, this.stun - dt)
    this.invulnerable = Math.max(0, this.invulnerable - dt)
    this.flagWarned = Math.max(0, this.flagWarned - dt)
    for (const kind of ITEM_KINDS) {
      if (this.effects[kind] > 0) {
        this.effects[kind] = Math.max(0, this.effects[kind] - dt)
        if (this.effects[kind] === 0) events.push({ type: 'effectEnd', kind })
      }
    }
    this.updateHazards(dt, player, events)
    this.updateItems(dt, player, events)
    this.updateCheckpoint(player, events)
    this.updateFlag(dt, player, events)
    return events
  }

  // ---- lives ----
  private loseLife(reason: 'hazard'): GameEvent[] {
    this.lives = Math.max(0, this.lives - 1)
    const events: GameEvent[] = [{ type: 'life', lives: this.lives, reason }]
    if (this.lives === 0) {
      this.phase = 'lost'
      events.push({ type: 'lose', reason: 'lives' })
    }
    return events
  }

  // ---- hazards ----
  private placeHazard(h: HazardState): void {
    const { a, b } = h.def
    h.pos = [a[0] + (b[0] - a[0]) * h.t, a[1] + (b[1] - a[1]) * h.t, a[2] + (b[2] - a[2]) * h.t]
  }
  private updateHazards(dt: number, player: Vec3, events: GameEvent[]): void {
    const playerRadius = this.cfg.unit * 0.22
    for (const h of this.hazards) {
      const length = Math.hypot(h.def.b[0] - h.def.a[0], h.def.b[2] - h.def.a[2]) || 1
      h.t += (h.dir * h.def.speed * dt) / length
      if (h.t > 1) {
        h.t = 1
        h.dir = -1
      } else if (h.t < 0) {
        h.t = 0
        h.dir = 1
      }
      this.placeHazard(h)
      const dx = player[0] - h.pos[0]
      const dz = player[2] - h.pos[2]
      const touching = Math.hypot(dx, dz) < h.def.radius + playerRadius && player[1] < h.pos[1] + h.def.radius * 2
      if (!touching || this.invulnerable > 0) continue // jump over it, or be inside the grace period after a hit
      const away = Math.hypot(dx, dz) || 1
      if (this.effects.shield > 0) {
        this.effects.shield = 0
        this.invulnerable = 0.8
        events.push({ type: 'hit', blocked: true, dirX: dx / away, dirZ: dz / away })
        events.push({ type: 'effectEnd', kind: 'shield' })
      } else {
        this.stun = TUNING.stunSeconds
        this.invulnerable = TUNING.invulnerableSeconds
        this.hits++
        events.push({ type: 'hit', blocked: false, dirX: dx / away, dirZ: dz / away })
        events.push(...this.loseLife('hazard'))
      }
    }
  }

  // ---- item boxes ----
  private rollItem(): ItemKind {
    const weight = (k: ItemKind) => (k === 'heart' && this.lives >= TUNING.lives ? 0 : ITEM_INFO[k].weight) // no Extra life when you are at full health
    const total = ITEM_KINDS.reduce((s, k) => s + weight(k), 0)
    let r = this.rng() * total
    for (const k of ITEM_KINDS) {
      r -= weight(k)
      if (r <= 0) return k
    }
    return 'boost'
  }
  private updateItems(dt: number, player: Vec3, events: GameEvent[]): void {
    for (const box of this.items) {
      if (!box.active) {
        box.respawn -= dt
        if (box.respawn <= 0) box.active = true
        continue
      }
      const near = Math.hypot(player[0] - box.pos[0], player[2] - box.pos[2]) < this.cfg.unit * 0.8 && Math.abs(player[1] - box.pos[1]) < this.cfg.unit * 1.6
      if (!near) {
        box.touchedWhileFull = false
        continue
      }
      if (this.held !== null) {
        if (!box.touchedWhileFull) events.push({ type: 'itemFull' })
        box.touchedWhileFull = true
        continue
      }
      this.held = this.rollItem()
      box.active = false
      box.respawn = TUNING.itemRespawnSeconds
      events.push({ type: 'item', kind: this.held })
    }
  }

  // ---- checkpoints ----
  private updateCheckpoint(player: Vec3, events: GameEvent[]): void {
    if (this.flagUnlocked) return
    const cp = this.course.checkpoints[this.cpIndex]
    if (Math.hypot(player[0] - cp.pos[0], player[2] - cp.pos[2]) < this.cfg.unit * 0.9 && Math.abs(player[1] - cp.pos[1]) < this.cfg.unit * 1.4) {
      this.cpIndex++
      this.timeLeft += TUNING.checkpointBonus
      events.push({ type: 'checkpoint', index: this.cpIndex, total: this.course.checkpoints.length, bonus: TUNING.checkpointBonus })
      if (this.flagUnlocked) events.push({ type: 'flagUnlocked' })
    }
  }

  // ---- the flag ----
  private updateFlag(dt: number, player: Vec3, events: GameEvent[]): void {
    const f = this.flag
    const fleeing = this.flagUnlocked

    if (f.tired > 0) {
      f.tired = Math.max(0, f.tired - dt)
      if (f.tired === 0) f.frozen = false
    } else {
      f.think -= dt
      const done = f.step >= f.path.length - 1
      if (done || (fleeing && f.think <= 0)) this.chooseRoute(player, fleeing)
      f.dash = Math.max(0, f.dash - dt)
      f.dashCooldown = Math.max(0, f.dashCooldown - dt)
      if (fleeing && f.dash === 0 && f.dashCooldown === 0 && Math.hypot(player[0] - f.pos[0], player[2] - f.pos[2]) < this.cfg.unit * TUNING.flagDashTrigger) {
        f.dash = TUNING.flagDashSeconds // you got close: sprint away
        f.dashCooldown = TUNING.flagDashCooldown
        events.push({ type: 'flagDash' })
      }
      const faster = 1 + TUNING.flagFasterPerTag * this.tags
      const speed = this.cfg.runSpeed * (fleeing ? TUNING.flagFleeSpeed * faster : TUNING.flagPatrolSpeed) * (f.dash > 0 ? TUNING.flagDashSpeed : 1)
      this.advanceFlag(speed * dt)
      if (fleeing) {
        f.runTimer += dt
        if (f.runTimer >= TUNING.flagRunSeconds) {
          f.runTimer = 0
          f.tired = TUNING.flagTiredSeconds
          events.push({ type: 'flagTired' })
        }
      }
    }

    const close = Math.hypot(player[0] - f.pos[0], player[2] - f.pos[2]) < this.cfg.unit * 0.75 && Math.abs(player[1] - f.pos[1]) < this.cfg.unit * 1.6
    if (!close) return
    if (fleeing) {
      this.tags++
      if (this.tags >= TUNING.tagsNeeded) {
        this.phase = 'won'
        events.push({ type: 'tag', n: this.tags, of: TUNING.tagsNeeded })
        events.push({ type: 'win', timeLeft: this.timeLeft, hits: this.hits })
      } else {
        this.timeLeft += TUNING.tagBonus
        events.push({ type: 'tag', n: this.tags, of: TUNING.tagsNeeded })
        this.sendFlagAway(player)
      }
    } else if (this.flagWarned === 0) {
      this.flagWarned = 2.5
      events.push({ type: 'flagLocked' })
    }
  }

  /** After a catch: the flag reappears as far from the player as it can be (by walking distance) and takes off again. */
  private sendFlagAway(player: Vec3): void {
    const f = this.flag
    const g = this.course.graph
    const playerNode = g.nearest(player[0], player[1], player[2])
    if (playerNode === null) return
    const fromPlayer = shortestPaths(g, playerNode, Infinity, false) // only places it can walk to, not climb onto
    let far: NodeId = f.node
    let farCost = -1
    for (let n = 0; n < g.nodes.length; n++) {
      if (Number.isFinite(fromPlayer.cost[n]) && fromPlayer.cost[n] > farCost) {
        farCost = fromPlayer.cost[n]
        far = n
      }
    }
    const node = g.nodes[far]
    f.pos = [node.x, node.y, node.z]
    f.node = far
    f.path = [far]
    f.step = 0
    f.along = 0
    f.tired = 0
    f.frozen = false
    f.runTimer = 0
    f.dash = 0
    f.dashCooldown = 1.5 // a moment before its first dash
    f.think = 0
  }

  /**
   * Pick where the flag goes next. Locked: a random wander. Once it flees: the spot it can reach well BEFORE you can (compared by how long
   * each of you would take, walking the real map), so it circles round furniture and walls instead of running into a corner.
   */
  private chooseRoute(player: Vec3, fleeing: boolean): void {
    const f = this.flag
    const g = this.course.graph
    const here = f.path[Math.min(f.step + (f.along > 0 ? 1 : 0), f.path.length - 1)]
    const paths = shortestPaths(g, here, this.patrolRange)
    const playerNode = fleeing ? g.nearest(player[0], player[1], player[2]) : null
    const fromPlayer = playerNode === null ? null : shortestPaths(g, playerNode)
    const flagSpeed = this.cfg.runSpeed * TUNING.flagFleeSpeed
    let best: NodeId | null = null
    let bestScore = -Infinity
    for (let n = 0; n < g.nodes.length; n++) {
      const cost = paths.cost[n]
      if (!Number.isFinite(cost) || n === here || cost < this.patrolRange * (fleeing ? 0.12 : 0.25)) continue
      let score = this.rng()
      if (fromPlayer) {
        const playerCost = Number.isFinite(fromPlayer.cost[n]) ? fromPlayer.cost[n] : 1e3
        const lead = playerCost / this.cfg.runSpeed - cost / flagSpeed // seconds the flag gets there ahead of you
        const away = Math.hypot(g.nodes[n].x - player[0], g.nodes[n].z - player[2])
        score = lead + away * 0.4 + this.rng() * 0.3
      }
      if (score > bestScore) {
        bestScore = score
        best = n
      }
    }
    f.think = 0.4
    if (best === null) return
    const route = pathTo(paths, best)
    if (route.length < 2) return
    f.path = [here, ...route.slice(1)]
    f.step = 0
    f.along = 0
    f.node = best
  }

  private advanceFlag(distance: number): void {
    const f = this.flag
    const g = this.course.graph
    let left = distance
    while (left > 0 && f.step < f.path.length - 1) {
      const a = g.nodes[f.path[f.step]]
      const b = g.nodes[f.path[f.step + 1]]
      const length = Math.hypot(b.x - a.x, b.z - a.z) || 1e-6
      const room = length - f.along
      if (left < room) {
        f.along += left
        left = 0
      } else {
        left -= room
        f.step++
        f.along = 0
      }
    }
    const a = g.nodes[f.path[Math.min(f.step, f.path.length - 1)]]
    const b = g.nodes[f.path[Math.min(f.step + 1, f.path.length - 1)]]
    const length = Math.hypot(b.x - a.x, b.z - a.z) || 1
    const t = f.step >= f.path.length - 1 ? 0 : f.along / length
    f.pos = [a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t]
  }
}
