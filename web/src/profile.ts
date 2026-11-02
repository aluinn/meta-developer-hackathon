// Two sizes of player. The numbers live here so play mode can switch between them.
//
//  - "human":  a person-sized character in a room made of boxes (the built-in example rooms). Furniture is box-shaped and climbable by jumping.
//  - "tiny":   a toy-sized character running over the REAL scan (its real surfaces are the ground). The room becomes a giant playground:
//              the bathroom is a canyon, the toilet a hill you can hop onto.
// Each field overwrites the matching constant in physics.ts, motion.ts and followCamera.ts, which are read when play mode starts.

import { CAMERA } from './followCamera.ts'
import { MOVE } from './motion.ts'
import { CHARACTER } from './physics.ts'

export type ProfileName = 'human' | 'tiny'

export interface Profile {
  character: typeof CHARACTER
  move: typeof MOVE
  camera: typeof CAMERA
  /** How close (metres, across the floor) you must get to the goal marker. */
  goalRadius: number
  /** How far above or below the goal's floor height still counts as reaching it. */
  goalHeightSlack: number
  /** The Start and Goal poles are drawn this much of their normal size. */
  markerScale: number
  /** How far past the (undrawn) room walls the camera may go. */
  cameraWallSlack: number
  /** The camera's near clipping distance: tiny characters need to let the camera get very close without cutting things off. */
  cameraNear: number
  cameraFar: number
}

const JUMP_HEIGHT_TINY = 0.55 // metres: hops onto a toilet seat or sofa cushion, not onto a sink
const GRAVITY_TINY = 14

export const PROFILES: Record<ProfileName, Profile> = {
  human: {
    character: { height: 1.6, radius: 0.25, stepHeight: 0.3, skin: 0.01, snapToGround: 0.2, stepMinWidth: 0.15 },
    move: { runSpeed: 4, gravity: 20, jumpSpeed: 7, coyoteTime: 0.1, jumpBuffer: 0.12, flyRise: 3, flySink: 1.5 },
    camera: { distance: 4, minDistance: 0.6, headHeight: 1.4, enoughRoom: 2.5, wallClearance: 0.25, pitch: 0.35 },
    goalRadius: 0.5,
    goalHeightSlack: 1,
    markerScale: 1,
    cameraWallSlack: 1,
    cameraNear: 0.1,
    cameraFar: 200,
  },
  tiny: {
    character: { height: 0.15, radius: 0.035, stepHeight: 0.025, skin: 0.003, snapToGround: 0.03, stepMinWidth: 0.02 },
    move: { runSpeed: 1.1, gravity: GRAVITY_TINY, jumpSpeed: Math.sqrt(2 * GRAVITY_TINY * JUMP_HEIGHT_TINY), coyoteTime: 0.1, jumpBuffer: 0.12, flyRise: 0.9, flySink: 0.4 },
    camera: { distance: 1.6, minDistance: 0.25, headHeight: 0.07, enoughRoom: 0.9, wallClearance: 0.05, pitch: 0.55 }, // far enough back to show how big the room is
    goalRadius: 0.22,
    goalHeightSlack: 0.5,
    markerScale: 0.35,
    cameraWallSlack: 0.25,
    cameraNear: 0.01,
    cameraFar: 60,
  },
}

/** Switch the shared constants to this size. Call before building the physics world, the character or the camera. */
export function applyProfile(name: ProfileName): Profile {
  const profile = PROFILES[name]
  Object.assign(CHARACTER, profile.character)
  Object.assign(MOVE, profile.move)
  Object.assign(CAMERA, profile.camera)
  return profile
}
