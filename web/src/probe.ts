// Finds the standable surfaces of the real physics world (the scan) with rays, for walkGraph.ts.

import RAPIER from '@dimforge/rapier3d-compat'

const MAX_SURFACES = 8 // per column; a room rarely has more than floor + a table top + a shelf
const UP_FACING = 0.7 // a surface counts as standable if its normal points up at least this much (cos of about 45 degrees)

/**
 * Looks down from the top of the room, again and again: every up-facing surface that has room above it for the character
 * is one a character can stand on. `exclude` is the character's own collider, which must not count.
 */
export function createProbe(physics: RAPIER.World, topY: number, characterHeight: number, exclude?: RAPIER.Collider) {
  const down = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 })
  const up = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 })
  return {
    surfaces(x: number, z: number): number[] {
      const found: number[] = []
      let y = topY
      for (let n = 0; n < MAX_SURFACES * 2 && found.length < MAX_SURFACES; n++) {
        down.origin = { x, y, z }
        const hit = physics.castRayAndGetNormal(down, y + 50, true, undefined, undefined, exclude)
        if (!hit) break
        const hitY = y - hit.timeOfImpact
        if (hit.normal.y >= UP_FACING) {
          up.origin = { x, y: hitY + 0.003, z }
          const roof = physics.castRay(up, characterHeight * 1.05, true, undefined, undefined, exclude)
          if (!roof) found.push(hitY) // enough room above to stand here
        }
        y = hitY - 0.004 // carry on below this surface
      }
      return found
    },
  }
}
