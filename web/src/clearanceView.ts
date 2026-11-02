// Draws a clearance check result (clearance.ts) in the 3D view: the floor the person can reach (lightly shaded), the route
// (green), the narrowest gap (amber) or where it's blocked (red), and a simple capsule "person" walking the route on a loop.
// Everything sits in one group inside the viewer's overlay, so it is easy to replace and to free.

import * as THREE from 'three'
import type { ClearanceResult, FloorPoint } from './clearance.ts'
import { createLabelSprite } from './labelSprite.ts'
import type { Viewer } from './viewer.ts'
import type { World } from './world.ts'

const COLOURS = {
  route: 0x69db7c, // light green: brighter than the green "climbable" boxes, so the two don't get mixed up
  reach: [21, 170, 191] as const, // teal shading for the floor the person can reach
  narrowest: 0xf59f00,
  blocked: 0xe03131,
  person: 0x7048e8,
}
const PERSON_HEIGHT = 1.7 // metres
const WALK_SPEED = 1.0 // metres per second: a calm walk, easy to follow
const PAUSE_AT_GOAL = 1.2 // seconds, before starting again
// Heights above the floor, so things lying on it don't flicker against it (a rug is 2 cm thick).
const SHADE_LIFT = 0.025
const ROUTE_LIFT = 0.04

export interface ClearanceView {
  /** Draw this result (replacing the last one). */
  show: (result: ClearanceResult, world: World) => void
  /** Hide or show everything (e.g. when the Layout tab is closed). */
  setVisible: (visible: boolean) => void
  /** Stop or restart the person walking. */
  setPaused: (paused: boolean) => void
  /** Remove everything from the 3D view and free it. */
  dispose: () => void
}

/**
 * The materials (colours) are made once and reused for every result. Throwing them away each time would make three.js
 * rebuild its drawing programs ("shaders") on the next frame, which made dragging the width slider jerky.
 */
function createMaterials() {
  const overlay = { side: THREE.DoubleSide, depthTest: false, depthWrite: false } // drawn on top, like the Start and Goal markers
  return {
    shading: new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }),
    route: new THREE.MeshBasicMaterial({ color: COLOURS.route, ...overlay }),
    narrowest: new THREE.MeshBasicMaterial({ color: COLOURS.narrowest, ...overlay }),
    blocked: new THREE.MeshBasicMaterial({ color: COLOURS.blocked, ...overlay }),
    person: new THREE.MeshStandardMaterial({ color: COLOURS.person, roughness: 0.6 }),
  }
}
type Materials = ReturnType<typeof createMaterials>

/** The floor the person can reach, as a see-through picture laid on the floor (one pixel per grid cell). */
function buildShading(result: ClearanceResult, material: THREE.MeshBasicMaterial): THREE.Mesh {
  const { nx, nz, cellM, minX, minZ, floorY } = result.gridInfo
  const pixels = new Uint8Array(nx * nz * 4)
  const [r, g, b] = COLOURS.reach
  for (let j = 0; j < nz; j++) {
    // The picture's first row is at the far (max z) edge once the plane is laid flat, so rows run backwards.
    const row = nz - 1 - j
    for (let i = 0; i < nx; i++) {
      if (!result.reachableArea[i + j * nx]) continue
      const p = (i + row * nx) * 4
      pixels[p] = r
      pixels[p + 1] = g
      pixels[p + 2] = b
      pixels[p + 3] = 80 // about 30% see-through colour
    }
  }
  const texture = new THREE.DataTexture(pixels, nx, nz, THREE.RGBAFormat)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.magFilter = THREE.LinearFilter // soft edges instead of visible squares
  texture.needsUpdate = true

  const geometry = new THREE.PlaneGeometry(nx * cellM, nz * cellM)
  geometry.rotateX(-Math.PI / 2) // planes start upright; lay it flat
  material.map?.dispose() // the last result's picture
  material.map = texture
  const mesh = new THREE.Mesh(geometry, material)
  mesh.position.set(minX + (nx * cellM) / 2, floorY + SHADE_LIFT, minZ + (nz * cellM) / 2)
  mesh.name = 'clearance-reach'
  return mesh
}

