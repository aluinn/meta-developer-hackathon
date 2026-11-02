// The panel on the Layout tab: speak or type what you want done to the room.
// Speaking: tap the mic, talk, tap again -> WAV (wavRecorder.ts) -> server (api.ts) -> text in the box.
// You can edit the text, then press "Use this goal" to store it (layoutGoal.ts).

import { ApiError, transcribe, type LayoutResult } from './api.ts'
import { getLayoutGoal, onLayoutGoalChange, setLayoutGoal } from './layoutGoal.ts'
import { startRecording, VoiceError, type Recording } from './wavRecorder.ts'

const MAX_SECONDS = 60

type State = 'idle' | 'starting' | 'recording' | 'transcribing'

/** What the Rearrange button can do. Only given in Work mode; without it the panel has no Rearrange button. */
export interface RearrangeHooks {
  /** Ask the AI for a new arrangement that meets `goal`. Resolves with the answer, or rejects with an ApiError (plain-English message). */
  request: (goal: string) => Promise<LayoutResult>
  /** Show the room as it is now (before) or as the AI proposes (after). */
  setShowing: (which: 'before' | 'after') => void
  /** Make the proposal the room's current layout (Work mode only). */
  keep: () => void
  /** Go back to the room as it was first loaded, with the scan picture. */
  reset: () => void
}

/** What the panel shows about the current proposal. Null = no proposal and nothing kept. */
export interface ProposalState {
  /** The AI's answer, if there is one that has not been kept yet. */
  result: LayoutResult | null
  showing: 'before' | 'after'
  /** The room is no longer the one that was loaded (a layout was kept), so Reset has something to undo. */
  canReset: boolean
  /** The room has a scan picture, which is hidden while the layout is changed. */
  hasScan: boolean
}

export interface LayoutPanel {
  /** main.ts tells the panel what state the proposal is in (after a request, a toggle, Keep or Reset). */
  setProposal: (state: ProposalState | null) => void
  /** Stop and throw away any recording in progress (keeps what is typed in the box). */
  stopRecording: () => void
  /** Remove the panel and free everything. */
  dispose: () => void
}

// Static icons (our own drawings, not user text).
const ICON_MIC =
  '<svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true"><path fill="currentColor" d="M12 15a4 4 0 0 0 4-4V6a4 4 0 0 0-8 0v5a4 4 0 0 0 4 4zm6-4a1 1 0 1 1 2 0 8 8 0 0 1-7 7.93V21h3a1 1 0 1 1 0 2H8a1 1 0 1 1 0-2h3v-2.07A8 8 0 0 1 4 11a1 1 0 1 1 2 0 6 6 0 0 0 12 0z"/></svg>'
