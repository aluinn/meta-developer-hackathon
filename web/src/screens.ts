// Builds the three screens (Upload, Loading, Results) and switches between them.
// Only one screen is visible at a time; the page never reloads.

import { formatSize } from './format.ts'
import { buildLegend } from './legend.ts'
import type { World } from './world.ts'

export type ScreenName = 'upload' | 'loading' | 'results'
export type TabName = 'play' | 'layout' | 'character'
/** Game mode: scan a room and race through it. Work mode: a labelled 3D model for architects, agents and planners. */
export type Mode = 'game' | 'work'

export interface ScreenHandlers {
  onFileChosen: (file: File, mode: Mode) => void
  onUseExample: (mode: Mode) => void
  /** Only passed in development builds; adds a "Use test room" button. */
  onUseTestRoom?: () => void
  /** Only passed in development builds; adds a "Use narrow-gap test room" button (for the clearance check). */
  onUseGapTestRoom?: () => void
  onStartOver: () => void
  onPlay: () => void
  onLayout: () => void
  onCharacter: () => void
}

export interface Screens {
  show: (name: ScreenName) => void
  showFile: (file: File) => void
  showError: (message: string) => void
  setStatus: (message: string) => void
  setResultsSummary: (title: string, detail: string) => void
  /** The empty box on the Results screen that the 3D viewer draws into. */
  viewContainer: HTMLElement
  /** Switch the Results screen in or out of full-screen play mode. */
  setPlaying: (playing: boolean) => void
  /** The empty box under the 3D view where the Layout panel is built. */
  layoutContainer: HTMLElement
  /** Show or hide the Layout panel (and mark the Layout tab). */
  setLayoutOpen: (open: boolean) => void
  /** Show a short message over the 3D view (empty text hides it). */
  setViewMessage: (message: string) => void
  /** Dress the Loading and Results screens for game mode or work mode. */
  setMode: (mode: Mode) => void
  /** Fill the Work mode side panel (room size and the objects found). */
  setWorkInfo: (world: World) => void
}

/** Small helper: make an element with a class and text (text is never treated as HTML). */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

// Small line icons for the Work mode use cases (fixed text we wrote ourselves, so it is safe to use as HTML).
const USE_CASES: Array<{ title: string; text: string; icon: string }> = [
  { title: 'Architecture', text: 'Measure and label an existing room from a phone scan.', icon: '<path d="M4 26V12l10-7 10 7v14M10 26v-8h8v8M3 26h22" />' },
  { title: 'Real estate', text: 'Turn a viewing into a 3D model you can share.', icon: '<path d="M4 14 14 5l10 9M7 12v14h14V12M12 26v-7h4v7" />' },
  { title: 'Interior design', text: 'See what is in a space and how big it is. (Layout tools: soon.)', icon: '<path d="M5 18v-5a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v5M3 18h22v5H3zM6 23v3M22 23v3" />' },
  { title: 'Facilities & safety', text: 'Check clearances and spot obstacles before you visit.', icon: '<path d="M14 4 3 24h22zM14 11v6M14 20.5v.5" />' },
]

