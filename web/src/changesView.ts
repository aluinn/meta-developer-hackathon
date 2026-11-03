// Draws what the layout agent changed, in the 3D view (in the After layout): each moved object is highlighted where it now is,
// a faint ghost marks where it used to be, and an arrow runs from the old spot to the new one. Boxes only (no scan picture).

import * as THREE from 'three'
import { disposeChildren } from './dispose.ts'
import { createLabelSprite } from './labelSprite.ts'
import type { LayoutChange } from './layoutAgent.ts'
import type { Viewer } from './viewer.ts'
import type { World } from './world.ts'

const MOVED = 0xffd43b // yellow: the highlight and the arrow
const GHOST = 0x9aa4b8
const ARROW_LIFT = 0.07 // above the floor, so it doesn't flicker against it
const HEAD_LENGTH = 0.3

export interface ChangesView {
  /** Draw these changes (replacing the last ones). `before` is the original room: it has the sizes. */
  show: (before: World, changes: LayoutChange[]) => void
  /** Show or hide the drawings (they belong to the After view). */
  setVisible: (visible: boolean) => void
  dispose: () => void
}

function outline(w: number, h: number, d: number, colour: number, opacity: number): THREE.LineSegments {
  const box = new THREE.BoxGeometry(w, h, d)
  const lines = new THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity }))
  box.dispose()
  return lines
}

/** A flat arrow lying on the floor from (ax, az) to (bx, bz). */
function buildArrow(ax: number, az: number, bx: number, bz: number, floorY: number): THREE.Group {
  const dx = bx - ax
  const dz = bz - az
  const length = Math.hypot(dx, dz)
  const group = new THREE.Group()
  group.position.set(ax, floorY + ARROW_LIFT, az)
  group.rotation.y = Math.atan2(-dz, dx) // three.js turns +x towards -z for a positive angle, so this points along (dx, dz)
  // Drawn on top of furniture, like the route and the Start and Goal markers, so it can't be hidden.
  const material = new THREE.MeshBasicMaterial({ color: MOVED, depthTest: false, depthWrite: false })
  const shaftLength = Math.max(0.05, length - HEAD_LENGTH)
  const shaft = new THREE.Mesh(new THREE.BoxGeometry(shaftLength, 0.02, 0.07), material)
  shaft.position.x = shaftLength / 2
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.13, HEAD_LENGTH, 16), material)
  head.rotation.z = -Math.PI / 2 // cones point up; turn it to point along +x
  head.position.x = shaftLength + HEAD_LENGTH / 2
  for (const part of [shaft, head]) part.renderOrder = 6
  group.add(shaft, head)
  return group
}

export function createChangesView(viewer: Pick<Viewer, 'overlay'>): ChangesView {
  const root = new THREE.Group()
  root.name = 'layout-changes'
  viewer.overlay.add(root)

  return {
    show: (before, changes) => {
      disposeChildren(root)
      for (const change of changes) {
        const was = before.objects.find((o) => o.id === change.id)
        if (!was) continue
        const [w, h, d] = was.size

        // Where it was: a faint ghost, with a small label.
        const ghost = new THREE.Group()
        ghost.position.fromArray(change.from.position)
        ghost.rotation.y = change.from.rotation_y
        ghost.add(
          new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ color: GHOST, transparent: true, opacity: 0.18, depthWrite: false })),
          outline(w, h, d, GHOST, 0.9),
        )
        const tag = createLabelSprite('was here', 0.16)
        tag.position.set(change.from.position[0], change.from.position[1] + h / 2 + 0.15, change.from.position[2])

        // Where it is now: a glow and a bright outline, slightly bigger than the box itself.
        const now = new THREE.Group()
        now.position.fromArray(change.to.position)
        now.rotation.y = change.to.rotation_y
        now.add(
          new THREE.Mesh(new THREE.BoxGeometry(w * 1.05, h * 1.05, d * 1.05), new THREE.MeshBasicMaterial({ color: MOVED, transparent: true, opacity: 0.3, depthWrite: false })),
          outline(w * 1.05, h * 1.05, d * 1.05, MOVED, 1),
        )

        const floorY = before.room.floor_y
        root.add(ghost, tag, now, buildArrow(change.from.position[0], change.from.position[2], change.to.position[0], change.to.position[2], floorY))
      }
    },
    setVisible: (visible) => {
      root.visible = visible
    },
    dispose: () => {
      disposeChildren(root)
      root.removeFromParent()
    },
  }
}
