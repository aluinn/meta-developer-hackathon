// Loads the scanned room (a .glb the server keeps) so the 3D view and play mode can show the REAL room, not just boxes.
// The scan and world.json share coordinates (metres, y up), so it drops in at the origin with no moving or scaling.

import * as THREE from 'three'
import type { World } from './world.ts'

const SCAN_ID = /^([0-9a-f]{32})\//
const BUILT_IN_SCAN = /^examples\/[a-z0-9-]+\/scan\.glb$/ // a scan that ships with the website (web/public/examples/...)

/** Where this world's scan is: on the server (uploaded), or a file that ships with the website; null for the made-up example rooms. */
export function scanMeshUrl(world: World): string | null {
  if (BUILT_IN_SCAN.test(world.source_scan)) return `/${world.source_scan}`
  const match = SCAN_ID.exec(world.source_scan)
  return match ? `/scan/${match[1]}/mesh` : null
}

// Download each scan once (the 3D view and play mode both want it); every user gets its own parsed copy, so freeing one never breaks the other.
const downloads = new Map<string, Promise<ArrayBuffer>>()
function download(url: string): Promise<ArrayBuffer> {
  let pending = downloads.get(url)
  if (!pending) {
    pending = fetch(url).then((res) => {
      if (!res.ok) throw new Error(`The scan could not be downloaded (${res.status}).`)
      return res.arrayBuffer()
    })
    pending.catch(() => downloads.delete(url)) // do not remember a failure
    downloads.set(url, pending)
  }
  return pending
}

/** A scan shows best unlit: its colours are the photo colours, so lights and shadows would only darken and muddy it. */
function toUnlit(material: THREE.Material, hasVertexColors: boolean): THREE.Material {
  const old = material as THREE.MeshStandardMaterial
  const unlit = new THREE.MeshBasicMaterial({
    map: old.map ?? null,
    color: old.map || hasVertexColors ? 0xffffff : old.color, // a texture or vertex colours already carry the colour
    vertexColors: hasVertexColors,
    side: THREE.FrontSide, // see-through from outside: you can look into the room from above and walk around its walls
  })
  old.dispose() // the texture moves to the new material; only the old shell is freed
  return unlit
}

export async function loadScanMesh(url: string): Promise<THREE.Object3D> {
  const bytes = await download(url)
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js') // only fetched when there is a scan to show
  const gltf = await new GLTFLoader().parseAsync(bytes.slice(0), '')
  gltf.scene.name = 'scan-mesh'
  gltf.scene.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      const hasVertexColors = obj.geometry.getAttribute('color') !== undefined
      obj.material = Array.isArray(obj.material)
        ? obj.material.map((m: THREE.Material) => toUnlit(m, hasVertexColors))
        : toUnlit(obj.material as THREE.Material, hasVertexColors)
    }
  })
  return gltf.scene
}
