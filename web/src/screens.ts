// Builds the three screens (Upload, Loading, Results) and switches between them.
// Only one screen is visible at a time; the page never reloads.

import { formatSize } from './format.ts'
import { buildLegend } from './legend.ts'

export type ScreenName = 'upload' | 'loading' | 'results'
export type TabName = 'play' | 'layout' | 'character'

export interface ScreenHandlers {
  onFileChosen: (file: File) => void
  onUseExample: () => void
  /** Only passed in development builds; adds a "Use test room" button. */
  onUseTestRoom?: () => void
  onStartOver: () => void
  onPlay: () => void
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
  /** Show a short message over the 3D view (empty text hides it). */
  setViewMessage: (message: string) => void
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

function buildUpload(h: ScreenHandlers) {
  const section = el('section', 'screen screen-centered')
  section.id = 'screen-upload'

  const title = el('h1', undefined, 'Room world')
  title.tabIndex = -1
  const intro = el('p', 'lead', 'Turn a scan of your room into a world you can play in.')

  // The real file input is hidden; the big label acts as its button.
  const input = el('input')
  input.type = 'file'
  input.id = 'scan-file'
  input.className = 'visually-hidden'
  input.accept = '.glb,.obj'
  const pick = el('label', 'btn btn-primary', 'Choose a scan file')
  pick.htmlFor = 'scan-file'

  const fileInfo = el('p', 'file-info')
  fileInfo.setAttribute('aria-live', 'polite')
  const error = el('p', 'error')
  error.setAttribute('role', 'alert')

  const or = el('p', 'or', 'or')
  const example = el('button', 'btn btn-secondary', 'Use example room')
  example.type = 'button'

  input.addEventListener('change', () => {
    const file = input.files?.[0]
    if (file) h.onFileChosen(file)
  })
  example.addEventListener('click', h.onUseExample)

  section.append(title, intro, input, pick, fileInfo, error, or, example)
  if (h.onUseTestRoom) {
    const test = el('button', 'btn btn-small', 'Use test room (dev only)')
    test.type = 'button'
    test.addEventListener('click', h.onUseTestRoom)
    section.append(test)
  }
  return { section, title, fileInfo, error }
}

function buildLoading() {
  const section = el('section', 'screen screen-centered')
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

  // Play enters play mode. Layout does nothing yet (a later task).
  const tabs = el('div', 'tabbar')
  tabs.setAttribute('role', 'tablist')
  const tabButtons = new Map<TabName, HTMLButtonElement>()
  const makeTab = (name: TabName, label: string, onClick: () => void) => {
    const b = el('button', 'tab', label)
    b.type = 'button'
    b.setAttribute('role', 'tab')
    b.setAttribute('aria-selected', 'false')
    b.addEventListener('click', onClick)
    tabButtons.set(name, b)
    return b
  }
  tabs.append(
    makeTab('play', 'Play', h.onPlay),
    makeTab('layout', 'Layout', () => {}),
    makeTab('character', 'Character', h.onCharacter),
  )

  section.append(header, view, tabs)
  const setPlaying = (playing: boolean) => {
    section.classList.toggle('playing', playing)
    tabButtons.get('play')?.setAttribute('aria-selected', String(playing))
  }
  return { section, heading, detail, view, message, setPlaying }
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

  const show = (name: ScreenName) => {
    for (const [n, s] of Object.entries(byName)) s.section.hidden = n !== name
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
      upload.error.textContent = message
    },
    setStatus: (message) => {
      loading.status.textContent = message
    },
    viewContainer: results.view,
    setPlaying: results.setPlaying,
    setViewMessage: (text) => {
      results.message.textContent = text
    },
    setResultsSummary: (title, detail) => {
      results.heading.textContent = title
      results.detail.textContent = detail
    },
  }
}