/** A flat ribbon along the route, with round joints, lying on the floor. */
function buildRoute(path: FloorPoint[], floorY: number, material: THREE.Material): THREE.Mesh {
  const half = 0.05 // the ribbon is 10 cm wide
  const positions: number[] = []
  const triangle = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number) =>
    positions.push(ax, 0, az, bx, 0, bz, cx, 0, cz)
  for (let k = 1; k < path.length; k++) {
    const a = path[k - 1]
    const b = path[k]
    const length = Math.hypot(b.x - a.x, b.z - a.z)
    if (length === 0) continue
    const sx = (-(b.z - a.z) / length) * half // sideways, half the ribbon's width
    const sz = ((b.x - a.x) / length) * half
    triangle(a.x + sx, a.z + sz, b.x + sx, b.z + sz, b.x - sx, b.z - sz)
    triangle(a.x + sx, a.z + sz, b.x - sx, b.z - sz, a.x - sx, a.z - sz)
  }
  for (const p of path) {
    const sides = 12
    for (let s = 0; s < sides; s++) {
      const t0 = (s / sides) * Math.PI * 2
      const t1 = ((s + 1) / sides) * Math.PI * 2
      triangle(p.x, p.z, p.x + Math.cos(t0) * half, p.z + Math.sin(t0) * half, p.x + Math.cos(t1) * half, p.z + Math.sin(t1) * half)
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  const mesh = new THREE.Mesh(geometry, material) // drawn on top of everything, so furniture never hides the route
  mesh.position.y = floorY + ROUTE_LIFT
  mesh.renderOrder = 4
  mesh.name = 'clearance-route'
  return mesh
}

/** A ring on the floor with a short pole and a label above it. */
function buildPin(at: FloorPoint, floorY: number, material: THREE.Material, text: string): THREE.Group {
  const group = new THREE.Group()
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.12, 0.2, 32), material)
  ring.rotation.x = -Math.PI / 2
  ring.position.y = ROUTE_LIFT + 0.005
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.9, 8), material)
  pole.position.y = 0.45
  for (const part of [ring, pole]) part.renderOrder = 5
  const label = createLabelSprite(text, 0.2)
  label.position.y = 1.1
  group.add(ring, pole, label)
  group.position.set(at.x, floorY, at.z)
  return group
}

/** The simple "person": a capsule as wide as the chosen width and about 1.7 m tall. Its origin is at the feet. */
function buildPerson(widthM: number, material: THREE.Material): THREE.Mesh {
  const radius = widthM / 2
  const middle = Math.max(0, PERSON_HEIGHT - widthM) // the straight part between the two round ends
  const geometry = new THREE.CapsuleGeometry(radius, middle, 6, 20)
  geometry.translate(0, PERSON_HEIGHT / 2, 0)
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'clearance-person'
  return mesh
}

function blockedLabel(result: ClearanceResult): string {
  const b = result.blockedAt
  if (!b) return ''
  if (b.reason === 'gap') return `Blocked: ${b.gapCm} cm gap`
  if (b.reason === 'start') return 'No room to start'
  if (b.reason === 'goal') return 'No room at the goal'
  return 'Closest it gets'
}

export function createClearanceView(viewer: Pick<Viewer, 'overlay' | 'onFrame'>): ClearanceView {
  const root = new THREE.Group()
  root.name = 'clearance'
  viewer.overlay.add(root)
  const materials: Materials = createMaterials()

  /** Remove the last result's shapes and labels, keeping the shared materials. */
  function clear(): void {
    root.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose()
      if (o instanceof THREE.Sprite) {
        o.material.map?.dispose() // a label's own picture and material
        o.material.dispose()
      }
    })
    root.clear()
  }

  // The walk: where the person is along the route, in metres from the start.
  let route: FloorPoint[] = []
  let legs: number[] = [] // distance from the start to each route point
  let floorY = 0
  let person: THREE.Mesh | null = null
  let walked = 0
  let waiting = 0
  let paused = false

  function placePerson(): void {
    if (!person || route.length === 0) return
    let k = 1
    while (k < route.length - 1 && legs[k] < walked) k++
    const a = route[k - 1] ?? route[0]
    const b = route[k] ?? route[0]
    const span = legs[k] - legs[k - 1]
    const t = span > 0 ? Math.min(1, Math.max(0, (walked - legs[k - 1]) / span)) : 0
    person.position.set(a.x + (b.x - a.x) * t, floorY, a.z + (b.z - a.z) * t)
  }

  const stopFrames = viewer.onFrame((dt) => {
    if (paused || !root.visible || route.length < 2) return
    const total = legs[legs.length - 1]
    if (walked >= total) {
      waiting += dt
      if (waiting < PAUSE_AT_GOAL) return
      walked = 0
      waiting = 0
    } else {
      walked = Math.min(total, walked + WALK_SPEED * dt)
    }
    placePerson()
  })

  function show(result: ClearanceResult, world: World): void {
    clear()
    floorY = world.room.floor_y
    root.add(buildShading(result, materials.shading))
    if (result.reachable) {
      root.add(buildRoute(result.path, floorY, materials.route))
      if (result.narrowestAt && result.narrowestGapCm !== null) {
        root.add(buildPin(result.narrowestAt, floorY, materials.narrowest, `Narrowest: ${result.narrowestGapCm} cm`))
      }
    } else if (result.blockedAt) {
      root.add(buildPin(result.blockedAt.at, floorY, materials.blocked, blockedLabel(result)))
    }

    // The person walks the route; with no route, they stand at the start.
    const startAt = result.snapped.start?.to ?? { x: world.spawn[0], z: world.spawn[2] }
    route = result.reachable ? result.path : [startAt]
    legs = [0]
    for (let k = 1; k < route.length; k++) {
      legs.push(legs[k - 1] + Math.hypot(route[k].x - route[k - 1].x, route[k].z - route[k - 1].z))
    }
    walked = 0
    waiting = 0
    person = buildPerson(result.personWidthM, materials.person)
    root.add(person)
    placePerson()
  }

  return {
    show,
    setVisible: (visible) => {
      root.visible = visible
    },
    setPaused: (p) => {
      paused = p
    },
    dispose: () => {
      stopFrames()
      clear()
      materials.shading.map?.dispose()
      for (const m of Object.values(materials)) m.dispose()
      root.removeFromParent()
    },
  }
}
