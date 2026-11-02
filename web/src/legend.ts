// The small colour key shown over the 3D view.

import { GOAL_LOOK, ROLE_LOOKS, SPAWN_LOOK, toCss, type Look } from './roles.ts'

export function buildLegend(): HTMLElement {
  const legend = document.createElement('ul')
  legend.className = 'legend'
  legend.setAttribute('aria-label', 'Colour key')
  const looks: Look[] = [...Object.values(ROLE_LOOKS), SPAWN_LOOK, GOAL_LOOK]
  for (const look of looks) {
    const row = document.createElement('li')
    const swatch = document.createElement('span')
    swatch.className = 'swatch'
    swatch.style.backgroundColor = toCss(look.color)
    swatch.style.opacity = String(Math.max(look.opacity, 0.5)) // keep see-through ones visible
    row.append(swatch, look.name)
    legend.append(row)
  }
  return legend
}
