// Third-person camera: sits behind and above the character and glides after it.
// While you run, it slowly swings round behind you; dragging the view turns it by hand.
// In tight spots (a wall right behind you) it rises up over the character rather than
// squashing into it, and it is pulled in closer if something is still in the way.

import * as THREE from 'three'

// "Human" size; profile.ts overwrites these for the toy-sized character on a real scan.
export const CAMERA = {
  distance: 4, // metres behind the character
  minDistance: 0.6,
  headHeight: 1.4, // look at the character's head, not its feet
  enoughRoom: 2.5, // metres of clear space behind the character that counts as "fine"
  wallClearance: 0.25, // stop this far in front of whatever is behind us
  pitch: 0.35, // how high above the character the camera starts, in radians (0 = level, 1.57 = straight down)
}
const DRAG_SPEED = 0.004 // radians per pixel dragged
const MIN_PITCH = -0.75 // below zero the camera sits under the character's head, so you look UP at it
const MAX_PITCH = 1.35 // highest you can go (looking almost straight down)
const LOOK_UP_BELOW = 0.12 // at or below this the player chose a low view, so don't lift the camera automatically
const MAX_AUTO_PITCH = 1.45 // in tight corners the camera may rise this high (almost straight down)
const FOLLOW_RATE = 2 // how quickly it swings behind you while running
const MANUAL_PAUSE = 1.5 // seconds of no auto-swing after you drag the view

/** Shortest signed angle from `a` to `b`, in -PI..PI. */
export function angleDiff(a: number, b: number): number {
  return Math.atan2(Math.sin(b - a), Math.cos(b - a))
}

export interface FollowCamera {
  /** Which way the camera faces, as a turn around y. Movement is relative to this. */
  yaw: () => number
  /** Snap straight behind a character facing `facing`. */
  reset: (feet: THREE.Vector3, facing: number) => void
  /**
   * Call every frame. `feet` is the character's (smoothed) position, `facing` which way it faces,
   * `runningAway` 0..1 how much it is running away from the camera (only then do we swing behind),
   * `clearDistance(from, dir, max)` how far the camera can go before hitting something.
   */
  /** Turn the automatic swing-behind-you on or off (off while the mouse is steering the view). */
  setAutoSwing: (on: boolean) => void
  update: (
    dt: number,
    feet: THREE.Vector3,
    facing: number,
    runningAway: number,
    look: { dx: number; dy: number },
    clearDistance: (from: THREE.Vector3, dir: THREE.Vector3, max: number) => number,
  ) => void
}

export function createFollowCamera(camera: THREE.PerspectiveCamera): FollowCamera {
  // yaw 0 = the camera is on the +z side of the character, looking towards -z.
  let yaw = 0
  let pitch: number = CAMERA.pitch // the angle you chose (by dragging)
  let usedPitch: number = CAMERA.pitch // the angle actually used: higher than `pitch` when there's no room behind
  let distance = CAMERA.distance
  let manualTimer = 0
  let autoSwing = true
  const target = new THREE.Vector3()
  const dir = new THREE.Vector3()

  function setDir(p: number): THREE.Vector3 {
    return dir.set(Math.sin(yaw) * Math.cos(p), Math.sin(p), Math.cos(yaw) * Math.cos(p))
  }

  function place(): void {
    setDir(usedPitch)
    camera.position.copy(target).addScaledVector(dir, distance)
    camera.lookAt(target)
  }

  return {
    yaw: () => yaw,
    setAutoSwing: (on) => {
      autoSwing = on
    },
    reset: (feet, facing) => {
      yaw = facing + Math.PI // behind = opposite the way it faces
      pitch = CAMERA.pitch
      usedPitch = pitch
      distance = CAMERA.distance
      target.set(feet.x, feet.y + CAMERA.headHeight, feet.z)
      place()
    },
    update: (dt, feet, facing, runningAway, look, clearDistance) => {
      // Manual turning by dragging.
      if (look.dx !== 0 || look.dy !== 0) {
        yaw -= look.dx * DRAG_SPEED
        pitch = THREE.MathUtils.clamp(pitch + look.dy * DRAG_SPEED, MIN_PITCH, MAX_PITCH)
        manualTimer = MANUAL_PAUSE
      }
      manualTimer = Math.max(0, manualTimer - dt)

      // Auto-swing behind the character while it runs away from us.
      if (autoSwing && manualTimer === 0 && runningAway > 0) {
        yaw += angleDiff(yaw, facing + Math.PI) * Math.min(1, FOLLOW_RATE * runningAway * dt)
      }

      // Glide after the character (quick, but not rigid).
      const wanted = new THREE.Vector3(feet.x, feet.y + CAMERA.headHeight, feet.z)
      target.lerp(wanted, 1 - Math.exp(-12 * dt))

      // Find the lowest angle (starting from yours) with enough room behind the character.
      let bestPitch = pitch
      let bestClear = 0
      // A low view (looking up) is the player's choice: only lift the camera when it is a normal or high view.
      for (let p = pitch; pitch > LOOK_UP_BELOW && p <= MAX_AUTO_PITCH + 1e-6; p += 0.1) {
        const c = clearDistance(target, setDir(p), CAMERA.distance)
        if (c > bestClear) {
          bestClear = c
          bestPitch = p
        }
        if (c >= CAMERA.enoughRoom) break
      }
      usedPitch += (bestPitch - usedPitch) * (1 - Math.exp(-6 * dt)) // ease up/down, no sudden jumps

      // Don't go through walls: stop just in front of whatever is behind us.
      const clear = Math.max(CAMERA.minDistance, clearDistance(target, setDir(usedPitch), CAMERA.distance) - CAMERA.wallClearance)
      // Move in instantly (so we never sit inside a wall), move back out gently.
      distance = clear < distance ? clear : distance + (clear - distance) * (1 - Math.exp(-4 * dt))
      place()
    },
  }
}
