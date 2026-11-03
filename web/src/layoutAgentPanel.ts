// The "Layout agent" section of the Layout tab: ask for a new layout for the goal, flip the 3D view between Before and After,
// read what changed and why, and compare walkability before and after. Also shows the scan-versus-simulation score (A6) and,
// if you add a photo of the room, realistic before/after pictures (A5). The 3D drawing is in changesView.ts; the numbers
// come from layoutAgent.ts, which asks checkClearance (clearance.ts) for both layouts.

import { ApiError, checkPhoto, getLayout, getScore, isFakeServer, renderBeforeAfter } from './api.ts'
import { createChangesView } from './changesView.ts'
import type { ClearancePanel } from './clearancePanel.ts'
import { compareClearance, scanIdOf, type LayoutResult, type RenderResult } from './layoutAgent.ts'
import { getLayoutGoal, onLayoutGoalChange } from './layoutGoal.ts'
import type { Viewer } from './viewer.ts'
import type { World } from './world.ts'

export interface LayoutAgentPanel {
  /** Let the panel see the clearance check (it needs the person's width, and tells it which layout is showing). Call once. */
  link: (clearance: ClearancePanel) => void
  /** The Layout tab was opened (true) or closed (false): show the suggested layout in the 3D view, or put the original back. */
  setActive: (active: boolean) => void
  /** Remove the section and everything it drew. */
  dispose: () => void
}

type View = 'before' | 'after'

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const messageOf = (err: unknown): string =>
  err instanceof ApiError ? err.message : 'Something went wrong. Please try again.'

