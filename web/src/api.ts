// Talks to our server (see docs/architecture.md). Addresses are RELATIVE ("/scan", not "http://localhost:8000/scan"):
// in production the server also serves this page, and in development Vite forwards these paths (vite.config.ts).

import { USE_FAKE_SERVER } from './config.ts'
import { parseWorld, type World } from './world.ts'

const MAX_SCAN_BYTES = 100 * 1024 * 1024 // the server's limit
const SCAN_EXTENSIONS = ['.glb', '.obj']
const STEP_TIMEOUT_MS = 5 * 60 * 1000 // for one request: an upload, or waking a sleeping free server (about a minute)
const POLL_TIMEOUT_MS = 30 * 1000
const MAX_PROCESS_MS = 10 * 60 * 1000 // give up on a job after this long
const MAX_POLL_FAILURES = 5 // in a row; a single dropped request is fine
let pollIntervalMs = 2000

let apiBase = ''
/** For tests only: how often to ask the server for progress. */
export function setPollInterval(ms: number): void {
  pollIntervalMs = ms
}
/** For tests only: where the server is, when the page is not served by it. */
export function setApiBase(base: string): void {
  apiBase = base.replace(/\/$/, '')
}

/** An error whose message is already written for the person using the app. */
export class ApiError extends Error {
  /** The HTTP status when the server answered with an error. */
  status?: number
}

/** Turn a failed response into a plain-English message. */
async function explain(res: Response, showServerMessage = false): Promise<string> {
  let detail = ''
  try {
    const body: unknown = await res.json()
    const d = typeof body === 'object' && body !== null ? (body as { detail?: unknown }).detail : undefined
    if (typeof d === 'string') detail = d
    else if (Array.isArray(d)) detail = d.map((x) => (x as { msg?: string }).msg ?? '').join('; ')
    else if (typeof d === 'object' && d !== null) detail = String((d as { message?: unknown }).message ?? '')
  } catch {
    // the body was not JSON; fall through to the generic messages
  }
  if (res.status === 413) return 'That file is too big. The limit is 100 MB.'
  // 502/503/504 with no message from our server come from the hosting layer: the server is restarting, waking up or overloaded.
  if ([502, 503, 504].includes(res.status) && !detail) {
    return 'The server is busy or restarting. Wait a minute and try again.'
  }
  if (res.status === 429 && !detail) return 'Too many requests. Please wait a minute and try again.'
  if (showServerMessage && detail) return detail // for endpoints whose messages are already written for the player
  if (res.status === 503) return 'The server is not set up to use the AI service yet (no API key).'
  if (res.status === 502) return 'The AI service had a problem. Please try again in a moment.'
  if (res.status === 422 && /no objects/i.test(detail)) {
    return "We couldn't find any furniture we recognise in this scan. A clearer scan of a smaller room works best."
  }
  if (res.status === 422 && /could not read the mesh|no triangles/i.test(detail)) {
    return "We couldn't read that scan file. Try exporting it again as GLB."
  }
  return detail || `The server returned an error (${res.status}).`
}

async function request(path: string, init: RequestInit = {}, timeoutMs = STEP_TIMEOUT_MS, showServerMessage = false): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(apiBase + path, { ...init, signal: controller.signal })
    if (!res.ok) {
      const error = new ApiError(await explain(res, showServerMessage))
      error.status = res.status
      throw error
    }
    return res
  } catch (err) {
    if (err instanceof ApiError) throw err
    if (err instanceof Error && err.name === 'AbortError') throw new ApiError('The server took too long to answer. Please try again.')
    throw new ApiError('Could not reach the server. Check your connection and try again.')
  } finally {
    clearTimeout(timer)
  }
}

/** Check a chosen file before sending it, so mistakes get a clear message straight away. */
export function checkScanFile(file: { name: string; size: number }): void {
  const name = file.name.toLowerCase()
  if (!SCAN_EXTENSIONS.some((ext) => name.endsWith(ext))) {
    throw new ApiError("That file type isn't supported yet. Export your scan as GLB (or OBJ) and choose that file.")
  }
  if (file.size > MAX_SCAN_BYTES) throw new ApiError('That file is too big. The limit is 100 MB.')
  if (file.size === 0) throw new ApiError('That file is empty.')
}

interface JobStatus {
  state: 'queued' | 'running' | 'done' | 'error'
  step: string
  percent: number
  error_kind: string | null
}

function progressMessage(status: JobStatus): string {
  if (status.state === 'queued') return 'Waiting for the server…'
  if (status.step === 'rendering') return 'Preparing your scan…'
  if (status.step === 'labelling') return `Looking for furniture… ${status.percent}%`
  if (status.step === 'roles') return 'Working out what each thing is…'
  return 'Working…'
}

