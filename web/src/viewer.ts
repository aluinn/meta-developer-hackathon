// The normal 3D view: the stage (stage.ts) plus OrbitControls so you can look around.
// It knows nothing about screens or buttons.

import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { loadScanMesh as loadScan } from './scanMesh.ts'
import { createStage } from './stage.ts'
import type { World } from './world.ts'

export interface Viewer {
  /** Replace the room being shown. The old one is freed and the camera is re-aimed. */
  setWorld: (world: World) => void
  /** Load the scanned room (.glb) into the scan layer and turn the boxes into faint overlays on top of it. */
  loadScanMesh: (url: string) => Promise<void>
  /** An empty group drawn with the room, for extras like the clearance check's route. Kept when the room changes. */
  overlay: THREE.Group
  /** Call `fn(seconds since last frame)` every frame. Returns a function that stops it. */
  onFrame: (fn: (dt: number) => void) => () => void
  /** Stop everything and free the graphics memory. Call this when leaving the screen. */
  dispose: () => void
}

export function createViewer(container: HTMLElement, initialWorld: World): Viewer {
  const stage = createStage(container)
  const camera = stage.camera
  const controls = new OrbitControls(camera, stage.canvas)
  controls.enableDamping = true
  controls.screenSpacePanning = true
  controls.maxPolarAngle = Math.PI * 0.495 // can't go under the floor
  // One finger rotates; two fingers pinch to zoom and drag to pan. Mouse: left rotate, wheel zoom, right pan.
  controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN }

  // If you haven't moved the camera yourself, re-fit the room when the screen shape changes
  // (e.g. rotating the phone). Once you've started orbiting, we leave your view alone.
  let currentWorld = initialWorld
  let userMovedCamera = false
  controls.addEventListener('start', () => {
    userMovedCamera = true
  })
  stage.onResize(() => {
    if (!userMovedCamera) frameRoom(currentWorld)
  })

  /** Point the camera at the whole room from a raised corner, pulled back until every corner is on screen. */
  function frameRoom(world: World): void {
    const { min, max } = world.room.bounds
    const box = new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max))
    const centre = box.getCenter(new THREE.Vector3())
    const radius = box.getSize(new THREE.Vector3()).length() / 2
    const direction = new THREE.Vector3(0.55, 0.75, 1).normalize()

    const corners: THREE.Vector3[] = []
    for (const x of [min[0], max[0]]) {
      for (const y of [min[1], max[1]]) {
        for (const z of [min[2], max[2]]) corners.push(new THREE.Vector3(x, y, z))
      }
    }
    const allOnScreen = (): boolean =>
      corners.every((c) => {
        const p = c.clone().project(camera) // -1..1 across the screen
        return Math.abs(p.x) < 0.9 && Math.abs(p.y) < 0.9
      })

    // Start close and step back 8% at a time. Works for wide laptop windows and tall phones alike.
    let distance = radius * 0.5
    for (let i = 0; i < 80; i++) {
      camera.position.copy(centre).addScaledVector(direction, distance)
      camera.lookAt(centre)
      camera.updateMatrixWorld()
      if (allOnScreen()) break
      distance *= 1.08
    }

    controls.target.copy(centre)
    controls.minDistance = 0.5
    controls.maxDistance = distance * 3
    controls.update()
  }

  function setWorld(world: World): void {
    currentWorld = world
    userMovedCamera = false
    stage.setRoom(world)
    frameRoom(world)
  }

  setWorld(initialWorld)
  const overlay = new THREE.Group()
  overlay.name = 'overlay'
  stage.scene.add(overlay)
  const frameListeners = new Set<(dt: number) => void>()
  stage.setLoop((dt) => {
    controls.update() // gives the smooth "glide" after you let go
    for (const fn of frameListeners) fn(dt)
  })

  let disposed = false
  return {
    setWorld,
    overlay,
    onFrame: (fn) => {
      frameListeners.add(fn)
      return () => frameListeners.delete(fn)
    },
    loadScanMesh: async (url: string): Promise<void> => {
      const mesh = await loadScan(url)
      if (disposed) return // you left the screen while it was downloading
      stage.scanLayer.add(mesh)
      stage.setBoxStyle('overlay')
    },
    dispose: () => {
      disposed = true
      controls.dispose()
      stage.dispose()
    },
  }
}
