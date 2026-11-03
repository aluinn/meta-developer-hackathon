// Talks to our server (see docs/architecture.md). Addresses are RELATIVE ("/scan", not "http://localhost:8000/scan"):
// in production the server also serves this page, and in development Vite forwards these paths (vite.config.ts).

import { USE_FAKE_SERVER } from './config.ts'
import { FAKE_LAYOUT_MS, parseLayoutResponse, proposeFakeLayout, type LayoutResult, type RenderResult, type ScoreResult } from './layoutAgent.ts'
import { parseWorld, type World } from './world.ts'

const MAX_SCAN_BYTES = 100 * 1024 * 1024 // the server's limit
const SCAN_EXTENSIONS = ['.glb', '.obj']
const STEP_TIMEOUT_MS = 5 * 60 * 1000 // for one request: an upload, or waking a sleeping free server (about a minute)
const POLL_TIMEOUT_MS = 30 * 1000
const MAX_PROCESS_MS = 10 * 60 * 1000 // give up on a job after this long
const MAX_POLL_FAILURES = 5 // in a row; a single dropped request is fine
let pollIntervalMs = 2000

let apiBase = ''
// Whether to pretend to be the server (config.ts). Tests can flip it with setFakeServer.
let fake = USE_FAKE_SERVER
/** For tests only: pretend to be the server (true) or really call it (false). */
export function setFakeServer(on: boolean): void {
  fake = on
}
/** Is the pretend server on? (The screens say so next to numbers the pretend server made up.) */
export function isFakeServer(): boolean {
  return fake
}
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
  if (fake) {
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

// ---- Layout agent, before/after pictures and the scan score (Z6) ----

const LAYOUT_TIMEOUT_MS = 120 * 1000 // the AI can take 20 seconds or more
const RENDER_TIMEOUT_MS = 180 * 1000 // drawing a picture is slower still
const SCORE_TIMEOUT_MS = 90 * 1000 // the first score for a scan has to render it from 8 cameras
const MAX_PHOTO_BYTES = 15 * 1024 * 1024 // the server's limit
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp']

/** Sent to /layout for rooms that were not scanned (the examples); the server only needs it to look like an id when the room is sent too. */
const NO_SCAN_ID = '0'.repeat(32)
export const NOT_SCANNED =
  "This room wasn't scanned, so the server doesn't know it. Layout suggestions and the match score need a room you scanned and uploaded."
const SCAN_FORGOTTEN =
  'The server no longer has this scan (the free server forgets scans when it restarts). Upload the scan again.'

/** Messages for the statuses we have something better to say about. Anything else falls back to the general wording in explain(). */
export const LAYOUT_ERRORS: Record<number, string> = {
  404: SCAN_FORGOTTEN,
  422: "The layout agent's suggestion didn't pass our checks, so nothing was changed. Try again, or word your goal differently.",
}
export const RENDER_ERRORS: Record<number, string> = {
  404: SCAN_FORGOTTEN,
  413: 'That photo is too big. The limit is 15 MB.',
  415: "We couldn't read that photo. Use a JPEG, PNG or WebP picture (iPhone HEIC photos don't work).",
  422: "We can't draw this one: it only works when furniture was moved (and nothing added or removed). Try a different layout.",
}
export const SCORE_ERRORS: Record<number, string> = {
  404: 'No match score yet: the scan has to be fully processed (labelled) first.',
}

/** Like request(), but says something specific for the statuses in `messages`. */
async function endpoint(path: string, init: RequestInit, timeoutMs: number, messages: Record<number, string>): Promise<Response> {
  try {
    return await request(path, init, timeoutMs)
  } catch (err) {
    const text = err instanceof ApiError && err.status !== undefined ? messages[err.status] : undefined
    if (!text) throw err
    const replaced = new ApiError(text)
    replaced.status = (err as ApiError).status
    throw replaced
  }
}

/** The server's answer, read as JSON, or a friendly error if it isn't. */
async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    throw new ApiError("The server's answer wasn't what we expected. Please try again.")
  }
}

/**
 * Ask the layout agent to rearrange the room for a goal (POST /layout). `scanId` is the scan the room came from (scanIdOf(world));
 * a built-in room (no scan) is sent with a placeholder id. Only movable objects move.
 */