export function createLayoutAgentPanel(
  container: HTMLElement,
  options: { viewer: Viewer; /** The box the 3D view is in (the Before / After switch goes on top of it). */ viewArea: HTMLElement; world: World },
): LayoutAgentPanel {
  const { viewer, viewArea, world } = options
  const scanId = scanIdOf(world)
  const pretend = isFakeServer()
  const changesView = createChangesView(viewer)
  changesView.setVisible(false)

  let clearance: ClearancePanel | null = null
  let stopWatchingWidth: (() => void) | null = null
  let proposal: LayoutResult | null = null
  let showing: View = 'before'
  let active = true
  let asking = false // waiting for the layout agent
  let drawing = false // waiting for the realistic pictures
  let askToken = 0 // bumped on "Back to original" and on leaving, so an answer that arrives late is ignored
  let drawToken = 0
  let photo: File | null = null
  let disposed = false

  // ---- The section ----
  const section = el('section', 'agent-panel')
  section.setAttribute('aria-labelledby', 'agent-title')
  const title = el('h2', 'layout-title', 'Layout agent')
  title.id = 'agent-title'
  const hint = el('p', 'layout-hint', 'The agent moves furniture (only things marked movable) to fit your goal. Then you can compare the two layouts.')

  // The scan-versus-simulation score (A6)
  const score = el('div', 'agent-score')
  const scoreValue = el('strong', 'agent-score-value', '…')
  const scoreText = el('span', 'agent-score-text')
  score.append(scoreValue, scoreText)

  const ask = el('button', 'btn btn-primary agent-ask', 'Suggest a new layout')
  ask.type = 'button'
  const goalLine = el('p', 'agent-goal')
  const status = el('p', 'agent-status')
  status.setAttribute('role', 'status')
  const spinner = el('span', 'agent-spinner')
  spinner.setAttribute('aria-hidden', 'true')
  spinner.hidden = true
  const statusRow = el('div', 'agent-status-row')
  statusRow.append(spinner, status)
  const error = el('p', 'error')
  error.setAttribute('role', 'alert')

  // ---- Results: shown once there is a suggestion ----
  const results = el('div', 'agent-results')
  results.hidden = true
  const again = el('button', 'btn btn-small', 'Try again')
  again.type = 'button'
  const back = el('button', 'btn btn-small', 'Back to original')
  back.type = 'button'
  const actions = el('div', 'agent-actions')
  actions.append(again, back)

  const changesTitle = el('h3', 'agent-subtitle', 'What changed')
  const changeList = el('ul', 'agent-changes')
  const notes = el('p', 'agent-notes')

  const compareTitle = el('h3', 'agent-subtitle', 'Can they still get through?')
  const compare = el('div', 'agent-compare')
  const verdict = el('p', 'agent-verdict')
  const compareWho = el('p', 'agent-compare-who')
  const beforeRow = el('p', 'agent-compare-row')
  const afterRow = el('p', 'agent-compare-row')
  compare.append(compareWho, beforeRow, afterRow, verdict)

  // Realistic pictures (A5): optional, needs a photo.
  const picTitle = el('h3', 'agent-subtitle', 'Realistic before and after (optional)')
  const picHint = el('p', 'layout-hint', 'Add a photo of the room that shows the moved furniture. The AI redraws it with the furniture moved.')
  const photoInput = el('input')
  photoInput.type = 'file'
  photoInput.id = 'agent-photo'
  photoInput.accept = 'image/jpeg,image/png,image/webp'
  photoInput.className = 'visually-hidden'
  const photoLabel = el('label', 'btn btn-small', 'Add a photo of the room')
  photoLabel.htmlFor = photoInput.id
  const photoName = el('span', 'agent-photo-name')
  const draw = el('button', 'btn btn-small', 'Show realistic images')
  draw.type = 'button'
  const photoRow = el('div', 'agent-actions')
  photoRow.append(photoLabel, draw)
  const drawStatus = el('p', 'agent-status')
  drawStatus.setAttribute('role', 'status')
  const drawError = el('p', 'error')
  drawError.setAttribute('role', 'alert')
  const pictures = el('div', 'agent-pictures')
  const pictureWarning = el('p', 'agent-warning')

  results.append(actions, changesTitle, changeList, notes, compareTitle, compare, picTitle, picHint, photoInput, photoRow, photoName, drawStatus, drawError, pictures, pictureWarning)
  section.append(title, hint, score, ask, goalLine, statusRow, error, results)
  container.append(section)

  // The Before / After switch sits on top of the 3D view, so you can flip while looking at it.
  const toggle = el('div', 'ba-toggle')
  toggle.setAttribute('role', 'group')
  toggle.setAttribute('aria-label', 'Which layout to show')
  toggle.hidden = true
  const toggleButtons = new Map<View, HTMLButtonElement>()
  for (const [which, label] of [['before', 'Before'], ['after', 'After']] as const) {
    const b = el('button', 'ba-btn', label)
    b.type = 'button'
    b.addEventListener('click', () => show(which))
    toggleButtons.set(which, b)
    toggle.append(b)
  }
  viewArea.append(toggle)

  // ---- What's showing ----
  function shownWorld(): World {
    return showing === 'after' && proposal ? proposal.world : world
  }

  /** Put the chosen layout in the 3D view (boxes only, so moved furniture is visible), and in the clearance check. */
  function show(which: View): void {
    showing = which
    const after = which === 'after' && proposal !== null
    viewer.setWorld(shownWorld(), true)
    viewer.showBoxesOnly(proposal !== null)
    changesView.setVisible(after)
    clearance?.setWorld(shownWorld())
    for (const [name, b] of toggleButtons) b.setAttribute('aria-pressed', String(name === which))
  }

  function renderComparison(): void {
    if (!proposal || proposal.changes.length === 0) {
      compareTitle.hidden = compare.hidden = true
      return
    }
    compareTitle.hidden = compare.hidden = false
    const c = compareClearance(world, proposal.world, clearance?.getWidth() ?? 0.85)
    compareWho.textContent = c.label
    beforeRow.textContent = `Before: ${c.beforeText}.`
    afterRow.textContent = `After: ${c.afterText}.`
    verdict.textContent = c.verdictText
    verdict.className = `agent-verdict is-${c.verdict}`
  }

  function renderResults(): void {
    results.hidden = proposal === null
    if (!proposal) {
      toggle.hidden = true
      return
    }
    const moved = proposal.changes.length > 0
    toggle.hidden = !moved || !active
    changesTitle.textContent = moved ? 'What changed' : 'Nothing was moved'
    changeList.replaceChildren(
      ...proposal.changes.map((c) => {
        const li = el('li')
        li.append(el('strong', undefined, c.label), document.createTextNode(c.reason ? `: ${c.reason}` : ' was moved.'))
        return li
      }),
    )
    notes.textContent = proposal.notes
    notes.hidden = proposal.notes === ''
    renderComparison()
    renderPhotoControls()
  }

  // ---- Asking for a layout ----
  function refreshAsk(): void {
    const goal = getLayoutGoal()
    ask.disabled = asking || goal === ''
    again.disabled = asking
    back.disabled = asking
    goalLine.textContent =
      goal === ''
        ? 'First say or type a goal above, then press "Use this goal".'
        : `Goal: ${goal}`
    ask.textContent = proposal ? 'Suggest another layout' : 'Suggest a new layout'
  }

  async function suggest(): Promise<void> {
    const goal = getLayoutGoal()
    if (asking || goal === '') return
    const mine = ++askToken
    asking = true
    error.textContent = ''
    status.textContent = 'Asking the layout agent… this can take up to a minute.'
    spinner.hidden = false
    refreshAsk()
    try {
      const answer = await getLayout(goal, world, scanId)
      if (mine !== askToken) return
      proposal = answer
      changesView.show(world, answer.changes)
      clearPictures()
      renderResults()
      show(answer.changes.length > 0 ? 'after' : 'before')
      if (!active) toggle.hidden = true
      results.scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    } catch (err) {
      if (mine !== askToken) return
      error.textContent = messageOf(err)
    } finally {
      if (mine === askToken) {
        asking = false
        status.textContent = ''
        spinner.hidden = true
        refreshAsk()
      }
    }
  }

  function backToOriginal(): void {
    askToken++ // an answer still on its way is no longer wanted
    drawToken++
    asking = false
    drawing = false
    proposal = null
    changesView.show(world, [])
    error.textContent = ''
    status.textContent = ''
    spinner.hidden = true
    clearPictures()
    renderResults()
    show('before')
    viewer.showBoxesOnly(false)
    refreshAsk()
  }

  ask.addEventListener('click', () => void suggest())
  again.addEventListener('click', () => void suggest())
  back.addEventListener('click', backToOriginal)

  // ---- Realistic pictures ----
  function clearPictures(): void {
    pictures.replaceChildren()
    pictureWarning.textContent = ''
    drawStatus.textContent = ''
    drawError.textContent = ''
  }

  function renderPhotoControls(): void {
    const canDraw = pretend || scanId !== null
    const moved = proposal !== null && proposal.changes.length > 0
    for (const node of [picTitle, picHint, photoRow, photoName]) node.hidden = !moved
    draw.disabled = drawing || photo === null || !moved || !canDraw
    photoName.textContent = !canDraw
      ? 'Realistic pictures need a room you scanned and uploaded.'
      : photo === null
        ? 'No photo yet.'
        : `Photo: ${photo.name}`
  }

  photoInput.addEventListener('change', () => {
    const file = photoInput.files?.[0]
    photoInput.value = '' // so choosing the same file again still counts
    drawError.textContent = ''
    if (!file) return
    try {
      checkPhoto(file) // HEIC, wrong type, too big: say so straight away
    } catch (err) {
      drawError.textContent = messageOf(err)
      return
    }
    photo = file
    clearPictures()
    renderPhotoControls()
  })

  function picture(url: string, caption: string): HTMLElement {
    const figure = el('figure', 'agent-picture')
    const img = el('img')
    img.alt = `${caption}: the room`
    img.src = url
    img.addEventListener('error', () => {
      img.replaceWith(el('p', 'agent-warning', "This picture couldn't be loaded."))
    })
    figure.append(img, el('figcaption', undefined, caption))
    return figure
  }

  function showPictures(r: RenderResult): void {
    pictures.replaceChildren()
    if (r.beforeUrl === null || r.afterUrl === null) {
      pictureWarning.textContent = 'Realistic images need the live server. (This demo is using the pretend server, which draws nothing.)'
      return
    }
    pictures.append(picture(r.beforeUrl, 'Before'), picture(r.afterUrl, 'After'))
    pictureWarning.textContent = r.likelyChangedTooMuch
      ? 'The AI may have changed more than the moved furniture. Results vary, so try again for a different picture.'
      : ''
  }

  draw.addEventListener('click', async () => {
    if (!proposal || !photo || drawing) return
    const mine = ++drawToken
    drawing = true
    clearPictures()
    drawStatus.textContent = 'Drawing the pictures… this can take a minute.'
    renderPhotoControls()
    try {
      const result = await renderBeforeAfter(scanId, photo, world, proposal.world)
      if (mine !== drawToken) return
      showPictures(result)
    } catch (err) {
      if (mine !== drawToken) return
      drawError.textContent = messageOf(err)
    } finally {
      if (mine === drawToken) {
        drawing = false
        drawStatus.textContent = ''
        renderPhotoControls()
      }
    }
  })

  // ---- The scan-versus-simulation score (A6): real, scanned rooms only ----
  scoreText.textContent = 'How closely our 3D model matches the scanned room.'
  async function loadScore(): Promise<void> {
    if (!pretend && scanId === null) {
      scoreValue.textContent = '–'
      scoreText.textContent = "Match score: only for scanned rooms. The example room wasn't scanned."
      return
    }
    scoreText.textContent = 'Checking how well our 3D model matches the scan…'
    try {
      const s = await getScore(scanId)
      if (disposed) return
      scoreValue.textContent = `${Math.round(s.overallPercent)}%`
      scoreText.textContent =
        'How closely our 3D model matches the scanned room.' +
        (s.pretend ? ' (A pretend number: the demo server is not scoring a real scan.)' : '') +
        (s.warnings.length > 0 ? ` Note: ${s.warnings[0]}` : '')
    } catch (err) {
      if (disposed) return
      scoreValue.textContent = '–'
      scoreText.textContent = `Match score unavailable. ${messageOf(err)}`
    }
  }
  void loadScore()

  // ---- Wiring ----
  const stopWatchingGoal = onLayoutGoalChange((goal) => {
    refreshAsk()
    // On a phone the voice panel is tall: bring the Suggest button into view once there is a goal.
    if (goal !== '' && active) ask.scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  })
  refreshAsk()
  renderPhotoControls()

  return {
    link: (panel) => {
      clearance = panel
      stopWatchingWidth = panel.onChange(() => renderComparison()) // a different person's width: compare again
      renderComparison()
    },
    setActive: (on) => {
      active = on
      if (!on) {
        // The tab is closed: the 3D view goes back to the original room (and the scan picture), the suggestion is kept.
        toggle.hidden = true
        changesView.setVisible(false)
        viewer.setWorld(world, true)
        viewer.showBoxesOnly(false)
        return
      }
      if (proposal) {
        toggle.hidden = proposal.changes.length === 0
        show(showing)
      }
    },
    dispose: () => {
      disposed = true
      askToken++
      drawToken++
      stopWatchingGoal()
      stopWatchingWidth?.()
      changesView.dispose()
      toggle.remove()
      section.remove()
    },
  }
}