function buildUpload(h: ScreenHandlers) {
  const section = el('section', 'screen landing')
  section.id = 'screen-upload'

  // One hidden file picker shared by both halves; the half you pressed decides the mode.
  let pendingMode: Mode = 'game'
  const input = el('input')
  input.type = 'file'
  input.id = 'scan-file'
  input.className = 'visually-hidden'
  input.accept = '.glb,.obj'
  input.addEventListener('change', () => {
    const file = input.files?.[0]
    input.value = '' // so choosing the same file again still counts
    if (file) {
      section.dataset.chosen = pendingMode // the chosen half grows to fill the screen while the next one fades in
      h.onFileChosen(file, pendingMode)
    }
  })

  const button = (label: string, kind: 'primary' | 'ghost', onClick: () => void) => {
    const b = el('button', `landing-btn landing-btn-${kind}`, label)
    b.type = 'button'
    b.addEventListener('click', onClick)
    return b
  }
  const choose = (mode: Mode) => () => {
    pendingMode = mode
    input.click()
  }

  const half = (mode: Mode, eyebrow: string, titleText: string, text: string, chips: string[], primary: string, secondary: string) => {
    const side = el('div', `half half-${mode}`)
    const bg = el('div', 'half-bg')
    const inner = el('div', 'half-inner')
    const tag = el('p', 'half-eyebrow', eyebrow)
    const heading = el('h2', 'half-title', titleText)
    const blurb = el('p', 'half-text', text)
    const chipRow = el('ul', 'half-chips')
    for (const c of chips) chipRow.append(el('li', undefined, c))
    const actions = el('div', 'half-actions')
    const link = el('button', 'landing-link', secondary)
    link.type = 'button'
    link.addEventListener('click', () => {
      section.dataset.chosen = mode
      h.onUseExample(mode)
    })
    actions.append(button(primary, 'primary', choose(mode)), link)
    inner.append(tag, heading, blurb, chipRow, actions)
    if (mode === 'work') {
      const cases = el('ul', 'cases')
      for (const c of USE_CASES) {
        const li = el('li', 'case')
        const icon = el('span', 'case-icon')
        icon.innerHTML = `<svg viewBox="0 0 28 30" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${c.icon}</svg>`
        const words = el('span')
        words.append(el('strong', undefined, c.title), el('span', undefined, c.text))
        li.append(icon, words)
        cases.append(li)
      }
      inner.append(cases)
    }
    if (mode === 'game') {
      const keys = el('dl', 'rows')
      for (const [key, what] of [['WASD', 'Run'], ['Space', 'Jump, or fly with Wings'], ['E', 'Use a power-up'], ['Mouse', 'Look around']]) {
        const row = el('div')
        row.append(el('dt', undefined, key), el('dd', undefined, what))
        keys.append(row)
      }
      inner.append(keys)
    }
    side.append(bg, inner)
    return side
  }

  const game = half(
    'game',
    'Game mode',
    'Your room is the level.',
    'Scan a room with your phone. Run, climb and jump across the furniture as a small hero, dodge the hazards and catch the flag before time runs out.',
    ['3 lives', 'Power-ups', 'Fly mode', 'Make your own hero'],
    'Scan & play',
    'Try the example room',
  )
  const work = half(
    'work',
    'Work mode',
    'Your space, understood.',
    'Upload a scan to get every object identified, measured and given a role, in a model you can inspect.',
    ['Object detection', 'Real dimensions', 'Role labels', 'Share-ready model'],
    'Upload a scan',
    'Open the example room',
  )

  // A thin line on the edge between the two halves.
  const seam = el('div', 'seam')

  const brand = el('header', 'landing-brand')
  const title = el('h1', undefined, 'Room world')
  title.tabIndex = -1
  brand.append(title, el('p', undefined, 'Scan a real room. Play it or plan with it.'))

  const fileInfo = el('p', 'file-info')
  fileInfo.setAttribute('aria-live', 'polite')
  const error = el('p', 'error')
  error.setAttribute('role', 'alert')
  const notes = el('div', 'landing-notes')
  notes.append(fileInfo, error)
  const foot = el('p', 'landing-foot', "Built with Meta's SAM, Muse Spark and Muse Image")

  const halves = el('div', 'halves')
  halves.append(game, work)
  work.append(seam) // the seam is part of the Work half, so it always sits exactly on the edge between the halves
  section.append(input, halves, brand, notes, foot)
  if (h.onUseTestRoom) {
    const test = el('button', 'landing-dev', 'Use test room (dev only)')
    test.type = 'button'
    test.addEventListener('click', h.onUseTestRoom)
    section.append(test)
  }
  if (h.onUseGapTestRoom) {
    const gap = el('button', 'btn btn-small', 'Use narrow-gap test room (dev only)')
    gap.type = 'button'
    gap.addEventListener('click', h.onUseGapTestRoom)
    section.append(gap)
  }
  return { section, title, fileInfo, error }
}

function buildLoading() {
  const section = el('section', 'screen screen-centered screen-loading')
  section.id = 'screen-loading'
  const spinner = el('div', 'spinner')
  spinner.setAttribute('aria-hidden', 'true')
  const status = el('p', 'lead', 'Loading…')
  status.setAttribute('role', 'status')
  status.tabIndex = -1
  section.append(spinner, status)
  return { section, status }
}