const ICON_STOP =
  '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor"/></svg>'

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function clock(seconds: number): string {
  const whole = Math.floor(seconds)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

export function createLayoutPanel(container: HTMLElement, rearrange?: RearrangeHooks): LayoutPanel {
  const panel = el('div', 'layout-panel')

  // Two halves: speaking (left on wide screens) and the text box (right). Stacked on a phone.
  const speak = el('div', 'layout-speak')
  const write = el('div', 'layout-write')
  speak.append(el('h2', 'layout-title', 'Change the layout'))
  speak.append(el('p', 'layout-hint', 'Say or type what you want, like "make room for a wheelchair".'))

  // ---- Mic button, recording indicator and timer ----
  const micRow = el('div', 'mic-row')
  const mic = el('button', 'mic-btn')
  mic.type = 'button'
  mic.innerHTML = ICON_MIC
  const micLabel = el('span', 'mic-label', 'Tap to speak')
  const indicator = el('div', 'rec-indicator')
  indicator.hidden = true
  const dot = el('span', 'rec-dot')
  dot.setAttribute('aria-hidden', 'true')
  const timer = el('span', 'rec-timer', `0:00 / ${clock(MAX_SECONDS)}`)
  indicator.append(dot, el('span', undefined, 'Recording'), timer)
  const micText = el('div', 'mic-text')
  micText.append(micLabel, indicator)
  micRow.append(mic, micText)

  // ---- Messages: progress (polite) and problems (alert) ----
  const status = el('p', 'layout-status')
  status.setAttribute('role', 'status')
  const error = el('p', 'error')
  error.setAttribute('role', 'alert')

  // ---- Text box: the typed fallback, and where the transcript appears ----
  const labelText = el('label', 'layout-label', 'Your goal (you can edit it)')
  const box = el('textarea', 'goal-box')
  box.id = 'goal-box'
  box.rows = 3
  box.maxLength = 500
  box.placeholder = 'e.g. Make room for a wheelchair'
  labelText.htmlFor = box.id

  const use = el('button', 'btn btn-primary', 'Use this goal')
  use.type = 'button'
  use.disabled = true
  const current = el('p', 'goal-current')
  current.setAttribute('aria-live', 'polite')

  // Development only: lets you play back the WAV to check it sounds right.
  const download = el('a', 'download-link', 'Download my recording (dev only)')
  download.hidden = true

  // ---- Rearrange (Work mode): ask the AI to move things to meet the goal ----
  const rearrangeBox = el('div', 'rearrange')
  const rearrangeButton = el('button', 'btn btn-secondary', 'Rearrange the room')
  rearrangeButton.type = 'button'
  rearrangeButton.disabled = true
  const rearrangeStatus = el('p', 'layout-status')
  rearrangeStatus.setAttribute('role', 'status')
  const rearrangeError = el('p', 'error')
  rearrangeError.setAttribute('role', 'alert')
  const proposalBox = el('div', 'proposal')
  rearrangeBox.append(rearrangeButton, rearrangeStatus, rearrangeError, proposalBox)

  speak.append(micRow, status, error)
  write.append(labelText, box, use, current)
  if (rearrange) write.append(rearrangeBox)
  write.append(download)
  panel.append(speak, write)
  container.append(panel)

  // ---- Logic ----
  let state: State = 'idle'
  let recording: Recording | null = null
  let timerId: number | null = null
  let token = 0 // bumped on cancel, so an answer that arrives late is ignored
  let downloadUrl: string | null = null
  let asking = false // a Rearrange request is in progress
  let rearrangeToken = 0 // bumped on dispose, so an answer that arrives late is ignored

  function setState(next: State): void {
    state = next
    mic.disabled = next === 'starting' || next === 'transcribing'
    mic.classList.toggle('recording', next === 'recording')
    mic.setAttribute('aria-pressed', String(next === 'recording'))
    mic.setAttribute('aria-label', next === 'recording' ? 'Stop recording' : 'Start recording')
    mic.innerHTML = next === 'recording' ? ICON_STOP : ICON_MIC
    indicator.hidden = next !== 'recording'
    micLabel.hidden = next === 'recording'
    micLabel.textContent = { idle: 'Tap to speak', starting: 'Starting…', recording: '', transcribing: 'Transcribing…' }[next]
    status.textContent = { idle: '', starting: 'Allow the microphone if asked.', recording: 'Listening. Tap the button when you are done.', transcribing: 'Transcribing...' }[next]
  }

  function showError(err: unknown): void {
    error.textContent =
      err instanceof VoiceError || err instanceof ApiError ? err.message : 'Something went wrong. Type your goal instead.'
  }

  function stopTimer(): void {
    if (timerId !== null) window.clearInterval(timerId)
    timerId = null
  }

  function offerDownload(wav: Blob): void {
    if (!import.meta.env.DEV) return
    if (downloadUrl) URL.revokeObjectURL(downloadUrl)
    downloadUrl = URL.createObjectURL(wav)
    download.href = downloadUrl
    download.download = 'my-recording.wav'
    download.hidden = false
  }

  async function begin(): Promise<void> {
    const mine = ++token
    error.textContent = ''
    setState('starting')
    try {
      const rec = await startRecording() // this call must start straight from the tap
      if (mine !== token) {
        rec.cancel()
        return
      }
      recording = rec
      setState('recording')
      timer.textContent = `0:00 / ${clock(MAX_SECONDS)}`
      timerId = window.setInterval(() => {
        const seconds = rec.seconds()
        timer.textContent = `${clock(Math.min(seconds, MAX_SECONDS))} / ${clock(MAX_SECONDS)}`
        if (seconds >= MAX_SECONDS) void finish(true)
      }, 200)
    } catch (err) {
      if (mine !== token) return
      setState('idle')
      showError(err)
    }
  }

  async function finish(hitLimit = false): Promise<void> {
    const rec = recording
    if (!rec) return
    recording = null
    stopTimer()
    const mine = token
    setState('transcribing')
    if (hitLimit) status.textContent = 'Reached 60 seconds, so we stopped. Transcribing...'
    try {
      const wav = await rec.stop()
      if (mine !== token) return
      offerDownload(wav)
      const text = await transcribe(wav)
      if (mine !== token) return
      setState('idle')
      if (text === '') {
        error.textContent = "We couldn't make out any words. Try again, or type your goal instead."
        return
      }
      box.value = text
      use.disabled = false
      status.textContent = 'Here is what we heard. Edit it if you like, then press "Use this goal".'
      box.focus({ preventScroll: true })
    } catch (err) {
      if (mine !== token) return
      setState('idle')
      showError(err)
    }
  }

  mic.addEventListener('click', () => {
    if (state === 'idle') void begin()
    else if (state === 'recording') void finish()
  })

  box.addEventListener('input', () => {
    use.disabled = box.value.trim() === ''
  })

  use.addEventListener('click', () => {
    setLayoutGoal(box.value)
  })

  function showCurrentGoal(goal: string): void {
    current.textContent = goal === '' ? 'No layout goal chosen yet.' : `Layout goal: ${goal}`
    rearrangeButton.disabled = goal === '' || asking
  }
  showCurrentGoal(getLayoutGoal())
  const stopListening = onLayoutGoalChange(showCurrentGoal)
  setState('idle')

  // ---- Rearrange: the request, and showing the answer ----
  const cm = (m: number) => `${Math.round(m * 100)} cm`
  const walkableWords = (v: boolean | null) => (v === null ? 'could not tell' : v ? 'a path is open' : 'no clear path')

  function showProposal(state: ProposalState | null): void {
    proposalBox.replaceChildren()
    if (!state) return
    const { result, showing, canReset, hasScan } = state
    if (result) {
      proposalBox.append(el('h3', 'proposal-title', 'Proposed layout'))
      proposalBox.append(el('p', 'proposal-phone-hint', 'On a small screen: press the Layout tab again to see the room in 3D, with the moved things outlined in pink.'))
      const toggle = el('div', 'proposal-toggle')
      toggle.setAttribute('role', 'group')
      toggle.setAttribute('aria-label', 'Which layout to show')
      for (const which of ['before', 'after'] as const) {
        const b = el('button', 'btn btn-small', which === 'before' ? 'Before' : 'After')
        b.type = 'button'
        b.setAttribute('aria-pressed', String(showing === which))
        b.addEventListener('click', () => rearrange?.setShowing(which))
        toggle.append(b)
      }
      proposalBox.append(toggle)
      if (result.changes.length === 0) {
        proposalBox.append(el('p', 'proposal-none', 'The AI made no changes.'))
      } else {
        const list = el('ul', 'proposal-changes')
        for (const c of result.changes) {
          const moved = Math.hypot(c.to.position[0] - c.from.position[0], c.to.position[2] - c.from.position[2])
          const li = el('li')
          li.append(el('strong', undefined, `${c.label}: moved ${cm(moved)}`), el('span', undefined, c.reason))
          list.append(li)
        }
        proposalBox.append(list)
      }
      if (result.notes) proposalBox.append(el('p', 'proposal-notes', `Notes from the AI: ${result.notes}`))
      const walk = result.spawnToGoalWalkable
      proposalBox.append(el('p', 'proposal-walk', `Quick check, start to goal: before, ${walkableWords(walk.before)}; after, ${walkableWords(walk.after)}.`))
      const actions = el('div', 'proposal-actions')
      if (result.changes.length > 0) {
        const keep = el('button', 'btn btn-primary', 'Keep this layout')
        keep.type = 'button'
        keep.addEventListener('click', () => rearrange?.keep())
        actions.append(keep)
      }
      proposalBox.append(actions)
    } else if (canReset) {
      proposalBox.append(el('p', 'proposal-none', `You are looking at your changed layout.${hasScan ? ' The scan picture is hidden because the scan cannot move.' : ''}`))
    }
    if (canReset) {
      const reset = el('button', 'btn btn-small', 'Reset to the original room')
      reset.type = 'button'
      reset.addEventListener('click', () => rearrange?.reset())
      proposalBox.append(reset)
    }
  }

  rearrangeButton.addEventListener('click', async () => {
    const goal = getLayoutGoal()
    if (!rearrange || asking || goal === '') return
    const mine = rearrangeToken
    asking = true
    rearrangeButton.disabled = true
    rearrangeError.textContent = ''
    rearrangeStatus.textContent = 'Asking the AI to rearrange the room… this can take up to a minute.'
    proposalBox.setAttribute('aria-busy', 'true')
    try {
      await rearrange.request(goal) // main.ts shows the answer and calls setProposal
      if (mine === rearrangeToken) proposalBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    } catch (err) {
      if (mine !== rearrangeToken) return
      rearrangeError.textContent = err instanceof ApiError ? err.message : 'Something went wrong. Please try again.'
    } finally {
      if (mine === rearrangeToken) {
        asking = false
        rearrangeStatus.textContent = ''
        proposalBox.removeAttribute('aria-busy')
        rearrangeButton.disabled = getLayoutGoal() === ''
      }
    }
  })
  showCurrentGoal(getLayoutGoal())

  function stopRecording(): void {
    token++
    stopTimer()
    recording?.cancel()
    recording = null
    setState('idle')
    error.textContent = ''
  }

  return {
    setProposal: showProposal,
    stopRecording,
    dispose: () => {
      rearrangeToken++
      stopRecording()
      stopListening()
      if (downloadUrl) URL.revokeObjectURL(downloadUrl)
      panel.remove()
    },
  }
}
