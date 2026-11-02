// Colours for each role, shared by the 3D scene and the legend so they always match.

import type { Role } from './world.ts'

export interface Look {
  color: number // 0xRRGGBB, used by three.js
  opacity: number // 1 = solid
  name: string // short text for the legend
}

export const ROLE_LOOKS: Record<Role, Look> = {
  fixed: { color: 0x6b7a90, opacity: 1, name: 'Fixed (stays put)' },
  movable: { color: 0xf08c00, opacity: 1, name: 'Movable' },
  climbable: { color: 0x2f9e44, opacity: 1, name: 'Climbable' },
  passable: { color: 0x4dabf7, opacity: 0.35, name: 'Passable (walk over/through)' },
}

export const SPAWN_LOOK: Look = { color: 0xe64980, opacity: 1, name: 'Start' }
export const GOAL_LOOK: Look = { color: 0xfcc419, opacity: 1, name: 'Goal' }

/** 0x2f9e44 -> "#2f9e44", for use in CSS. */
export function toCss(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`
}