export async function getLayout(goal: string, world: World, scanId: string | null): Promise<LayoutResult> {
  const text = goal.trim()
  if (text.length < 3) throw new ApiError('Say or type a goal first, like "make room for a wheelchair".')
  if (fake) {
    await sleep(FAKE_LAYOUT_MS)
    return proposeFakeLayout(world, text)
  }
  // The whole room is sent along, so the server does not need to know the scan: a built-in room gets a placeholder id.
  const body = JSON.stringify({ scan_id: scanId ?? NO_SCAN_ID, goal: text, world })
  const res = await endpoint('/layout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }, LAYOUT_TIMEOUT_MS, LAYOUT_ERRORS)
  try {
    return parseLayoutResponse(await readJson(res), text)
  } catch (err) {
    if (err instanceof ApiError) throw err
    throw new ApiError("The layout agent's answer wasn't what we expected. Please try again.")
  }
}

/** Check a chosen photo before sending it, so mistakes get a clear message straight away. */
export function checkPhoto(file: { name: string; size: number; type: string }): void {
  const name = file.name.toLowerCase()
  if (/\.(heic|heif)$/.test(name) || /hei[cf]/.test(file.type)) {
    throw new ApiError("iPhone HEIC photos aren't supported. Take the photo as JPEG (Settings > Camera > Formats > Most Compatible) or choose a JPEG, PNG or WebP picture.")
  }
  const okType = PHOTO_TYPES.includes(file.type) || (file.type === '' && /\.(jpe?g|png|webp)$/.test(name))
  if (!okType) throw new ApiError('Please choose a JPEG, PNG or WebP picture.')
  if (file.size === 0) throw new ApiError('That photo is empty.')
  if (file.size > MAX_PHOTO_BYTES) throw new ApiError(RENDER_ERRORS[413])
}

/** Ask for realistic before and after pictures of the moved furniture, from a photo of the room (POST /render). */
export async function renderBeforeAfter(scanId: string | null, photo: File, oldWorld: World, newWorld: World): Promise<RenderResult> {
  checkPhoto(photo)
  if (fake) {
    await sleep(800)
    return { beforeUrl: null, afterUrl: null, moved: [], changedFraction: null, likelyChangedTooMuch: false } // the pretend server draws nothing
  }
  if (!scanId) throw new ApiError(NOT_SCANNED)
  const form = new FormData()
  form.append('scan_id', scanId)
  form.append('photo', photo, photo.name)
  form.append('old_world', JSON.stringify(oldWorld))
  form.append('new_world', JSON.stringify(newWorld))
  const res = await endpoint('/render', { method: 'POST', body: form }, RENDER_TIMEOUT_MS, RENDER_ERRORS)
  const data = await readJson(res)
  const d = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {}
  if (typeof d.before_url !== 'string' || typeof d.after_url !== 'string') {
    throw new ApiError("The server's answer wasn't what we expected. Please try again.")
  }
  const stamp = `?t=${Date.now()}` // the same address is reused for every render, so ask the browser not to show an old picture
  const moved = Array.isArray(d.moved)
    ? d.moved.flatMap((m: unknown) => {
        const o = typeof m === 'object' && m !== null ? (m as Record<string, unknown>) : {}
        return typeof o.id === 'string' ? [{ id: o.id, label: typeof o.label === 'string' ? o.label : o.id }] : []
      })
    : []
  return {
    beforeUrl: apiBase + d.before_url + stamp,
    afterUrl: apiBase + d.after_url + stamp,
    moved,
    changedFraction: typeof d.changed_fraction === 'number' ? d.changed_fraction : null,
    likelyChangedTooMuch: d.likely_changed_too_much === true,
  }
}

/** How closely our 3D model matches the scanned room (GET /score/{scan_id}). Only for a real, labelled scan. */
export async function getScore(scanId: string | null): Promise<ScoreResult> {
  if (fake) {
    await sleep(600)
    return { overallPercent: 72, warnings: [], pretend: true }
  }
  if (!scanId) throw new ApiError(NOT_SCANNED)
  const data = await readJson(await endpoint(`/score/${scanId}`, {}, SCORE_TIMEOUT_MS, SCORE_ERRORS))
  const d = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {}
  if (typeof d.overall_percent !== 'number') throw new ApiError("The server's answer wasn't what we expected. Please try again.")
  const warnings = Array.isArray(d.warnings) ? d.warnings.filter((w): w is string => typeof w === 'string') : []
  return { overallPercent: d.overall_percent, warnings, pretend: false }
}
