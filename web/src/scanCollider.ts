// Turns the loaded scan (a three.js object) into plain triangle lists that Rapier can use as the ground the character runs on.

import * as THREE from 'three'

export interface ScanTriangles {
  vertices: Float32Array // x, y, z for each vertex, in room coordinates (metres, y up)
  indices: Uint32Array // three vertex numbers per triangle
}

/** Every triangle of every mesh in `root`, moved to where it is drawn (so it lines up with what you see). */
export function extractTriangles(root: THREE.Object3D): ScanTriangles {
  root.updateMatrixWorld(true)
  const vertices: number[] = []
  const indices: number[] = []
  const point = new THREE.Vector3()
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return
    const position = obj.geometry.getAttribute('position')
    if (!position) return
    const base = vertices.length / 3
    for (let i = 0; i < position.count; i++) {
      point.fromBufferAttribute(position, i).applyMatrix4(obj.matrixWorld)
      vertices.push(point.x, point.y, point.z)
    }
    const index = obj.geometry.index
    if (index) {
      for (let i = 0; i < index.count; i++) indices.push(base + index.getX(i))
    } else {
      for (let i = 0; i < position.count; i++) indices.push(base + i)
    }
  })
  return { vertices: new Float32Array(vertices), indices: new Uint32Array(indices) }
}
