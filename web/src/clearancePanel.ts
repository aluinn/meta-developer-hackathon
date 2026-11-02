// The "Clearance check" section of the Layout tab: pick who is walking (or any width), and see whether they can still get
// from Start to Goal, plus the walkability score. The maths is in clearance.ts; the 3D drawing is in clearanceView.ts.

import { checkClearance, PERSON_WIDTHS, snapNotes, summarise, WIDTH_SLIDER, type PersonKind } from './clearance.ts'
import { createClearanceView } from './clearanceView.ts'
import type { Viewer } from './viewer.ts'
import type { World } from './world.ts'

export interface ClearancePanel {
  /** Check a different room (e.g. the "after" layout). */
  setWorld: (world: World) => void
  /** Show or hide the drawings in the 3D view (the Layout tab was opened or closed). */
  setActive: (active: boolean) => void
  /** Remove the section and the drawings, and free everything. */
  dispose: () => void
}

const KINDS = Object.keys(PERSON_WIDTHS) as PersonKind[]

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** "0.85 m" (two decimals, but "0.5 m" rather than "0.50 m"). */
function metres(m: number): string {
  return `${m.toFixed(2).replace(/0$/, '')} m`
}

export function createClearancePanel(container: HTMLElement, viewer: Viewer, initialWorld: World): ClearancePanel {
  let world = initialWorld
  let width: number = PERSON_WIDTHS.walking.widthM
  const view = createClearanceView(viewer)

  const section = el('section', 'clearance-panel')
  section.setAttribute('aria-labelledby', 'clearance-title')
  const title = el('h2', 'layout-title', 'Clearance check')
  title.id = 'clearance-title'
  const hint = el('p', 'layout-hint', 'Can someone still get from Start to Goal? Pick who, or set any width.')

  // ---- Who is walking: three buttons, and a slider for any width ----
  const buttons = el('div', 'width-buttons')
  buttons.setAttribute('role', 'group')
  buttons.setAttribute('aria-label', 'Who is walking')
  const buttonFor = new Map<PersonKind, HTMLButtonElement>()
  for (const kind of KINDS) {
    const { label, widthM } = PERSON_WIDTHS[kind]
    const b = el('button', 'width-btn')
    b.type = 'button'
    b.append(el('span', 'width-btn-name', label), el('span', 'width-btn-size', metres(widthM)))
    b.addEventListener('click', () => setWidth(widthM, true))
    buttonFor.set(kind, b)
    buttons.append(b)
  }

  const sliderRow = el('div', 'width-slider-row')
  const slider = el('input', 'width-slider')
  slider.type = 'range'
  slider.id = 'clearance-width'
  slider.min = String(WIDTH_SLIDER.minM)
  slider.max = String(WIDTH_SLIDER.maxM)
  slider.step = String(WIDTH_SLIDER.stepM)
  const sliderLabel = el('label', 'width-slider-label', 'Width')
  sliderLabel.htmlFor = slider.id
  const sliderValue = el('output', 'width-slider-value')
  sliderValue.htmlFor.add(slider.id)
  sliderRow.append(sliderLabel, slider, sliderValue)
  slider.addEventListener('input', () => setWidth(Number(slider.value), false))

  // ---- The answer ----
  const score = el('p', 'clearance-score')
  score.setAttribute('aria-live', 'polite')
  const notes = el('ul', 'clearance-notes')
  const timing = el('p', 'clearance-timing') // development only: how long the check took

  const pause = el('button', 'btn btn-small clearance-pause', 'Pause')
  pause.type = 'button'
  pause.setAttribute('aria-pressed', 'false')
  let paused = false
  pause.addEventListener('click', () => {
    paused = !paused
    pause.textContent = paused ? 'Play' : 'Pause'
    pause.setAttribute('aria-pressed', String(paused))
    view.setPaused(paused)
  })

  // What the colours in the 3D view mean.
  const key = el('ul', 'clearance-key')
  for (const [className, text] of [
    ['key-route', 'Route'],
    ['key-reach', 'Floor they can reach'],
    ['key-narrowest', 'Narrowest gap'],
    ['key-blocked', 'Blocked here'],
  ]) {
    const item = el('li')
    item.append(el('span', `key-swatch ${className}`), document.createTextNode(text))
    key.append(item)
  }

  const how = el('details', 'clearance-how')
  how.append(el('summary', undefined, 'How is this worked out?'))
  for (const text of [
    'We cover the floor with 5 cm squares and measure how far each one is from the nearest furniture or wall. ' +
      'The person fits wherever there is at least half their width on each side. Rugs and doors (passable things) ' +
      "don't block, and nor does anything higher than 2 m, like a high shelf.",
    'Floor reachable: of all the floor not covered by furniture, how much the person can get to from Start.',
    'Narrowest gap: the tightest squeeze on the route. We pick the route with the most room. The 50 cm around ' +
      "Start and Goal don't count: that's where the person stands, and we've already checked they fit there.",
    'If Start or Goal is inside furniture or too close to it, we move it (by up to 50 cm) to the nearest spot with room, and say so.',
  ]) {
    how.append(el('p', undefined, text))
  }

  const disclaimer = el('p', 'clearance-disclaimer', 'Sizes are estimates from phone LiDAR. This is a planning aid, not a safety assessment.')

  section.append(title, hint, buttons, sliderRow, score, notes, pause, key, how, disclaimer, timing)
  container.append(section)

  // ---- Working it out ----
  function labelFor(w: number): string {
    const kind = KINDS.find((k) => Math.abs(PERSON_WIDTHS[k].widthM - w) < 1e-6)
    return kind ? PERSON_WIDTHS[kind].label : 'Custom width'
  }

  function recalculate(): void {
    const result = checkClearance(world, width)
    view.show(result, world)
    score.textContent = summarise(result, labelFor(width))
    score.classList.toggle('is-reachable', result.reachable)
    score.classList.toggle('is-blocked', !result.reachable)
    notes.replaceChildren(...snapNotes(result).map((text) => el('li', undefined, text)))
    if (import.meta.env.DEV) timing.textContent = `Worked out in ${result.gridInfo.ms.toFixed(0)} ms (dev only)`
  }

  // Dragging the slider fires many times a second: work it out at most once per screen frame.
  let frame = 0
  function setWidth(w: number, now: boolean): void {
    width = w
    slider.value = String(w)
    sliderValue.textContent = metres(w)
    for (const [kind, b] of buttonFor) b.setAttribute('aria-pressed', String(Math.abs(PERSON_WIDTHS[kind].widthM - w) < 1e-6))
    if (now) {
      cancelAnimationFrame(frame)
      frame = 0
      recalculate()
    } else if (frame === 0) {
      frame = requestAnimationFrame(() => {
        frame = 0
        recalculate()
      })
    }
  }
  setWidth(width, true)

  return {
    setWorld: (next) => {
      world = next
      recalculate()
    },
    setActive: (active) => view.setVisible(active),
    dispose: () => {
      cancelAnimationFrame(frame)
      view.dispose()
      section.remove()
    },
  }
}
