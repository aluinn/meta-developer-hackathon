// The 3D viewer: renderer, camera, mouse/touch controls and the render loop.
// It knows nothing about screens or buttons, so play mode (Z3) can reuse it.

import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { disposeChildren } from './dispose.ts'
import { buildRoom } from './roomScene.ts'
import type { World } from './world.ts'

export interface Viewer {
  /** Replace the room being shown. The old one is freed and the camera is re-aimed. */
  setWorld: (world: World) => void
  /** HOOK for later: load the scan mesh (.glb) to sit underneath the boxes. Not built yet. */
  loadScanMesh: (url: string) => Promise<void>
  /** Stop everything and free the graphics memory. Call this when leaving the screen. */
  dispose: () => void
}

export function createViewer(container: HTMLElement, initialWorld: World): Viewer {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)) // 3x phone screens: 2x is plenty
  renderer.domElement.className = 'view-canvas'
  container.prepend(renderer.domElement)

  const scene = new THREE.Scene()
  scene.add(new THREE.HemisphereLight(0xffffff, 0x667085, 1.6))
  const sun = new THREE.DirectionalLight(0xffffff, 1.4)
  sun.position.set(3, 8, 5)
  scene.add(sun)

  // Layers, bottom to top. The scan mesh layer is empty until the hook below is built.
  const scanLayer = new THREE.Group()
  scanLayer.name = 'scan-mesh-layer'
  const roomLayer = new THREE.Group()
  roomLayer.name = 'room-layer'
  scene.add(scanLayer, roomLayer)

  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200)
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.screenSpacePanning = true
  controls.maxPolarAngle = Math.PI * 0.495 // can't go under the floor
  // One finger rotates; two fingers pinch to zoom and drag to pan. Mouse: left rotate, wheel zoom, right pan.
  controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN }

  // Stop Safari treating a two-finger pinch on the view as a page zoom.
  const blockGesture = (e: Event) => e.preventDefault()
  container.addEventListener('gesturestart', blockGesture)

  function resize(): void {
    const width = container.clientWidth
    const height = container.clientHeight
    if (width === 0 || height === 0) return
    renderer.setSize(width, height, false) // false: our CSS sets the canvas size
    camera.aspect = width / height
    camera.updateProjectionMatrix()
  }

  /** Point the camera at the whole room from a raised corner, close enough to fill the view. */
  function frameRoom(world: World): void {
    const { min, max } = world.room.bounds
    const box = new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max))
    const centre = box.getCenter(new THREE.Vector3())
    const radius = box.getSize(new THREE.Vector3()).length() / 2

    // Use whichever field of view is narrower (tall phone screens are narrow sideways).
    const vFov = THREE.MathUtils.degToRad(camera.fov)
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect)
    const distance = (radius / Math.sin(Math.min(vFov, hFov) / 2)) * 0.8

    camera.position.copy(centre).addScaledVector(new THREE.Vector3(0.55, 0.75, 1).normalize(), distance)
    controls.target.copy(centre)
    controls.minDistance = 0.5
    controls.maxDistance = distance * 3
    controls.update()
  }

  function setWorld(world: World): void {
    disposeChildren(roomLayer)
    roomLayer.add(buildRoom(world))
    frameRoom(world)
  }

  // Resize whenever the container changes size: window resize, phone rotation, etc.
  const resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(container)
  resize()
  setWorld(initialWorld)

  renderer.setAnimationLoop(() => {
    controls.update() // needed for the smooth "glide" after you let go
    renderer.render(scene, camera)
  })

  return {
    setWorld,
    loadScanMesh: async (_url: string): Promise<void> => {
      // TODO (later task): load a .glb with GLTFLoader and add it to `scanLayer`.
    },
    dispose: () => {
      renderer.setAnimationLoop(null)
      resizeObserver.disconnect()
      container.removeEventListener('gesturestart', blockGesture)
      controls.dispose()
      disposeChildren(roomLayer)
      disposeChildren(scanLayer)
      renderer.dispose()
      renderer.forceContextLoss()
      renderer.domElement.remove()
    },
  }
}
