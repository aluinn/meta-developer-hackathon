// One fixed physics step for the character: gravity, jumping and moving.
// No drawing or browser code here, so it can be tested on its own.

import type RAPIER from '@dimforge/rapier3d-compat'
import { FIXED_DT, type CharacterBody } from './physics.ts'

export const MOVE = {
  runSpeed: 4, // metres per second
  gravity: 20, // m/s², stronger than real (9.8) so jumps feel snappy, not floaty
  jumpSpeed: 7, // m/s upwards, which reaches about 1.2 m: onto the sofa (0.8 m), not the bookshelf (2 m)
  coyoteTime: 0.1, // seconds you can still jump after running off an edge
  jumpBuffer: 0.12, // seconds a jump press is remembered just before you land
}

export interface MotionState {
  verticalSpeed: number
  grounded: boolean
  sinceGrounded: number // seconds since we last touched the ground
  jumpQueued: number // seconds left on a remembered jump press
}

export function newMotionState(): MotionState {
  return { verticalSpeed: 0, grounded: false, sinceGrounded: 0, jumpQueued: 0 }
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
): void {
  const dt = FIXED_DT
  if (jumpPressed) state.jumpQueued = MOVE.jumpBuffer

  state.verticalSpeed -= MOVE.gravity * dt
  const canJump = state.grounded || state.sinceGrounded < MOVE.coyoteTime
  if (state.jumpQueued > 0 && canJump) {
    state.verticalSpeed = MOVE.jumpSpeed
    state.jumpQueued = 0
    state.sinceGrounded = MOVE.coyoteTime // used up: no second jump in mid-air
  }
  state.jumpQueued = Math.max(0, state.jumpQueued - dt)

  // Ask Rapier how far we can really go (it stops us at walls and lifts us onto small steps).
  const wanted = { x: wishX * dt, y: state.verticalSpeed * dt, z: wishZ * dt }
  character.controller.computeColliderMovement(character.collider, wanted)
  const moved = character.controller.computedMovement()
  state.grounded = character.controller.computedGrounded()

  if (state.grounded) {
    state.sinceGrounded = 0
    if (state.verticalSpeed < 0) state.verticalSpeed = 0
  } else {
    state.sinceGrounded += dt
  }
  // Bumped our head on something while going up: start falling.
  if (state.verticalSpeed > 0 && moved.y < wanted.y * 0.5) state.verticalSpeed = 0

  const p = character.body.translation()
  character.body.setNextKinematicTranslation({ x: p.x + moved.x, y: p.y + moved.y, z: p.z + moved.z })
  physics.step()
}
