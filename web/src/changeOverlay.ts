// Marks the objects a proposed layout moves, in the 3D view: a bright outline where the object is in the view being shown,
// a faint outline where it is in the other one, and an arrow between the two. Lives in the viewer's overlay group.

import * as THREE from 'three'
import type { LayoutChange } from './api.ts'
import { disposeChildren } from './dispose.ts'
import type { Viewer } from './viewer.ts'
import type { World } from './world.ts'

const COLOUR = 0xe83e8c // pink: not used by any role colour
const LIFT = 0.03 // metres above an object's own bottom edge, so lines are not hidden inside surfaces

export interface ChangeOverlay {
  /**
   * Draw the changes. `showing` says which layout is on screen: its outline is solid, the other one's is faint.
   * `sizes` gives each object's size by id (the same in both layouts). An empty list clears the drawing.
   */
  show: (changes: LayoutChange[], sizes: World['objects'], showing: 'before' | 'after') => void
  /** Remove everything from the 3D view and free it. */
  dispose: () => void
}

export function createChangeOverlay(viewer: Pick<Viewer, 'overlay'>): ChangeOverlay {
  const group = new THREE.Group()
  group.name = 'layout-changes'
  viewer.overlay.add(group)
  const line = (opacity: number) => new THREE.LineBasicMaterial({ color: COLOUR, transparent: true, opacity, depthTest: false, depthWrite: false })
  const solid = line(1)
  const faint = line(0.4)
  const arrowMaterial = new THREE.MeshBasicMaterial({ color: COLOUR, depthTest: false, depthWrite: false })

  function outline(size: [number, number, number], at: [number, number, number], turn: number, material: THREE.LineBasicMaterial): THREE.LineSegments {
    const box = new THREE.BoxGeometry(size[0], size[1], size[2])
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box), material)
    box.dispose()
    edges.position.set(at[0], at[1], at[2])
    edges.rotation.y = turn
    edges.renderOrder = 20
    return edges
  }

  return {
    show(changes, objects, showing) {
      disposeChildren(group)
      for (const change of changes) {
        const object = objects.find((o) => o.id === change.id)
        if (!object) continue
        const now = showing === 'after' ? change.to : change.from
        const other = showing === 'after' ? change.from : change.to
        group.add(outline(object.size, now.position, now.rotation_y, solid), outline(object.size, other.position, other.rotation_y, faint))
        // An arrow along the floor from where it was to where it goes (always from -> to), drawn at the object's feet.
        const feet = object.position[1] - object.size[1] / 2 + LIFT
        const a = new THREE.Vector3(change.from.position[0], feet, change.from.position[2])
        const b = new THREE.Vector3(change.to.position[0], feet, change.to.position[2])
        const length = a.distanceTo(b)
        if (length < 0.02) continue
        const shaft = new THREE.BufferGeometry().setFromPoints([a, b])
        const arrow = new THREE.Line(shaft, solid)
        arrow.renderOrder = 20
        const head = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.2, 12), arrowMaterial)
        head.position.copy(b)
        head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize())
        head.renderOrder = 20
        group.add(arrow, head)
      }
    },
    dispose() {
      disposeChildren(group)
      solid.dispose()
      faint.dispose()
      arrowMaterial.dispose()
      group.removeFromParent()
    },
  }
}
