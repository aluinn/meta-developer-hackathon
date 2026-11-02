// One fixed physics step for the character: gravity, jumping and moving.
// No drawing or browser code here, so it can be tested on its own.

import type RAPIER from '@dimforge/rapier3d-compat'
import { CHARACTER, FIXED_DT, type CharacterBody } from './physics.ts'

export const MOVE = {
  runSpeed: 4, // metres per second
  gravity: 20, // m/s², stronger than real (9.8) so jumps feel snappy, not floaty
  jumpSpeed: 7, // m/s upwards, which reaches about 1.2 m: onto the sofa (0.8 m), not the bookshelf (2 m)
  coyoteTime: 0.1, // seconds you can still jump after running off an edge
  jumpBuffer: 0.12, // seconds a jump press is remembered just before you land
  flyRise: 3, // m/s upwards while flying and holding Jump
  flySink: 1.5, // m/s downwards while flying and not holding Jump
  // Speeding up and slowing down take a moment instead of snapping (these are multiples of runSpeed, per second).
  groundAccel: 11, // about 0.09 s to full speed on the ground
  groundBrake: 15, // stopping is a little quicker than starting, so you can stop on a ledge
  airAccel: 6, // still steerable in the air, but not as sharply
}

/** Things a power-up can change about this step. */
export interface MoveModifiers {
  jumpSpeedMult: number // Super Jump
  flying: boolean // Wings: no gravity; hold Jump to rise, let go to sink
  flyUp: boolean
  /** The highest the top of the head may go while flying (just under the ceiling). Infinity = no limit. */
  flyCeiling?: number
}
export const NO_MODIFIERS: MoveModifiers = { jumpSpeedMult: 1, flying: false, flyUp: false }

export interface MotionState {
  verticalSpeed: number
  grounded: boolean
  sinceGrounded: number // seconds since we last touched the ground
  jumpQueued: number // seconds left on a remembered jump press
  vx: number // current horizontal speed, which eases towards the wanted speed
  vz: number
}

export function newMotionState(): MotionState {
  return { verticalSpeed: 0, grounded: false, sinceGrounded: 0, jumpQueued: 0, vx: 0, vz: 0 }
}

/**
 * Move the character by one physics step (FIXED_DT seconds).
 * `wishX`/`wishZ` is the wanted horizontal speed in m/s; `jumpPressed` is true on the step Jump was pressed.
 */
export function stepCharacter(
  physics: RAPIER.World,
  character: CharacterBody,
  state: MotionState,
  wishX: number,
  wishZ: number,
  jumpPressed: boolean,
  mods: MoveModifiers = NO_MODIFIERS,
): void {
  const dt = FIXED_DT
  if (jumpPressed) state.jumpQueued = MOVE.jumpBuffer

  if (mods.flying) {
    const head = character.body.translation().y + CHARACTER.height / 2
    const atCeiling = head >= (mods.flyCeiling ?? Infinity)
    state.verticalSpeed = mods.flyUp && !atCeiling ? MOVE.flyRise : -MOVE.flySink // no gravity while flying
    state.jumpQueued = 0
  } else {
    state.verticalSpeed -= MOVE.gravity * dt
  }
  const canJump = !mods.flying && (state.grounded || state.sinceGrounded < MOVE.coyoteTime)
  if (state.jumpQueued > 0 && canJump) {
    state.verticalSpeed = MOVE.jumpSpeed * mods.jumpSpeedMult
    state.jumpQueued = 0
    state.sinceGrounded = MOVE.coyoteTime // used up: no second jump in mid-air
  }
  state.jumpQueued = Math.max(0, state.jumpQueued - dt)

  // Ease the real speed towards the wanted speed (smooth starts and stops, softer steering in the air).
  const wishLength = Math.hypot(wishX, wishZ)
  const braking = wishLength < Math.hypot(state.vx, state.vz)
  const accel = (state.grounded ? (braking ? MOVE.groundBrake : MOVE.groundAccel) : MOVE.airAccel) * MOVE.runSpeed
  const dvx = wishX - state.vx
  const dvz = wishZ - state.vz
  const dv = Math.hypot(dvx, dvz)
  const maxDv = accel * dt
  if (dv <= maxDv) {
    state.vx = wishX
    state.vz = wishZ
  } else {
    state.vx += (dvx / dv) * maxDv
    state.vz += (dvz / dv) * maxDv
  }

  // Ask Rapier how far we can really go (it stops us at walls and lifts us onto small steps).
  const wanted = { x: state.vx * dt, y: state.verticalSpeed * dt, z: state.vz * dt }
  character.controller.computeColliderMovement(character.collider, wanted)
  const moved = character.controller.computedMovement()
  state.grounded = character.controller.computedGrounded()

  if (state.grounded) {
    state.sinceGrounded = 0
    if (state.verticalSpeed < 0) state.verticalSpeed = 0
  } else {
    state.sinceGrounded += dt
  }
  // Ran into a wall: lose that speed too, so you don't keep pushing against it.
  if (Math.abs(moved.x) < Math.abs(wanted.x) * 0.5) state.vx = 0
  if (Math.abs(moved.z) < Math.abs(wanted.z) * 0.5) state.vz = 0
  // Bumped our head on something while going up: start falling.
  if (state.verticalSpeed > 0 && moved.y < wanted.y * 0.5) state.verticalSpeed = 0

  const p = character.body.translation()
  character.body.setNextKinematicTranslation({ x: p.x + moved.x, y: p.y + moved.y, z: p.z + moved.z })
  physics.step()
}