function jobError(kind: string | null): ApiError {
  switch (kind) {
    case 'no_key':
      return new ApiError('The server is not set up to use the AI service yet (no API key).')
    case 'no_objects':
      return new ApiError("We couldn't find any furniture we recognise in this scan. A clearer scan of a smaller room works best.")
    case 'ai_service':
      return new ApiError('The AI service had a problem. Please try again in a moment.')
    case 'out_of_memory':
      return new ApiError('That scan is too big for the free server to process. Try a smaller or simpler scan.')
    default:
      return new ApiError('Something went wrong while processing your scan. Please try again.')
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Ask the server how the background job is doing, every couple of seconds, until it finishes or fails. */
async function waitForJob(scanId: string, onStatus: (message: string) => void): Promise<void> {
  const started = Date.now()
  let failuresInARow = 0
  let lastMessage = ''
  for (;;) {
    if (Date.now() - started > MAX_PROCESS_MS) throw new ApiError('This is taking too long. Please try again.')
    let status: JobStatus
    try {
      status = (await (await request(`/scan/${scanId}/status`, {}, POLL_TIMEOUT_MS)).json()) as JobStatus
      failuresInARow = 0
    } catch (err) {
      // 404 = the server forgot the job, which means it restarted (the free plan restarts after being idle).
      if (err instanceof ApiError && err.status === 404) {
        throw new ApiError('The server restarted while working on your scan (the free plan does this when idle). Please try again.')
      }
      if (++failuresInARow >= MAX_POLL_FAILURES) throw err
      await sleep(pollIntervalMs)
      continue
    }
    if (status.state === 'error') throw jobError(status.error_kind)
    if (status.state === 'done') return
    const message = progressMessage(status)
    if (message !== lastMessage) onStatus((lastMessage = message))
    await sleep(pollIntervalMs)
  }
}

/**
 * The whole trip: upload the scan, start the background job (find the furniture, work out what each thing does), follow its
 * progress, and fetch the finished world.json. `onStatus` is called with a short message whenever the step changes (shown on the Loading screen).
 */
export async function processScan(file: File, onStatus: (message: string) => void): Promise<World> {
  checkScanFile(file)

  onStatus('Uploading your scan…')
  const form = new FormData()
  form.append('file', file, file.name)
  const uploaded = (await (await request('/scan', { method: 'POST', body: form })).json()) as { scan_id?: string }
  const scanId = uploaded.scan_id
  if (!scanId) throw new ApiError('The server did not accept the scan.')

  // This returns at once; the work happens on the server in the background, so no single request has to last a minute or two.
  await request(`/scan/${scanId}/process`, { method: 'POST' })
  await waitForJob(scanId, onStatus)

  onStatus('Building your room…')
  const world = (await request(`/world/${scanId}`)).json()
  return parseWorld(await world)
}

const CHARACTER_TIMEOUT_MS = 150 * 1000 // drawing takes about 20 seconds, but a busy server can be slower

function bytesToDataUrl(bytes: ArrayBuffer, type: string): string {
  const view = new Uint8Array(bytes)
  let binary = ''
  for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode(...view.subarray(i, i + 0x8000))
  return `data:${type};base64,${btoa(binary)}`
}

/** Ask the server to draw an original character from a short description. Returns the picture as a data: URL (a transparent PNG). */
export async function generateCharacter(description: string): Promise<string> {
  const text = description.trim()
  if (text.length < 3 || text.length > 80) throw new ApiError('Describe your character in 3 to 80 characters.')
  const res = await request('/character', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: text }) }, CHARACTER_TIMEOUT_MS, true)
  return bytesToDataUrl(await res.arrayBuffer(), 'image/png')
}

// ---- Voice: turn a recording into text (Z5) ----

const FAKE_TRANSCRIPT = 'Move the coffee table next to the sofa so a wheelchair can get through'
const TRANSCRIBE_TIMEOUT_MS = 60 * 1000

const VOICE_NOT_REACHED =
  "Couldn't reach the server. Is it running? (If it was asleep, try again in a minute.) You can still type your goal instead."

/** Turn a /transcribe error code into a sentence for a person. The codes are from the server's contract (docs/architecture.md). */
export function transcribeErrorMessage(status: number): string {
  switch (status) {
    case 400:
      return 'The recording was empty. Check your microphone and try again, or type your goal instead.'
    case 413:
      return 'That recording is too big to send. Try a shorter one, or type your goal instead.'
    case 415:
      return "The server couldn't read that audio. Try again, or type your goal instead."
    case 502:
      return 'The voice service had a problem. Try again in a moment, or type your goal instead.'
    case 503:
      return "Voice isn't set up on the server yet, so type your goal instead."
    default:
      return `Something went wrong talking to the server (error ${status}). Type your goal instead.`
  }
}

function voiceError(message: string, status = 0): ApiError {
  const error = new ApiError(message)
  error.status = status
  return error
}

/** Send a recording (a 16 kHz mono WAV) to the server and get back what was said. */
export async function transcribe(wav: Blob): Promise<string> {
  if (USE_FAKE_SERVER) {
    await sleep(1000)
    return FAKE_TRANSCRIPT
  }

  // The server expects a form with ONE file field called "audio".
  const form = new FormData()
  form.append('audio', wav, 'recording.wav')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(apiBase + '/transcribe', { method: 'POST', body: form, signal: controller.signal })
  } catch {
    throw voiceError(VOICE_NOT_REACHED) // no network, the server is down, or it took too long
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    // The server always explains its own errors in a JSON body like {"detail": "..."}. A server error WITHOUT that
    // comes from the Vite proxy (nothing listening on port 8000) or a host that is asleep or restarting.
    const body: unknown = await response.json().catch(() => null)
    const fromServer = typeof body === 'object' && body !== null && 'detail' in body
    const message = !fromServer && response.status >= 500 ? VOICE_NOT_REACHED : transcribeErrorMessage(response.status)
    throw voiceError(message, response.status)
  }

  // A good answer looks like {"transcript": "...", "duration_ms": 1234}. duration_ms can be null.
  const data: unknown = await response.json().catch(() => null)
  if (typeof data !== 'object' || data === null || !('transcript' in data) || typeof data.transcript !== 'string') {
    throw voiceError("The server's answer wasn't what we expected. Type your goal instead.", response.status)
  }
  return data.transcript.trim()
}
