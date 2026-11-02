// The "stage" both the 3D viewer and play mode draw on: renderer, lights, the room,
// a camera, resizing and the per-frame loop. Each mode adds its own camera control on top.

import * as THREE from 'three'
import { disposeChildren } from './dispose.ts'
import { buildRoom, setBoxStyle, type BoxStyle } from './roomScene.ts'
import type { World } from './world.ts'

export interface Stage {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  /** The <canvas> the room is drawn on; attach mouse/touch listeners here. */
  canvas: HTMLCanvasElement
  /** Empty group for the scan mesh (.glb) later; it sits underneath the boxes. */
  scanLayer: THREE.Group
  /** Draw this world's room (floor, walls, boxes, labels, markers), replacing the old one. */
  setRoom: (world: World) => void
  /** Draw the boxes solid, as faint overlays (the scan picture is showing), or not at all. Remembered across setRoom. */
  setBoxStyle: (style: BoxStyle) => void
  /** Run `fn` after every resize (window resize, phone rotation). */
  onResize: (fn: () => void) => void
  /** Call `update(seconds since last frame)` every frame, then draw. Pass null to stop. */
  setLoop: (update: ((dt: number) => void) | null) => void
  /** Stop the loop and free all graphics memory. */
  dispose: () => void
}

export function createStage(container: HTMLElement): Stage {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)) // 3x phone screens: 2x is plenty
  renderer.domElement.className = 'view-canvas'
  container.prepend(renderer.domElement)

  const scene = new THREE.Scene()
  scene.add(new THREE.HemisphereLight(0xffffff, 0x667085, 1.6))
  const sun = new THREE.DirectionalLight(0xffffff, 1.4)
  sun.position.set(3, 8, 5)
  scene.add(sun)

  // Layers, bottom to top.
  const scanLayer = new THREE.Group()
  scanLayer.name = 'scan-mesh-layer'
  const roomLayer = new THREE.Group()
  roomLayer.name = 'room-layer'
  scene.add(scanLayer, roomLayer)

  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200)
  let boxStyle: BoxStyle = 'boxes'

  // Stop Safari treating a two-finger pinch on the view as a page zoom.
  const blockGesture = (e: Event) => e.preventDefault()
  container.addEventListener('gesturestart', blockGesture)

  const resizeListeners: Array<() => void> = []
  function resize(): void {
    const width = container.clientWidth
    const height = container.clientHeight
    if (width === 0 || height === 0) return
    renderer.setSize(width, height, false) // false: our CSS sets the canvas size
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    for (const fn of resizeListeners) fn()
  }
  const resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(container)
  resize()

  let lastTime = 0
  function setLoop(update: ((dt: number) => void) | null): void {
    if (!update) {
      renderer.setAnimationLoop(null)
      return
    }
    lastTime = performance.now()
    renderer.setAnimationLoop((time: number) => {
      // Cap the gap: after switching tabs the browser pauses us, and a huge jump would break physics.
      const dt = Math.min((time - lastTime) / 1000, 0.1)
      lastTime = time
      update(dt)
      renderer.render(scene, camera)
    })
  }

  return {
    scene,
    camera,
    canvas: renderer.domElement,
    scanLayer,
    setRoom: (world) => {
      disposeChildren(roomLayer)
      roomLayer.add(buildRoom(world))
      setBoxStyle(roomLayer, boxStyle)
    },
    setBoxStyle: (style) => {
      boxStyle = style
      setBoxStyle(roomLayer, style)
    },
    onResize: (fn) => {
      resizeListeners.push(fn)
    },
    setLoop,
    dispose: () => {
      renderer.setAnimationLoop(null)
      resizeObserver.disconnect()
      container.removeEventListener('gesturestart', blockGesture)
      disposeChildren(scene)
      renderer.dispose()
      renderer.forceContextLoss()
      renderer.domElement.remove()
    },
  }
}
