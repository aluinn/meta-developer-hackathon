// The panel on the Layout tab: speak or type what you want done to the room.
// Speaking: tap the mic, talk, tap again -> WAV (wavRecorder.ts) -> server (api.ts) -> text in the box.
// You can edit the text, then press "Use this goal" to store it (layoutGoal.ts).

import { ApiError, transcribe } from './api.ts'
import { getLayoutGoal, onLayoutGoalChange, setLayoutGoal } from './layoutGoal.ts'
import { startRecording, VoiceError, type Recording } from './wavRecorder.ts'

const MAX_SECONDS = 60

type State = 'idle' | 'starting' | 'recording' | 'transcribing'

export interface LayoutPanel {
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

export function createLayoutPanel(container: HTMLElement): LayoutPanel {
  const panel = el('div', 'layout-panel')

  panel.append(el('h2', 'layout-title', 'Change the layout'))
  panel.append(el('p', 'layout-hint', 'Say or type what you want, like "make room for a wheelchair".'))

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

  panel.append(micRow, status, error, labelText, box, use, current, download)
  container.append(panel)

  // ---- Logic ----
  let state: State = 'idle'
  let recording: Recording | null = null
  let timerId: number | null = null
  let token = 0 // bumped on cancel, so an answer that arrives late is ignored
  let downloadUrl: string | null = null

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
  }
  showCurrentGoal(getLayoutGoal())
  const stopListening = onLayoutGoalChange(showCurrentGoal)
  setState('idle')

  function stopRecording(): void {
    token++
    stopTimer()
    recording?.cancel()
    recording = null
    setState('idle')
    error.textContent = ''
  }

  return {
    stopRecording,
    dispose: () => {
      stopRecording()
      stopListening()
      if (downloadUrl) URL.revokeObjectURL(downloadUrl)
      panel.remove()
    },
  }
}
