// Turns a World (from world.json) into three.js objects.
// No camera, renderer or screen code in here, so play mode (Z3) can reuse it.
//
// Contract reminders: metres, y is up, `position` is the CENTRE of the box,
// `size` is [width (x), height (y), depth (z)], `rotation_y` is radians.

import * as THREE from 'three'
import { createLabelSprite } from './labelSprite.ts'
import { GOAL_LOOK, ROLE_LOOKS, SPAWN_LOOK, type Look } from './roles.ts'
import type { Vec3, World, WorldObject } from './world.ts'

const OUTLINE_COLOR = 0x1b1f2a

/** Names used to find parts of the room later (play mode hides some of them). */
export const OBJECT_LABEL = 'object-label'
export const SPAWN_MARKER = 'spawn-marker'
export const GOAL_MARKER = 'goal-marker'

function buildFloor(world: World): THREE.Mesh {
  const { min, max } = world.room.bounds
  const geometry = new THREE.PlaneGeometry(max[0] - min[0], max[2] - min[2])
  geometry.rotateX(-Math.PI / 2) // planes start upright; lay it flat
  const material = new THREE.MeshStandardMaterial({
    color: 0x9aa4b8,
    // Nudge the floor back a hair so thin things lying on it (a rug) don't flicker.
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  })
  const floor = new THREE.Mesh(geometry, material)
  floor.name = 'floor'
  floor.position.set((min[0] + max[0]) / 2, world.room.floor_y, (min[2] + max[2]) / 2)
  return floor
}

/** Faint outline of the room's edges (walls, floor and ceiling lines). */
function buildWallOutline(world: World): THREE.LineSegments {
  const { min, max } = world.room.bounds
  const box = new THREE.BoxGeometry(max[0] - min[0], max[1] - world.room.floor_y, max[2] - min[2])
  const edges = new THREE.EdgesGeometry(box)
  box.dispose()
  const material = new THREE.LineBasicMaterial({ color: 0x7c86a0, transparent: true, opacity: 0.55 })
  const outline = new THREE.LineSegments(edges, material)
  outline.name = 'room-outline'
  outline.position.set(
    (min[0] + max[0]) / 2,
    world.room.floor_y + (max[1] - world.room.floor_y) / 2,
    (min[2] + max[2]) / 2,
  )
  return outline
}

function buildObject(obj: WorldObject): THREE.Group {
  const look = ROLE_LOOKS[obj.role]
  const [w, h, d] = obj.size
  const group = new THREE.Group()
  group.name = obj.id

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({
      color: look.color,
      transparent: look.opacity < 1,
      opacity: look.opacity,
      depthWrite: look.opacity >= 1,
    }),
  )
  body.position.fromArray(obj.position) // the centre of the box
  body.rotation.y = obj.rotation_y
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(body.geometry),
    new THREE.LineBasicMaterial({ color: OUTLINE_COLOR, transparent: true, opacity: 0.6 }),
  )
  body.add(edges)

  // The label sits just above the top of the box (and is not rotated with it).
  const label = createLabelSprite(obj.label)
  label.name = OBJECT_LABEL
  label.position.set(obj.position[0], obj.position[1] + h / 2 + 0.2, obj.position[2])

  group.add(body, label)
  return group
}

/** A pole with a ball (start) or a cone (goal) standing on a flat disc, plus a text label. */
function buildMarker(at: Vec3, look: Look, shape: 'ball' | 'cone', name: string): THREE.Group {
  const group = new THREE.Group()
  group.name = name
  // Always drawn on top, so furniture can never hide where to start or where to go.
  const material = new THREE.MeshStandardMaterial({ color: look.color, depthTest: false, depthWrite: false })

  const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.03, 32), material)
  disc.position.y = 0.015
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.6, 12), material)
  pole.position.y = 0.8
  const top =
    shape === 'ball'
      ? new THREE.Mesh(new THREE.SphereGeometry(0.14, 24, 16), material)
      : new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.4, 24), material)
  top.position.y = shape === 'ball' ? 1.7 : 1.8

  const label = createLabelSprite(look.name)
  label.position.y = 2.3

  for (const part of [disc, pole, top]) part.renderOrder = 5
  group.add(disc, pole, top, label)
  group.position.fromArray(at)
  return group
}

/** Everything for one room, in one group. Free it with disposeChildren() when done. */
export function buildRoom(world: World): THREE.Group {
  const room = new THREE.Group()
  room.name = 'room'
  room.add(buildFloor(world), buildWallOutline(world))
  for (const obj of world.objects) room.add(buildObject(obj))
  room.add(
    buildMarker(world.spawn, SPAWN_LOOK, 'ball', SPAWN_MARKER),
    buildMarker(world.goal, GOAL_LOOK, 'cone', GOAL_MARKER),
  )
  return room
}
