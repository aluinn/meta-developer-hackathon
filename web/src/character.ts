// What the character looks like. Normally a flat picture that always faces the camera (the default bean, or one the player generated);
// if the picture cannot be loaded, simple original shapes. The object's origin is at the FEET, whichever it is.

import * as THREE from 'three'
import { characterPictureUrl, DEFAULT_CHARACTER_URL } from './characterStore.ts'
import { CHARACTER } from './physics.ts'

/** The drawing has some empty margin above the head and below the feet, so it is drawn a bit taller than the physics capsule. */
const PICTURE_FILL = 0.78 // how much of the picture's height the figure itself fills
const FEET_AT = 0.12 // the feet are this far up from the bottom edge of the picture

function loadTexture(url: string): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => new THREE.TextureLoader().load(url, resolve, undefined, () => reject(new Error(`could not load ${url}`))))
}

function createPictureCharacter(texture: THREE.Texture): THREE.Sprite {
  texture.colorSpace = THREE.SRGBColorSpace
  const image = texture.image as { width: number; height: number }
  const height = CHARACTER.height / PICTURE_FILL
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, alphaTest: 0.05 }))
  sprite.scale.set(height * (image.width / image.height), height, 1)
  sprite.center.set(0.5, FEET_AT)
  sprite.name = 'character'
  return sprite
}

/** The player's character picture, else the default bean, else (if no picture loads) the simple capsule. */
export async function createCharacter(): Promise<THREE.Object3D> {
  for (const url of [characterPictureUrl(), DEFAULT_CHARACTER_URL]) {
    try {
      return createPictureCharacter(await loadTexture(url))
    } catch {
      // try the next one
    }
  }
  return createCharacterModel()
}

/** Simple original shapes, drawn at one size and scaled to the current character. */
export function createCharacterModel(): THREE.Group {
  const height = 1.6
  const radius = 0.25
  const group = new THREE.Group()
  group.name = 'character'

  const suit = new THREE.MeshStandardMaterial({ color: 0x7048e8 })
  const dark = new THREE.MeshStandardMaterial({ color: 0x2b2250 })

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(radius, height - radius * 2, 6, 16), suit)
  body.position.y = height / 2

  // A dark visor on the front, so you can see which way it is facing.
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.12, 0.12), dark)
  visor.position.set(0, height - 0.28, radius - 0.03)

  // A small backpack on the back.
  const pack = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.4, 0.14), dark)
  pack.position.set(0, height * 0.6, -radius - 0.02)

  group.add(body, visor, pack)
  group.scale.setScalar(CHARACTER.height / height) // same size as the physics capsule, so what you see is what collides
  return group
}
