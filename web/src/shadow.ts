// A soft round shadow on whatever is under the character. It shows exactly where you will land,
// which is the main thing missing when a flat picture moves around a 3D room.

import RAPIER from '@dimforge/rapier3d-compat'
import * as THREE from 'three'

const REACH = 3 // metres below the feet that we look for something to cast the shadow on
const LIFT = 0.004 // sit just above the surface so it does not flicker into it

export interface BlobShadow {
  mesh: THREE.Mesh
  /** Put the shadow under `feet`. `unit` is the character's height: the shadow fades and widens as you rise above that many units. */
  update: (physics: RAPIER.World, feet: THREE.Vector3, unit: number, exclude: RAPIER.Collider) => void
}

export function createBlobShadow(radius: number): BlobShadow {
  const material = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
  const mesh = new THREE.Mesh(new THREE.CircleGeometry(1, 24), material) // a circle facing +z; turned to lie on the surface below
  mesh.name = 'blob-shadow'
  mesh.renderOrder = 2
  mesh.visible = false
  const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 })
  const from = new THREE.Vector3()
  const normal = new THREE.Vector3()
  const forward = new THREE.Vector3(0, 0, 1)
  return {
    mesh,
    update(physics, feet, unit, exclude) {
      ray.origin = { x: feet.x, y: feet.y + unit * 0.15, z: feet.z }
      const hit = physics.castRayAndGetNormal(ray, unit * 0.15 + REACH, true, undefined, undefined, exclude)
      if (!hit) {
        mesh.visible = false
        return
      }
      const y = feet.y + unit * 0.15 - hit.timeOfImpact
      const height = Math.max(0, feet.y - y)
      normal.set(hit.normal.x, hit.normal.y, hit.normal.z)
      from.set(feet.x, y, feet.z).addScaledVector(normal, LIFT)
      mesh.position.copy(from)
      mesh.quaternion.setFromUnitVectors(forward, normal)
      const high = Math.min(1, height / (unit * 4)) // 0 on the ground .. 1 four heights up
      mesh.scale.setScalar(radius * (1 + high * 0.6))
      material.opacity = 0.5 * (1 - high * 0.65)
      mesh.visible = true
    },
  }
}
