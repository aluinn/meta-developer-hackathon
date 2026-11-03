// Play mode: a race across the room's real furniture. Pass the checkpoint gates, dodge the rolling hazards, grab power-ups, then catch the
// moving flag three times before the time runs out. (If no course can be planned, it falls back to the old "walk to the goal" game.)
// Draws with the shared stage (stage.ts), moves with Rapier (physics.ts + motion.ts); the rules are in game.ts.

import RAPIER from '@dimforge/rapier3d-compat'
import * as THREE from 'three'
import { createCharacter } from './character.ts'
import { createColliderDebug, type ColliderDebug } from './colliderDebug.ts'
import { CAMERA, angleDiff, createFollowCamera } from './followCamera.ts'
import { createInput, hasTouch } from './input.ts'
import { generateCourse } from './course.ts'
import { Game, TUNING, ITEM_INFO, type GameEvent } from './game.ts'
import { createGameScene, type GameScene } from './gameScene.ts'
import { createRaceHud, type RaceHud } from './gameHud.ts'
import { MOVE, newMotionState, stepCharacter } from './motion.ts'
import { CHARACTER, FIXED_DT, buildPhysicsWorld, createCharacterBody, freePhysics, initPhysics } from './physics.ts'
import { applyProfile } from './profile.ts'
import { GOAL_MARKER, OBJECT_LABEL, SPAWN_MARKER } from './roomScene.ts'
import { extractTriangles } from './scanCollider.ts'
import { loadScanMesh, scanMeshUrl } from './scanMesh.ts'
import { createProbe } from './probe.ts'
import { createBlobShadow } from './shadow.ts'
import { createStage } from './stage.ts'
import { buildGraph, type Graph } from './walkGraph.ts'
import type { Vec3, World } from './world.ts'

const FALL_LIMIT = 3 // metres below the floor: respawn
const MAX_STEPS_PER_FRAME = 5 // if the phone stalls, skip ahead rather than freeze

