// Play mode: run and jump across the room's real furniture to reach the goal.
// Draws with the shared stage (stage.ts), moves with Rapier (physics.ts + motion.ts).

import RAPIER from '@dimforge/rapier3d-compat'
import * as THREE from 'three'
import { createCharacterModel } from './character.ts'
import { createColliderDebug, type ColliderDebug } from './colliderDebug.ts'
import { angleDiff, createFollowCamera } from './followCamera.ts'
import { createInput, hasTouch } from './input.ts'
import { MOVE, newMotionState, stepCharacter } from './motion.ts'
import { CHARACTER, FIXED_DT, buildPhysicsWorld, createCharacterBody, freePhysics, initPhysics } from './physics.ts'
import { OBJECT_LABEL, SPAWN_MARKER } from './roomScene.ts'
import { loadScanMesh, scanMeshUrl } from './scanMesh.ts'
import { createStage } from './stage.ts'
import type { World } from './world.ts'

const GOAL_RADIUS = 0.5 // metres, measured across the floor
const FALL_LIMIT = 3 // metres below the floor: respawn
const MAX_STEPS_PER_FRAME = 5 // if the phone stalls, skip ahead rather than freeze
const CAMERA_WALL_SLACK = 1 // metres the camera may go past the (undrawn) room walls; furniture always blocks it

// Debug switches, read from the page address: e.g. http://localhost:5173/?colliders&fps
const params = new URLSearchParams(window.location.search)
const SHOW_COLLIDERS = params.has('colliders')
const SHOW_FPS = params.has('fps')

