// Third-person camera: sits behind and above the character and glides after it.
// While you run, it slowly swings round behind you; dragging the view turns it by hand.
// It is pulled in closer when a wall or furniture is between it and the character.

import * as THREE from 'three'

const DISTANCE = 4 // metres behind the character
const MIN_DISTANCE = 0.6
const HEAD_HEIGHT = 1.4 // look at the character's head, not its feet
const DRAG_SPEED = 0.005 // radians per pixel dragged
const MIN_PITCH = 0.05
const MAX_PITCH = 1.2
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
  let pitch = 0.35
  let distance = DISTANCE
  let manualTimer = 0
  const target = new THREE.Vector3()
  const dir = new THREE.Vector3()

  function place(): void {
    dir.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch))
    camera.position.copy(target).addScaledVector(dir, distance)
    camera.lookAt(target)
  }

  return {
    yaw: () => yaw,
    reset: (feet, facing) => {
      yaw = facing + Math.PI // behind = opposite the way it faces
      pitch = 0.35
      distance = DISTANCE
      target.set(feet.x, feet.y + HEAD_HEIGHT, feet.z)
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
      if (manualTimer === 0 && runningAway > 0) {
        yaw += angleDiff(yaw, facing + Math.PI) * Math.min(1, FOLLOW_RATE * runningAway * dt)
      }

      // Glide after the character (quick, but not rigid).
      const wanted = new THREE.Vector3(feet.x, feet.y + HEAD_HEIGHT, feet.z)
      target.lerp(wanted, 1 - Math.exp(-12 * dt))

      // Don't go through walls: stop just in front of whatever is behind us.
      dir.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch))
      const clear = Math.max(MIN_DISTANCE, clearDistance(target, dir, DISTANCE) - 0.25)
      // Move in instantly (so we never sit inside a wall), move back out gently.
      distance = clear < distance ? clear : distance + (clear - distance) * (1 - Math.exp(-4 * dt))
      place()
    },
  }
}