// Debug switches, read from the page address: e.g. http://localhost:5173/?colliders&fps
const params = new URLSearchParams(window.location.search)
const SHOW_COLLIDERS = params.has('colliders')
const SHOW_FPS = params.has('fps')
const CLASSIC = params.has('classic') // the old walk-to-the-goal game, without the race
const DEBUG = params.has('debug') // exposes window.__rw for tests
const KNOCKBACK_SECONDS = 0.25

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
  // If this world came from a scan, you play ON the scanned room itself, as a toy-sized character: the scan's real surfaces are the
  // ground (see physics.ts) and the boxes are not drawn. If the scan cannot be loaded, it is the person-sized game on boxes, as before.
  const scanUrl = scanMeshUrl(world)
  let scanMesh: THREE.Object3D | null = null
  if (scanUrl) {
    try {
      scanMesh = await loadScanMesh(scanUrl)
      stage.scanLayer.add(scanMesh)
      stage.setBoxStyle('hidden')
    } catch {
      scanMesh = null
    }
  }
  const profile = applyProfile(scanMesh ? 'tiny' : 'human') // sizes, speeds and camera distances for this kind of room
  // In the race the person-sized character needs the camera further back, to see the hazards coming. (The profile itself keeps its original numbers.)
  if (!scanMesh && !CLASSIC) Object.assign(CAMERA, { distance: 6.5, minDistance: 0.8, enoughRoom: 4, pitch: 0.5 })
  stage.camera.near = profile.cameraNear
  stage.camera.far = profile.cameraFar
  stage.camera.updateProjectionMatrix()
  // Keep the view clear while playing: no furniture labels, and no Start pole sticking through
  // the character. The Goal marker stays, so you can always see where to go.
  stage.scene.traverse((obj) => {
    if (obj.name === OBJECT_LABEL || obj.name === SPAWN_MARKER) obj.visible = false
    if (obj.name === GOAL_MARKER) obj.scale.setScalar(profile.markerScale)
  })
  const model = await createCharacter() // the player's picture, the default bean, or simple shapes
  stage.scene.add(model)
  const shadow = createBlobShadow(CHARACTER.radius * 1.7)
  stage.scene.add(shadow.mesh)

  // ---- Physics ----
  const floorY = world.room.floor_y
  // Spawn and goal sit on the floor (use floor_y, never assume 0).
  const spawnFeet = new THREE.Vector3(world.spawn[0], floorY, world.spawn[2])
  const goal = new THREE.Vector3(world.goal[0], floorY, world.goal[2])
  const { physics, isWall } = buildPhysicsWorld(world, scanMesh ? extractTriangles(scanMesh) : undefined)

  // Stand on whatever is really there: the scan's floor is not exactly at world.json's floor_y (and may be a rug or a step).
  function groundAt(x: number, z: number, fallbackY: number): number {
    const reach = Math.max(CHARACTER.height * 3, 0.6)
    const hit = physics.castRay(new RAPIER.Ray({ x, y: fallbackY + reach, z }, { x: 0, y: -1, z: 0 }), reach * 2, true)
    return hit ? fallbackY + reach - hit.timeOfImpact : fallbackY
  }
  spawnFeet.y = groundAt(spawnFeet.x, spawnFeet.z, spawnFeet.y)
  goal.y = groundAt(goal.x, goal.z, goal.y)
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
  const hint = el('p', 'hud-hint', 'WASD / arrows move · Space jump (hold to fly) · E use item · click the view, then move the mouse to look around (Esc lets go)')
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
  let facing = 0 // which way the character faces (radians around y); set properly when the race (or the goal) is known
  let accumulator = 0
  const prevCentre = new THREE.Vector3()
  const currCentre = new THREE.Vector3()
  const drawFeet = new THREE.Vector3()

  function readCentre(out: THREE.Vector3): THREE.Vector3 {
    const t = character.body.translation()
    return out.set(t.x, t.y, t.z)
  }

  // Wings may not take you through the ceiling: stop a little below it (the scan's room is only as tall as its bounds say).
  const flyCeiling = world.room.bounds.max[1] - CHARACTER.height * 0.5

  // ---- The race ----
  let graph: Graph | null = null
  let race: { game: Game; scene: GameScene } | null = null
  let raceHud: RaceHud | null = null
  let sceneTime = 0
  let nextSeed = 1 + Math.floor(Math.random() * 1_000_000)
  let endShown = false
  const knock = { x: 0, z: 0, t: 0 } // a short shove away from a hazard that hit you
  const bestKey = `roomworld.best.${world.source_scan}`

  /** The map of where the character can stand on this scan (built once; the room never changes). */
  function getGraph(): Graph {
    if (graph) return graph
    const { min, max } = world.room.bounds
    const jumpHeight = MOVE.jumpSpeed ** 2 / (2 * MOVE.gravity)
    let cell = Math.max(0.08, CHARACTER.radius * 1.6)
    const area = (max[0] - min[0]) * (max[2] - min[2])
    while (area / (cell * cell) > 20000) cell *= 1.25 // a big room gets a coarser map, to stay quick
    graph = buildGraph(createProbe(physics, max[1] + 0.2, CHARACTER.height, character.collider), {
      min, max, cell, margin: CHARACTER.radius * 1.2, stepUp: CHARACTER.stepHeight, jumpUp: jumpHeight * 0.85,
    })
    return graph
  }

  function readBest(): number | null {
    try {
      const value = Number(localStorage.getItem(bestKey))
      return Number.isFinite(value) && value > 0 ? value : null
    } catch {
      return null
    }
  }

  /** Plan a new course and start the countdown. Leaves `race` null if this room is too small or cluttered to race in. */
  function startRace(): void {
    race?.scene.dispose()
    race = null
    endShown = false
    raceHud?.hideEnd()
    if (CLASSIC) return
    const seed = nextSeed++
    const course = generateCourse(getGraph(), [spawnFeet.x, spawnFeet.y, spawnFeet.z], {
      seed, checkpoints: 4, hazards: 2, unit: CHARACTER.height, runSpeed: MOVE.runSpeed, elevatedMin: CHARACTER.height * 0.5,
    })
    if (!course) return
    const game = new Game(course, { unit: CHARACTER.height, runSpeed: MOVE.runSpeed, seed })
    const scene = createGameScene(game, CHARACTER.height, scanMesh !== null)
    stage.scene.add(scene.group)
    race = { game, scene }
    sceneTime = 0
    stage.scene.traverse((obj) => {
      if (obj.name === GOAL_MARKER) obj.visible = false // the moving flag replaces the fixed goal pole
    })
    raceHud ??= createRaceHud(hud, timer, () => useItem())
    raceHud.banner(`${course.checkpoints.length} gates, then catch the flag ${TUNING.tagsNeeded} times!`, 'info')
  }

  function useItem(): void {
    if (race) handleEvents(race.game.useItem())
  }

  function handleEvents(events: GameEvent[]): void {
    const game = race?.game
    if (!raceHud || !game) return
    for (const e of events) {
      switch (e.type) {
        case 'go': raceHud.banner('GO!', 'good'); break
        case 'checkpoint': raceHud.banner(`Gate ${e.index} of ${e.total}!  +${e.bonus}s`, 'good'); break
        case 'flagUnlocked': raceHud.banner('All gates passed: now catch the flag!', 'good'); break
        case 'flagLocked': raceHud.banner('Pass all the gates first!', 'info'); break
        case 'item': raceHud.banner(`Got ${ITEM_INFO[e.kind].name}!  ${ITEM_INFO[e.kind].blurb}`, 'good'); break
        case 'itemFull': raceHud.banner('Your hands are full: use your item (E)', 'info'); break
        case 'use': raceHud.banner(`${ITEM_INFO[e.kind].name}!`, 'good'); break
        case 'hit':
          raceHud.banner(e.blocked ? 'Your shield saved you!' : `Ouch! Lost a life: ${game.lives} left`, e.blocked ? 'good' : 'bad')
          knock.x = e.dirX
          knock.z = e.dirZ
          knock.t = KNOCKBACK_SECONDS
          break
        case 'life':
          if (e.reason === 'heart') raceHud.banner(`Extra life! ${e.lives} lives`, 'good')
          break
        case 'livesFull': raceHud.banner('You already have all your lives', 'info'); break
        case 'flagTired': raceHud.banner('The flag is tired: now!', 'info'); break
        case 'tag': if (e.n < e.of) raceHud.banner(`Caught it! ${e.n} of ${e.of}  +${TUNING.tagBonus}s  It runs faster now...`, 'good'); break
        default: break
      }
    }
  }

  function showRaceEnd(game: Game): void {
    if (!raceHud) return
    const gates = game.course.checkpoints.length
    const lines: string[] = []
    if (game.phase === 'won') {
      const best = readBest()
      const left = Math.round(game.timeLeft * 10) / 10
      lines.push(`${left} seconds to spare`, `Hits taken: ${game.hits}`)
      if (best === null || left > best) {
        lines.push('New best!')
        try {
          localStorage.setItem(bestKey, String(left))
        } catch {
          // storage blocked: the best just is not remembered
        }
      } else {
        lines.push(`Best: ${best} seconds to spare`)
      }
    } else {
      lines.push(`You passed ${game.cpIndex} of ${gates} gates and caught the flag ${game.tags} of ${TUNING.tagsNeeded} times.`, `Lives left: ${game.lives}`)
    }
    input.releaseMouse() // so the buttons on the end screen can be clicked
    raceHud.showEnd({ title: game.phase === 'won' ? 'You caught the flag!' : game.lives === 0 ? 'Out of lives!' : "Time's up!", lines, onRestart: restartRun, onBack })
    endShown = true
  }

  /** Where the character should be facing at the start: towards the first gate, or the goal. */
  function facingStart(): number {
    const target = race ? race.game.course.checkpoints[0].pos : ([goal.x, 0, goal.z] as Vec3)
    return Math.atan2(target[0] - spawnFeet.x, target[2] - spawnFeet.z)
  }

  function respawn(): void {
    const at = race ? race.game.respawnPoint() : ([spawnFeet.x, spawnFeet.y, spawnFeet.z] as Vec3)
    character.body.setTranslation({ x: at[0], y: at[1] + CHARACTER.height / 2, z: at[2] }, true)
    physics.step() // let the colliders catch up with the teleport
    motion = newMotionState()
    readCentre(prevCentre)
    readCentre(currCentre)
    model.position.set(at[0], at[1], at[2])
    cam.reset(new THREE.Vector3(at[0], at[1], at[2]), facing)
  }

  function restartRun(): void {
    finished = false
    elapsed = 0
    win.hidden = true
    startRace()
    facing = facingStart()
    knock.t = 0
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
    return Math.min(max, solid ? solid.timeOfImpact : max, wall ? wall.timeOfImpact + profile.cameraWallSlack : max)
  }

  let fpsFrames = 0
  let fpsTime = 0

  function frame(dt: number): void {
    const game = race?.game ?? null
    // What the player may do right now (the race can freeze you: countdown, stun, finished) and what power-ups are active.
    const mods = game ? game.modifiers() : { speedMult: 1, jumpSpeedMult: 1, flying: false, canMove: !finished }
    const pressedUse = input.takeUse()
    if (pressedUse) useItem()
    const move = mods.canMove ? input.move() : { x: 0, y: 0 }
    const jump = input.takeJump() && mods.canMove

    // Turn the stick/keys (relative to the camera) into a direction in the room.
    const yaw = cam.yaw()
    const fx = -Math.sin(yaw) // camera's forward, along the floor
    const fz = -Math.cos(yaw)
    const rx = Math.cos(yaw) // camera's right
    const rz = -Math.sin(yaw)
    const wantedSpeed = MOVE.runSpeed * mods.speedMult
    let wishX = (rx * move.x + fx * move.y) * wantedSpeed
    let wishZ = (rz * move.x + fz * move.y) * wantedSpeed
    const speed = Math.hypot(wishX, wishZ)
    if (knock.t > 0) {
      knock.t -= dt
      wishX += knock.x * MOVE.runSpeed * 1.5 // shoved away from the hazard that hit you
      wishZ += knock.z * MOVE.runSpeed * 1.5
    }
    const modifiers = { jumpSpeedMult: mods.jumpSpeedMult, flying: mods.flying, flyUp: mods.flying && mods.canMove && input.jumpHeld(), flyCeiling: flyCeiling }

    // Fixed-rate physics: run as many 1/60 s steps as real time has passed.
    accumulator += dt
    let steps = 0
    let jumpThisFrame = jump
    while (accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
      prevCentre.copy(currCentre)
      stepCharacter(physics, character, motion, wishX, wishZ, jumpThisFrame, modifiers)
      jumpThisFrame = false
      readCentre(currCentre)
      accumulator -= FIXED_DT
      steps++
      if (!finished && !game) elapsed += FIXED_DT
    }
    if (steps === MAX_STEPS_PER_FRAME) accumulator = 0
    if (jumpThisFrame) motion.jumpQueued = MOVE.jumpBuffer // pressed between steps: remember it

    // Draw the character between the last two physics steps, so it moves smoothly at 120 Hz too.
    const alpha = accumulator / FIXED_DT
    drawFeet.lerpVectors(prevCentre, currCentre, alpha)
    drawFeet.y -= CHARACTER.height / 2
    model.position.copy(drawFeet)
    shadow.update(physics, drawFeet, CHARACTER.height, character.collider)
    if (speed > 0.1) {
      const wanted = Math.atan2(wishX, wishZ)
      facing += angleDiff(facing, wanted) * Math.min(1, 15 * dt)
    }
    model.rotation.y = facing

    // Swing the camera behind only when running away from it (not when running towards it).
    const runningAway = speed > 0.1 ? Math.max(0, move.y) * (speed / wantedSpeed) + Math.abs(move.x) * 0.5 : 0
    cam.setAutoSwing(!input.isMouseLooking()) // the mouse is in charge of the view while it is captured
    cam.update(dt, drawFeet, facing, runningAway, input.takeLook(), clearDistance)

    const feetY = currCentre.y - CHARACTER.height / 2
    // Fell out of the world (off the edge of the scan)? No penalty: back to the last gate.
    if (feetY < floorY - FALL_LIMIT) respawn()
    if (game && race && raceHud) {
      // The race: tell the rules where the player is, and show what happened.
      handleEvents(game.update(dt, [currCentre.x, feetY, currCentre.z]))
      sceneTime += dt
      race.scene.update(game, drawFeet, sceneTime, stage.camera)
      raceHud.update(game)
      if ((game.phase === 'won' || game.phase === 'lost') && !endShown) showRaceEnd(game)
    } else {
      // The old game: reached the goal? (measured across the floor, and not from high above it)
      const across = Math.hypot(currCentre.x - goal.x, currCentre.z - goal.z)
      if (!finished && across < profile.goalRadius && Math.abs(feetY - goal.y) < profile.goalHeightSlack) {
        finished = true
        winTime.textContent = `Time: ${elapsed.toFixed(1)} seconds`
        win.hidden = false
        restart.focus({ preventScroll: true })
      }
      timer.textContent = `${elapsed.toFixed(1)} s`
    }

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

  startRace()
  facing = facingStart()
  respawn()
  if (DEBUG) {
    // For tests: look at the race and move the player around.
    ;(window as unknown as Record<string, unknown>).__rw = {
      game: () => race?.game ?? null,
      teleport: (x: number, y: number, z: number) => {
        character.body.setTranslation({ x, y: y + CHARACTER.height / 2, z }, true)
        physics.step()
        readCentre(prevCentre)
        readCentre(currCentre)
      },
      profile: () => ({ unit: CHARACTER.height, runSpeed: MOVE.runSpeed }),
    }
  }
  stage.setLoop(frame)

  return {
    dispose: () => {
      stage.setLoop(null)
      input.dispose()
      raceHud?.dispose()
      race?.scene.dispose()
      if (DEBUG) delete (window as unknown as Record<string, unknown>).__rw
      container.removeEventListener('contextmenu', noMenu)
      hud.remove()
      stage.dispose() // frees the room, character and debug lines
      freePhysics(physics, character)
    },
  }
}
