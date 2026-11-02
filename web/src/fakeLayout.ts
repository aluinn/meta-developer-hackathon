// A pretend /layout answer, used while USE_FAKE_SERVER is on (config.ts) so the Layout tab can be built and tested without
// the server. It moves the first movable object 0.5 m towards the middle of the room, with a reason. No AI involved.

import type { Vec3, World } from './world.ts'

export const FAKE_MOVE_M = 0.5

/** The same shape as the server's POST /layout answer (docs/architecture.md, "A4 contracts"), before the page parses it. */
export interface RawLayoutAnswer {
  scan_id: string
  goal: string
  world: World
  changes: Array<{ id: string; label: string; from: { position: Vec3; rotation_y: number }; to: { position: Vec3; rotation_y: number }; reason: string }>
  notes: string
  attempts: number
  spawn_to_goal_walkable: { before: boolean | null; after: boolean | null }
}

export function fakeLayoutAnswer(scanId: string, goal: string, world: World): RawLayoutAnswer {
  const { min, max } = world.room.bounds
  const centreX = (min[0] + max[0]) / 2
  const centreZ = (min[2] + max[2]) / 2
  // The first movable object that is not already in the middle (an object at the centre has nowhere to go).
  const awayFromCentre = (o: { position: Vec3 }) => Math.hypot(centreX - o.position[0], centreZ - o.position[2]) > 0.05
  const mover = world.objects.find((o) => o.role === 'movable' && awayFromCentre(o)) ?? world.objects.find((o) => o.role === 'movable')
  const answer: RawLayoutAnswer = {
    scan_id: scanId,
    goal,
    world: structuredClone(world),
    changes: [],
    notes: '',
    attempts: 1,
    spawn_to_goal_walkable: { before: true, after: true },
  }
  if (!mover) {
    answer.notes = 'Nothing in this room can be moved (no movable objects), so the layout is unchanged. (Pretend answer: no server.)'
    return answer
  }
  const dx = centreX - mover.position[0]
  const dz = centreZ - mover.position[2]
  const distance = Math.hypot(dx, dz)
  const step = Math.min(FAKE_MOVE_M, distance) // never go past the middle
  const to: Vec3 = distance < 1e-6 ? [...mover.position] : [mover.position[0] + (dx / distance) * step, mover.position[1], mover.position[2] + (dz / distance) * step]
  const moved = answer.world.objects.find((o) => o.id === mover.id)
  if (moved) moved.position = to
  answer.changes.push({
    id: mover.id,
    label: mover.label,
    from: { position: [...mover.position], rotation_y: mover.rotation_y },
    to: { position: to, rotation_y: mover.rotation_y },
    reason: `Moved the ${mover.label} ${Math.round(step * 100)} cm towards the middle of the room. (Pretend answer: no server.)`,
  })
  answer.notes = 'This is a pretend answer for testing, not a real suggestion.'
  return answer
}
