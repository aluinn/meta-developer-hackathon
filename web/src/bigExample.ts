// A much bigger version of the example room, for racing in. The shared example (6 x 5 m) is fine to look at, but with a
// person-sized character and rolling hazards it is too cramped to play: there is nowhere to dodge. This spreads the same
// room out and adds a few more things to climb on. (shared/example_world.json itself is not changed: other tests rely on it.)

import { loadExampleWorld } from './world.ts'
import type { World, WorldObject } from './world.ts'

const SPREAD = 2.4 // how much further apart everything is (sizes stay the same)

const EXTRAS: WorldObject[] = [
  { id: 'sofa_2', label: 'sofa', role: 'climbable', confidence: 0.9, position: [3.6, 0.4, -4.3], size: [2.0, 0.8, 0.9], rotation_y: 0.2 },
  { id: 'bookshelf_2', label: 'bookshelf', role: 'fixed', confidence: 0.9, position: [-6.9, 1.0, 1.8], size: [0.3, 2.0, 1.4], rotation_y: 0 },
  { id: 'bookshelf_3', label: 'bookshelf', role: 'fixed', confidence: 0.9, position: [0.5, 1.0, -5.8], size: [1.6, 2.0, 0.3], rotation_y: 0 },
  { id: 'dining_table_1', label: 'dining table', role: 'climbable', confidence: 0.85, position: [-3.6, 0.4, 3.2], size: [1.8, 0.8, 1.0], rotation_y: 0 },
  { id: 'crate_1', label: 'crate', role: 'climbable', confidence: 0.8, position: [-5.6, 0.22, -1.2], size: [0.8, 0.44, 0.8], rotation_y: 0.1 },
  { id: 'crate_2', label: 'crate', role: 'climbable', confidence: 0.8, position: [-4.7, 0.45, -1.3], size: [0.8, 0.9, 0.8], rotation_y: -0.1 },
  { id: 'ottoman_1', label: 'ottoman', role: 'climbable', confidence: 0.8, position: [5.0, 0.2, 2.6], size: [0.7, 0.4, 0.7], rotation_y: 0 },
  { id: 'plant_1', label: 'plant', role: 'movable', confidence: 0.75, position: [6.4, 0.45, -1.4], size: [0.5, 0.9, 0.5], rotation_y: 0 },
]

export async function loadBigExampleWorld(): Promise<World> {
  const base = await loadExampleWorld()
  const wide = (v: [number, number, number]): [number, number, number] => [v[0] * SPREAD, v[1], v[2] * SPREAD]
  const { min, max } = base.room.bounds
  const objects = base.objects.map((o) => ({ ...o, position: wide(o.position) }))
  return {
    ...base,
    room: { ...base.room, bounds: { min: wide(min), max: wide(max) } },
    objects: [...objects, ...EXTRAS],
    spawn: wide(base.spawn),
    goal: wide(base.goal),
  }
}