function buildResults(h: ScreenHandlers) {
  const section = el('section', 'screen screen-results')
  section.id = 'screen-results'

  const header = el('header', 'results-header')
  const heading = el('h1', undefined, 'Your room')
  heading.tabIndex = -1
  const detail = el('p', 'results-detail')
  const startOver = el('button', 'btn btn-small', 'Start over')
  startOver.type = 'button'
  startOver.addEventListener('click', h.onStartOver)
  const titles = el('div')
  titles.append(heading, detail)
  header.append(titles, startOver)

  // The 3D viewer (viewer.ts) puts its canvas in here; the legend floats on top.
  const view = el('div', 'view-area')
  view.id = 'view-area'
  const message = el('p', 'view-message')
  message.setAttribute('role', 'status')
  view.append(buildLegend(), message)

  // The Layout panel (layoutPanel.ts) is built inside this box. It is hidden until the Layout tab is pressed.
  const layoutBox = el('div', 'layout-box')
  layoutBox.hidden = true

  // Play enters play mode. Layout opens the layout panel (press again to close it).
  const tabs = el('div', 'tabbar')
  tabs.setAttribute('role', 'tablist')
  const tabButtons = new Map<TabName, HTMLButtonElement>()
  const makeTab = (name: TabName, label: string, onClick: () => void) => {
    const b = el('button', 'tab', label)
    b.type = 'button'
    b.setAttribute('role', 'tab')
    b.dataset.tab = name
    b.setAttribute('aria-selected', 'false')
    b.addEventListener('click', onClick)
    tabButtons.set(name, b)
    return b
  }
  tabs.append(
    makeTab('play', 'Play', h.onPlay),
    makeTab('layout', 'Layout', h.onLayout),
    makeTab('character', 'Character', h.onCharacter),
  )

  // Work mode: the 3D model next to a plain list of what was found.
  const workPanel = el('aside', 'work-panel')
  workPanel.setAttribute('aria-label', 'Room details')
  const body = el('div', 'work-body')
  body.append(view, workPanel)

  // The same as the Layout tab, but where people look first in Work mode (the panel is hidden in Game mode).
  const layoutButton = el('button', 'btn btn-primary work-layout-btn', 'Change the layout (voice)')
  layoutButton.type = 'button'
  layoutButton.setAttribute('aria-expanded', 'false')
  layoutButton.addEventListener('click', h.onLayout)

  section.append(header, body, layoutBox, tabs)
  const setPlaying = (playing: boolean) => {
    section.classList.toggle('playing', playing)
    tabButtons.get('play')?.setAttribute('aria-selected', String(playing))
  }
  const setWorkInfo = (world: World) => {
    const { min, max } = world.room.bounds
    const m = (n: number) => `${n.toFixed(2)} m`
    const size = el('dl', 'work-size')
    for (const [label, value] of [['Width', m(max[0] - min[0])], ['Depth', m(max[2] - min[2])], ['Height', m(max[1] - world.room.floor_y)]]) {
      const box = el('div')
      box.append(el('dt', undefined, label), el('dd', undefined, value))
      size.append(box)
    }
    const list = el('ul', 'work-objects')
    for (const o of world.objects) {
      const li = el('li')
      const cm = o.size.map((n) => Math.round(n * 100)).join(' × ')
      li.append(el('strong', undefined, o.label), el('span', 'work-role', o.role), el('span', 'work-dims', `${cm} cm`))
      list.append(li)
    }
    if (world.objects.length === 0) list.append(el('li', undefined, 'No objects found.'))
    workPanel.replaceChildren(layoutButton, el('h2', undefined, 'Room details'), size, el('h2', undefined, `Objects (${world.objects.length})`), list)
  }
  const setLayoutOpen = (open: boolean) => {
    layoutBox.hidden = !open
    section.classList.toggle('layout-open', open)
    tabButtons.get('layout')?.setAttribute('aria-selected', String(open))
    layoutButton.setAttribute('aria-expanded', String(open))
  }
  return { section, heading, detail, view, message, setPlaying, setWorkInfo, layoutBox, setLayoutOpen }
}

export function createScreens(root: HTMLElement, handlers: ScreenHandlers): Screens {
  const upload = buildUpload(handlers)
  const loading = buildLoading()
  const results = buildResults(handlers)
  const byName: Record<ScreenName, { section: HTMLElement; focus: HTMLElement }> = {
    upload: { section: upload.section, focus: upload.title },
    loading: { section: loading.section, focus: loading.status },
    results: { section: results.section, focus: results.heading },
  }
  root.replaceChildren(upload.section, loading.section, results.section)

  // Moving between screens: the old one fades out on top while the new one fades in underneath (no hard cut).
  // The new screen is laid out straight away, so the 3D viewer still gets a real size.
  const LEAVE_MS = 450
  const leaveTimers = new Map<HTMLElement, number>()
  let current: ScreenName | null = null
  const show = (name: ScreenName) => {
    const next = byName[name].section
    const prev = current ? byName[current].section : null
    current = name
    if (name === 'upload') delete upload.section.dataset.chosen
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    for (const s of Object.values(byName)) {
      if (s.section === next || s.section === prev) continue
      window.clearTimeout(leaveTimers.get(s.section))
      s.section.classList.remove('leaving')
      s.section.hidden = true
    }
    window.clearTimeout(leaveTimers.get(next))
    next.classList.remove('leaving')
    next.hidden = false
    if (prev && prev !== next && !calm) {
      prev.classList.add('leaving')
      leaveTimers.set(prev, window.setTimeout(() => {
        prev.hidden = true
        prev.classList.remove('leaving')
      }, LEAVE_MS))
      next.classList.remove('entering')
      void next.offsetWidth // restart the fade-in
      next.classList.add('entering')
    } else if (prev && prev !== next) {
      prev.hidden = true
    }
    byName[name].focus.focus({ preventScroll: true })
    window.scrollTo(0, 0)
  }
  show('upload')

  return {
    show,
    showFile: (file) => {
      upload.error.textContent = ''
      upload.fileInfo.textContent = `${file.name} (${formatSize(file.size)}). Not uploaded yet.`
    },
    showError: (message) => {
      delete upload.section.dataset.chosen
      upload.error.textContent = message
    },
    setStatus: (message) => {
      loading.status.textContent = message
    },
    viewContainer: results.view,
    setPlaying: results.setPlaying,
    setMode: (mode) => {
      document.body.dataset.mode = mode
      results.section.dataset.mode = mode
    },
    setWorkInfo: results.setWorkInfo,
    layoutContainer: results.layoutBox,
    setLayoutOpen: results.setLayoutOpen,
    setViewMessage: (text) => {
      results.message.textContent = text
    },
    setResultsSummary: (title, detail) => {
      results.heading.textContent = title
      results.detail.textContent = detail
    },
  }
}
