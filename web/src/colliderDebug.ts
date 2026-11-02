// Debug view: draws Rapier's colliders as red lines so you can check they match the boxes.
// Off by default. Turn it on by adding ?colliders to the page address.

import type RAPIER from '@dimforge/rapier3d-compat'
import * as THREE from 'three'

export interface ColliderDebug {
  object: THREE.LineSegments
  update: () => void
}

export function createColliderDebug(physics: RAPIER.World): ColliderDebug {
  const geometry = new THREE.BufferGeometry()
  const material = new THREE.LineBasicMaterial({ color: 0xff2020 })
  const object = new THREE.LineSegments(geometry, material)
  object.name = 'collider-debug'
  object.frustumCulled = false // its size changes every frame
  object.renderOrder = 20
  return {
    object,
    update: () => {
      // Rapier gives a flat list of line end points: x, y, z, x, y, z, ...
      const { vertices } = physics.debugRender()
      geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3))
    },
  }
}