export interface PlayMode {
  dispose: () => void
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** Start play mode inside `container`. Resolves once Rapier is loaded and the room is built. */
export async function startPlay(container: HTMLElement, world: World, onBack: () => void): Promise<PlayMode> {
  await initPhysics()

  // ---- Drawing ----
  const stage = createStage(container)
  stage.setRoom(world)
  // If this world came from a scan, you play in the scanned room itself. The boxes stay in the physics (they are what you bump into and
  // jump onto) but are not drawn. If the scan cannot be loaded, the boxes are drawn as before.
  const scanUrl = scanMeshUrl(world)
  if (scanUrl) {
    try {
      stage.scanLayer.add(await loadScanMesh(scanUrl))
      stage.setBoxStyle('hidden')
    } catch {
      // keep the boxes
    }
  }
  // Keep the view clear while playing: no furniture labels, and no Start pole sticking through
  // the character. The Goal marker stays, so you can always see where to go.
  stage.scene.traverse((obj) => {
    if (obj.name === OBJECT_LABEL || obj.name === SPAWN_MARKER) obj.visible = false
  })
  const model = createCharacterModel()
  stage.scene.add(model)

  // ---- Physics ----
  const floorY = world.room.floor_y
  // Spawn and goal sit on the floor (use floor_y, never assume 0).
  const spawnFeet = new THREE.Vector3(world.spawn[0], floorY, world.spawn[2])
  const goal = new THREE.Vector3(world.goal[0], floorY, world.goal[2])
  const { physics, isWall } = buildPhysicsWorld(world)
  const character = createCharacterBody(physics, [spawnFeet.x, spawnFeet.y, spawnFeet.z])
  let motion = newMotionState()

  let debug: ColliderDebug | null = null
  if (SHOW_COLLIDERS) {
    debug = createColliderDebug(physics)
    stage.scene.add(debug.object)
  }

  // ---- On-screen bits (HUD) ----
  const hud = el('div', 'play-hud')
  const back = el('button', 'btn btn-small hud-back', 'Back')
  back.type = 'button'
  back.addEventListener('click', onBack)
  const timer = el('div', 'hud-timer', '0.0 s')
  const fps = el('div', 'hud-fps')
  fps.hidden = !SHOW_FPS
  const hint = el('p', 'hud-hint', 'WASD or arrows to move · Space to jump · drag to look')
  hint.hidden = hasTouch()
  const win = el('div', 'hud-win')
  win.hidden = true
  win.setAttribute('role', 'dialog')
  win.setAttribute('aria-label', 'You made it')
  const winTitle = el('h2', '', 'You made it!')
  const winTime = el('p', 'hud-win-time')
  const restart = el('button', 'btn btn-primary', 'Restart')
  restart.type = 'button'
  win.append(winTitle, winTime, restart)
  hud.append(back, timer, fps, hint, win)
  container.append(hud)

  // No long-press menu on the 3D view or the controls.
  const noMenu = (e: Event) => e.preventDefault()
  container.addEventListener('contextmenu', noMenu)

  const input = createInput(stage.canvas, hud)
  const cam = createFollowCamera(stage.camera)

  // ---- Game state ----
  let elapsed = 0 // seconds of play (pauses with the tab)
  let finished = false
  const facingGoal = () => Math.atan2(goal.x - spawnFeet.x, goal.z - spawnFeet.z)
  let facing = facingGoal() // which way the character faces (radians around y); start facing the goal
  let accumulator = 0
  const prevCentre = new THREE.Vector3()
  const currCentre = new THREE.Vector3()
  const drawFeet = new THREE.Vector3()

  function readCentre(out: THREE.Vector3): THREE.Vector3 {
    const t = character.body.translation()
    return out.set(t.x, t.y, t.z)
  }

  function respawn(): void {
    character.body.setTranslation({ x: spawnFeet.x, y: spawnFeet.y + CHARACTER.height / 2, z: spawnFeet.z }, true)
    physics.step() // let the colliders catch up with the teleport
    motion = newMotionState()
    readCentre(prevCentre)
    readCentre(currCentre)
    model.position.copy(spawnFeet)
    cam.reset(spawnFeet, facing)
  }

  function restartRun(): void {
    finished = false
    elapsed = 0
    win.hidden = true
    facing = facingGoal()
    respawn()
  }
  restart.addEventListener('click', restartRun)

  /** How far the camera can go from `from` along `dir`: stopped by furniture and the floor, or a little past a wall. */
  const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 })
  function clearDistance(from: THREE.Vector3, dir: THREE.Vector3, max: number): number {
    ray.origin = { x: from.x, y: from.y, z: from.z }
    ray.dir = { x: dir.x, y: dir.y, z: dir.z }
    const cast = (wantWalls: boolean) =>
      physics.castRay(ray, max, true, undefined, undefined, character.collider, undefined, (c) => isWall(c) === wantWalls)
    const solid = cast(false)
    const wall = cast(true)
    return Math.min(max, solid ? solid.timeOfImpact : max, wall ? wall.timeOfImpact + CAMERA_WALL_SLACK : max)
  }

  let fpsFrames = 0
  let fpsTime = 0

  function frame(dt: number): void {
    const move = finished ? { x: 0, y: 0 } : input.move()
    const jump = input.takeJump() && !finished

    // Turn the stick/keys (relative to the camera) into a direction in the room.
    const yaw = cam.yaw()
    const fx = -Math.sin(yaw) // camera's forward, along the floor
    const fz = -Math.cos(yaw)
    const rx = Math.cos(yaw) // camera's right
    const rz = -Math.sin(yaw)
    const wishX = (rx * move.x + fx * move.y) * MOVE.runSpeed
    const wishZ = (rz * move.x + fz * move.y) * MOVE.runSpeed
    const speed = Math.hypot(wishX, wishZ)

    // Fixed-rate physics: run as many 1/60 s steps as real time has passed.
    accumulator += dt
    let steps = 0
    let jumpThisFrame = jump
    while (accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
      prevCentre.copy(currCentre)
      stepCharacter(physics, character, motion, wishX, wishZ, jumpThisFrame)
      jumpThisFrame = false
      readCentre(currCentre)
      accumulator -= FIXED_DT
      steps++
      if (!finished) elapsed += FIXED_DT
    }
    if (steps === MAX_STEPS_PER_FRAME) accumulator = 0
    if (jumpThisFrame) motion.jumpQueued = MOVE.jumpBuffer // pressed between steps: remember it

    // Draw the character between the last two physics steps, so it moves smoothly at 120 Hz too.
    const alpha = accumulator / FIXED_DT
    drawFeet.lerpVectors(prevCentre, currCentre, alpha)
    drawFeet.y -= CHARACTER.height / 2
    model.position.copy(drawFeet)
    if (speed > 0.1) {
      const wanted = Math.atan2(wishX, wishZ)
      facing += angleDiff(facing, wanted) * Math.min(1, 15 * dt)
    }
    model.rotation.y = facing

    // Swing the camera behind only when running away from it (not when running towards it).
    const runningAway = speed > 0.1 ? Math.max(0, move.y) * (speed / MOVE.runSpeed) + Math.abs(move.x) * 0.5 : 0
    cam.update(dt, drawFeet, facing, runningAway, input.takeLook(), clearDistance)

    // Fell out of the world?
    if (currCentre.y - CHARACTER.height / 2 < floorY - FALL_LIMIT) respawn()

    // Reached the goal? (measured across the floor, and not from high above it)
    const feetY = currCentre.y - CHARACTER.height / 2
    const across = Math.hypot(currCentre.x - goal.x, currCentre.z - goal.z)
    if (!finished && across < GOAL_RADIUS && Math.abs(feetY - goal.y) < 1) {
      finished = true
      winTime.textContent = `Time: ${elapsed.toFixed(1)} seconds`
      win.hidden = false
      restart.focus({ preventScroll: true })
    }
    timer.textContent = `${elapsed.toFixed(1)} s`

    debug?.update()

    if (SHOW_FPS) {
      fpsFrames++
      fpsTime += dt
      if (fpsTime >= 0.5) {
        fps.textContent = `${Math.round(fpsFrames / fpsTime)} fps`
        fpsFrames = 0
        fpsTime = 0
      }
    }
  }

  respawn()
  stage.setLoop(frame)

  return {
    dispose: () => {
      stage.setLoop(null)
      input.dispose()
      container.removeEventListener('contextmenu', noMenu)
      hud.remove()
      stage.dispose() // frees the room, character and debug lines
      freePhysics(physics, character)
    },
  }
}
