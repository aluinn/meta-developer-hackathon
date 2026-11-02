// Talks to our server (see docs/architecture.md). Addresses are RELATIVE ("/scan", not "http://localhost:8000/scan"):
// in production the server also serves this page, and in development Vite forwards these paths (vite.config.ts).

import { parseWorld, type World } from './world.ts'

const MAX_SCAN_BYTES = 100 * 1024 * 1024 // the server's limit
const SCAN_EXTENSIONS = ['.glb', '.obj']
const STEP_TIMEOUT_MS = 5 * 60 * 1000 // the labelling step takes about a minute; a sleeping free server takes about a minute more to wake

let apiBase = ''
/** For tests only: where the server is, when the page is not served by it. */
export function setApiBase(base: string): void {
  apiBase = base.replace(/\/$/, '')
}

/** An error whose message is already written for the person using the app. */
export class ApiError extends Error {}

/** Turn a failed response into a plain-English message. */
async function explain(res: Response): Promise<string> {
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

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), STEP_TIMEOUT_MS)
  try {
    const res = await fetch(apiBase + path, { ...init, signal: controller.signal })
    if (!res.ok) throw new ApiError(await explain(res))
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

/**
 * The whole trip: upload the scan, find the furniture, work out what each thing does, and fetch the finished world.json.
 * `onStatus` is called with a short message before each step (shown on the Loading screen).
 */
export async function processScan(file: File, onStatus: (message: string) => void): Promise<World> {
  checkScanFile(file)

  onStatus('Uploading your scan…')
  const form = new FormData()
  form.append('file', file, file.name)
  const uploaded = (await (await request('/scan', { method: 'POST', body: form })).json()) as { scan_id?: string }
  const scanId = uploaded.scan_id
  if (!scanId) throw new ApiError('The server did not accept the scan.')

  onStatus('Looking for furniture… this takes about a minute')
  await request(`/scan/${scanId}/label`, { method: 'POST' })

  onStatus('Working out what each thing is…')
  await request(`/scan/${scanId}/world`, { method: 'POST' })

  onStatus('Building your room…')
  const world = (await request(`/world/${scanId}`)).json()
  return parseWorld(await world)
}
