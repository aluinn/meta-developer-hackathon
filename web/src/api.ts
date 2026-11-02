// The ONLY file that talks to the server. Everything else calls the functions in here.
//
// Paths are RELATIVE (like "/transcribe", never "http://localhost:8000/..."). In production the server
// serves the website and the API from one address, so relative paths just work. While developing,
// Vite (vite.config.ts) forwards these paths from port 5173 to the server on port 8000.

import { USE_FAKE_SERVER } from './config.ts'

/** A problem talking to the server. `message` is friendly and safe to show on screen. */
export class ApiError extends Error {
  status: number // the HTTP status code, or 0 if the server could not be reached at all

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

const FAKE_TRANSCRIPT = 'Move the coffee table next to the sofa so a wheelchair can get through'

const NOT_REACHED =
  "Couldn't reach the server. Is it running? (If it was asleep, try again in a minute.) You can still type your goal instead."

/** Turn a /transcribe error code into a sentence for a person. Codes are from Aluinn's contract. */
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

  let response: Response
  try {
    response = await fetch('/transcribe', { method: 'POST', body: form })
  } catch {
    throw new ApiError(0, NOT_REACHED) // no network, or the server is down
  }
  if (!response.ok) {
    // Aluinn's server always explains an error in a JSON body like {"detail": "..."}. A server error
    // WITHOUT that is not from his code: the Vite proxy (nothing listening on port 8000) or a host that is
    // asleep or restarting. Say "can't reach it" rather than blame the voice service.
    const body: unknown = await response.json().catch(() => null)
    const fromServer = typeof body === 'object' && body !== null && 'detail' in body
    const message = !fromServer && response.status >= 500 ? NOT_REACHED : transcribeErrorMessage(response.status)
    throw new ApiError(response.status, message)
  }

  // A good answer looks like {"transcript": "...", "duration_ms": 1234}. duration_ms can be null.
  const data: unknown = await response.json().catch(() => null)
  if (typeof data !== 'object' || data === null || !('transcript' in data) || typeof data.transcript !== 'string') {
    throw new ApiError(response.status, "The server's answer wasn't what we expected. Type your goal instead.")
  }
  return data.transcript.trim()
}
