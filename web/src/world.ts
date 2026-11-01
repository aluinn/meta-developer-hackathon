// The shape of world.json (see shared/world.schema.json) and a checker for it.
// Written by hand so we don't need a validation library.

export type Vec3 = [number, number, number]
export type Role = 'fixed' | 'movable' | 'climbable' | 'passable'

export interface WorldObject {
  id: string
  label: string
  role: Role
  confidence: number
  position: Vec3 // centre of the box, metres
  size: Vec3 // [width, height, depth], metres
  rotation_y: number // radians
}

export interface World {
  version: number
  source_scan: string
  room: {
    bounds: { min: Vec3; max: Vec3 }
    floor_y: number
  }
  objects: WorldObject[]
  spawn: Vec3
  goal: Vec3
}

const ROLES: readonly string[] = ['fixed', 'movable', 'climbable', 'passable']

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function asVec3(v: unknown, where: string): Vec3 {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(isNum)) {
    throw new Error(`${where} must be three numbers`)
  }
  return [v[0], v[1], v[2]]
}

function asObject(v: unknown, where: string): WorldObject {
  if (!isObj(v)) throw new Error(`${where} must be an object`)
  const { id, label, role, confidence, rotation_y } = v
  if (typeof id !== 'string' || id === '') throw new Error(`${where}.id must be text`)
  if (typeof label !== 'string' || label === '') throw new Error(`${where}.label must be text`)
  if (typeof role !== 'string' || !ROLES.includes(role)) {
    throw new Error(`${where}.role must be one of ${ROLES.join(', ')}`)
  }
  if (!isNum(confidence) || confidence < 0 || confidence > 1) {
    throw new Error(`${where}.confidence must be a number from 0 to 1`)
  }
  if (!isNum(rotation_y)) throw new Error(`${where}.rotation_y must be a number`)
  const size = asVec3(v.size, `${where}.size`)
  if (size.some((n) => n <= 0)) throw new Error(`${where}.size must be above zero`)
  return {
    id,
    label,
    role: role as Role,
    confidence,
    position: asVec3(v.position, `${where}.position`),
    size,
    rotation_y,
  }
}

/** Check unknown data (e.g. parsed JSON) and return it as a typed World. Throws a readable Error. */
export function parseWorld(data: unknown): World {
  if (!isObj(data)) throw new Error('world must be an object')
  const { version, source_scan, room, objects } = data
  if (!isNum(version) || !Number.isInteger(version) || version < 1) {
    throw new Error('version must be a whole number, 1 or more')
  }
  if (typeof source_scan !== 'string') throw new Error('source_scan must be text')
  if (!isObj(room) || !isObj(room.bounds)) throw new Error('room.bounds is missing')
  if (!isNum(room.floor_y)) throw new Error('room.floor_y must be a number')
  if (!Array.isArray(objects)) throw new Error('objects must be a list')
  return {
    version,
    source_scan,
    room: {
      bounds: {
        min: asVec3(room.bounds.min, 'room.bounds.min'),
        max: asVec3(room.bounds.max, 'room.bounds.max'),
      },
      floor_y: room.floor_y,
    },
    objects: objects.map((o, i) => asObject(o, `objects[${i}]`)),
    spawn: asVec3(data.spawn, 'spawn'),
    goal: asVec3(data.goal, 'goal'),
  }
}

/** Load the shared example room. The file lives in /shared; Vite bundles it as raw text. */
export async function loadExampleWorld(): Promise<World> {
  const { default: raw } = await import('../../shared/example_world.json?raw')
  return parseWorld(JSON.parse(raw))
}
