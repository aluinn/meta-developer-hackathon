// three.js keeps shapes, materials and textures in graphics memory (the GPU).
// The browser does not free that for us, so we do it by hand when we are done.

import * as THREE from 'three'

function disposeMaterial(material: THREE.Material | THREE.Material[]): void {
  for (const m of Array.isArray(material) ? material : [material]) {
    if ('map' in m && m.map instanceof THREE.Texture) m.map.dispose()
    m.dispose()
  }
}

/** Free everything inside `root` (but not `root` itself). */
export function disposeChildren(root: THREE.Object3D): void {
  root.traverse((obj) => {
    // A Sprite's shape is shared by all sprites, so only its material is ours.
    if (obj instanceof THREE.Sprite) {
      disposeMaterial(obj.material)
    } else if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
      obj.geometry.dispose()
      disposeMaterial(obj.material)
    }
  })
  root.clear()
}
