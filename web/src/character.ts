// What the character looks like: simple original shapes, no downloaded models.
// The group's origin is at the FEET, and the character faces +z (its visor is on the front).

import * as THREE from 'three'
import { CHARACTER } from './physics.ts'

export function createCharacterModel(): THREE.Group {
  const { height, radius } = CHARACTER
  const group = new THREE.Group()
  group.name = 'character'

  const suit = new THREE.MeshStandardMaterial({ color: 0x7048e8 })
  const dark = new THREE.MeshStandardMaterial({ color: 0x2b2250 })

  // Same size as the physics capsule, so what you see is what collides.
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(radius, height - radius * 2, 6, 16), suit)
  body.position.y = height / 2

  // A dark visor on the front, so you can see which way it is facing.
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.12, 0.12), dark)
  visor.position.set(0, height - 0.28, radius - 0.03)

  // A small backpack on the back.
  const pack = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.4, 0.14), dark)
  pack.position.set(0, height * 0.6, -radius - 0.02)

  group.add(body, visor, pack)
  return group
}
