// Physics for play mode, using Rapier. Built from the world.json boxes (NOT the scan mesh).
//
// Everything in the room is "static" (it never moves). The character is "kinematic":
// we decide where it wants to go each step, and Rapier's character controller
// slides it along walls, lands it on furniture and climbs small steps.

import RAPIER from '@dimforge/rapier3d-compat'
import type { ScanTriangles } from './scanCollider.ts'
import type { Vec3, World } from './world.ts'

/** Physics runs at exactly 60 steps a second, whatever the screen's frame rate. */
export const FIXED_DT = 1 / 60

// The numbers below are the "human" size; profile.ts overwrites them for the toy-sized character on a real scan.
export const CHARACTER = {
  height: 1.6, // metres, feet to top of head
  radius: 0.25,
  stepHeight: 0.3, // ledges up to this high are climbed automatically (not the 0.4 m coffee table)
  skin: 0.01, // gap kept between the character and surfaces, to avoid getting stuck
  snapToGround: 0.2, // stay stuck to the floor when walking off drops this small
  stepMinWidth: 0.15, // a step must be at least this deep to be climbed
}

const WALL_THICKNESS = 0.5
const WALL_EXTRA_HEIGHT = 20 // far higher than anyone can jump, so you can't leave the room

let rapierReady: Promise<void> | null = null

/** The -compat build has to unpack its WebAssembly before first use. Safe to call many times. */
export function initPhysics(): Promise<void> {
  rapierReady ??= RAPIER.init()
  return rapierReady
}

/** Add a fixed (never moving) box. `centre` is the middle; `half` is half of [w, h, d]; turned by `rotationY` radians. */
function addBox(physics: RAPIER.World, centre: Vec3, half: Vec3, rotationY = 0): RAPIER.Collider {
  // A turn of `rotationY` around the y axis, as a quaternion. three.js uses the same convention,
  // so the collider turns exactly like the drawn box.
  const s = Math.sin(rotationY / 2)
  const c = Math.cos(rotationY / 2)
  const desc = RAPIER.ColliderDesc.cuboid(half[0], half[1], half[2])
    .setTranslation(centre[0], centre[1], centre[2])
    .setRotation({ x: 0, y: s, z: 0, w: c })
  return physics.createCollider(desc)
}

export interface PhysicsRoom {
  physics: RAPIER.World
  /** True for the four invisible room walls (the camera may go a little way past these). */
  isWall: (collider: RAPIER.Collider) => boolean
}

/**
 * A Rapier world with the floor and invisible walls, plus the solid things to run on: either the real scan's triangles (the character
 * runs on the actual scan), or, with no scan, a box for every solid object in world.json.
 */
export function buildPhysicsWorld(world: World, scan?: ScanTriangles): PhysicsRoom {
  const physics = new RAPIER.World({ x: 0, y: 0, z: 0 }) // we apply gravity to the character ourselves
  physics.timestep = FIXED_DT

  const { min, max } = world.room.bounds
  const floorY = world.room.floor_y
  const T = WALL_THICKNESS
  const cx = (min[0] + max[0]) / 2
  const cz = (min[2] + max[2]) / 2
  const halfW = (max[0] - min[0]) / 2
  const halfD = (max[2] - min[2]) / 2

  // Floor: a thick slab whose TOP is exactly at floor_y.
  addBox(physics, [cx, floorY - T / 2, cz], [halfW + T, T / 2, halfD + T])

  // Four walls just outside the room's bounds, from below the floor to far above the ceiling.
  const bottom = floorY - T
  const top = Math.max(max[1], floorY) + WALL_EXTRA_HEIGHT
  const wallY = (bottom + top) / 2
  const halfH = (top - bottom) / 2
  const walls = new Set<number>()
  for (const wall of [
    addBox(physics, [min[0] - T / 2, wallY, cz], [T / 2, halfH, halfD + T]),
    addBox(physics, [max[0] + T / 2, wallY, cz], [T / 2, halfH, halfD + T]),
    addBox(physics, [cx, wallY, min[2] - T / 2], [halfW + T, halfH, T / 2]),
    addBox(physics, [cx, wallY, max[2] + T / 2], [halfW + T, halfH, T / 2]),
  ]) {
    walls.add(wall.handle)
  }

  if (scan) {
    // The real scan is the ground. Its furniture is part of it, so the boxes are not needed (and would block the real shapes).
    physics.createCollider(RAPIER.ColliderDesc.trimesh(scan.vertices, scan.indices))
    physics.step() // rays (castRay) only see colliders after the first step, so ground-finding needs this
    return { physics, isWall: (collider) => walls.has(collider.handle) }
  }

  // Furniture. Passable things (rug, door) get no collider: you walk over or through them.
  for (const obj of world.objects) {
    if (obj.role === 'passable') continue
    const [w, h, d] = obj.size
    addBox(physics, obj.position, [w / 2, h / 2, d / 2], obj.rotation_y)
  }
  physics.step() // rays (castRay) only see colliders after the first step
  return { physics, isWall: (collider) => walls.has(collider.handle) }
}

export interface CharacterBody {
  body: RAPIER.RigidBody
  collider: RAPIER.Collider
  controller: RAPIER.KinematicCharacterController
}

/** The character's capsule, standing with its feet at `feet`. */
export function createCharacterBody(physics: RAPIER.World, feet: Vec3): CharacterBody {
  const { height, radius, stepHeight, skin, snapToGround, stepMinWidth } = CHARACTER
  const body = physics.createRigidBody(
    RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(feet[0], feet[1] + height / 2, feet[2]),
  )
  // A capsule is a cylinder with half-spheres on each end. Rapier wants half the cylinder's height.
  const collider = physics.createCollider(RAPIER.ColliderDesc.capsule(height / 2 - radius, radius), body)

  const controller = physics.createCharacterController(skin)
  controller.enableAutostep(stepHeight, stepMinWidth, false)
  controller.setMaxSlopeClimbAngle((50 * Math.PI) / 180)
  controller.setMinSlopeSlideAngle((30 * Math.PI) / 180)
  controller.enableSnapToGround(snapToGround)
  return { body, collider, controller }
}

/** Free Rapier's memory. Rapier lives in WebAssembly, so the browser can't clean it up for us. */
export function freePhysics(physics: RAPIER.World, character: CharacterBody): void {
  physics.removeCharacterController(character.controller)
  physics.free()
}
