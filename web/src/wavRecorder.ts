// Records the microphone and hands back a WAV file. No libraries: only what the browser provides.
//
// How it works, simply:
//  1. getUserMedia asks the person for permission and gives us a live microphone "stream".
//  2. We plug the stream into the Web Audio system (an "AudioContext"), which turns it into
//     raw samples: tiny chunks of numbers describing the sound wave.
//  3. A small "AudioWorklet" (a mini-program that runs on the browser's audio thread, so it never
//     misses a beat even if the page is busy) copies each chunk and posts it to us. Older browsers
//     that don't have worklets use the older ScriptProcessor, which does the same job.
//  4. We keep all the chunks. When you stop, wavEncode.ts glues them together, mixes to mono,
//     shrinks them to 16 kHz, converts to 16-bit and adds the WAV header.

import { samplesToWav } from './wavEncode.ts'

export type VoiceErrorKind = 'insecure' | 'unsupported' | 'denied' | 'no-mic' | 'busy' | 'too-short' | 'silent' | 'failed'

/** Something went wrong recording. `message` is friendly and safe to show on screen. */
export class VoiceError extends Error {
  kind: VoiceErrorKind

  constructor(kind: VoiceErrorKind, message: string) {
    super(message)
    this.name = 'VoiceError'
    this.kind = kind
  }
}

const MESSAGES: Record<VoiceErrorKind, string> = {
  insecure:
    "Your browser only allows the microphone on secure (HTTPS) pages, and this page isn't secure. Type your goal instead.",
  unsupported: "This browser can't record audio. Type your goal instead.",
  denied:
    "Microphone access is blocked. Allow the microphone for this site in your browser's settings, then try again, or type your goal instead.",
  'no-mic': 'No microphone was found. Plug one in, or type your goal instead.',
  busy: 'The microphone is busy. Close any other app that is using it, then try again.',
  'too-short': 'That was too short. Tap the mic, speak for a moment, then tap stop.',
  silent: "We didn't hear anything. Check your microphone isn't muted, then try again.",
  failed: "Recording didn't work. Type your goal instead.",
}

const voiceError = (kind: VoiceErrorKind) => new VoiceError(kind, MESSAGES[kind])

/** Recordings shorter than this are rejected. */
export const MIN_SECONDS = 0.5
/** Quieter than this (out of 1.0) all the way through means the mic is muted or dead. */
const SILENCE_PEAK = 0.001
/** How long we keep listening after "stop" so the last chunks still in flight arrive. */
const TAIL_MS = 150
const CHUNK = 1024 // samples per message from the worklet (about 20 ms)

// The mini-program for the audio thread, as text (so no extra file is needed). It averages the
// microphone's channels into one and sends us a copy every CHUNK samples.
const WORKLET_CODE = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Float32Array(${CHUNK})
    this.filled = 0
  }
  process(inputs) {
    const channels = inputs[0]
    if (channels && channels.length > 0) {
      const frames = channels[0].length
      for (let i = 0; i < frames; i++) {
        let sum = 0
        for (let c = 0; c < channels.length; c++) sum += channels[c][i]
        this.buffer[this.filled++] = sum / channels.length
        if (this.filled === this.buffer.length) {
          this.port.postMessage(this.buffer.slice(0))
          this.filled = 0
        }
      }
    }
    return true
  }
}
registerProcessor('capture-processor', CaptureProcessor)
`

export interface Recording {
  /** Seconds recorded so far. */
  seconds: () => number
  /** Finish and get the WAV (16 kHz, mono, 16-bit). Rejects with a VoiceError if it is too short or silent. */
  stop: () => Promise<Blob>
  /** Throw the recording away and release the microphone. Safe to call more than once. */
  cancel: () => void
}

function micError(err: unknown): VoiceError {
  const name = err instanceof DOMException ? err.name : ''
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') return voiceError('denied')
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') return voiceError('no-mic')
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return voiceError('busy')
  return voiceError('failed')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Start recording. Call this straight from a tap/click (phones only allow audio after a tap). */
export async function startRecording(): Promise<Recording> {
  // Browsers only offer the microphone on https:// pages (and http://localhost).
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw voiceError(window.isSecureContext ? 'unsupported' : 'insecure')
  }
  if (typeof AudioContext === 'undefined') throw voiceError('unsupported')

  // Make the audio system BEFORE the first `await`: iPhones only let it start while we are still
  // inside the tap that called us.
  const ctx = new AudioContext()
  const resumed = ctx.resume().catch(() => undefined)

  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    })
  } catch (err) {
    void ctx.close()
    throw micError(err)
  }
  await resumed

  const chunks: Float32Array[] = []
  let sampleCount = 0
  const keep = (samples: Float32Array) => {
    chunks.push(samples)
    sampleCount += samples.length
  }

  const source = ctx.createMediaStreamSource(stream)
  // The recorder node must be connected onwards to work in some browsers, so we send it to the
  // speakers through a volume knob turned to zero (otherwise you would hear yourself).
  const silent = ctx.createGain()
  silent.gain.value = 0
  silent.connect(ctx.destination)

  let recorderNode: AudioNode | null = null
  let scriptNode: ScriptProcessorNode | null = null
  try {
    if (!ctx.audioWorklet) throw new Error('no worklet')
    const url = URL.createObjectURL(new Blob([WORKLET_CODE], { type: 'application/javascript' }))
    try {
      await ctx.audioWorklet.addModule(url)
    } finally {
      URL.revokeObjectURL(url)
    }
    const node = new AudioWorkletNode(ctx, 'capture-processor', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 })
    node.port.onmessage = (e: MessageEvent<Float32Array>) => keep(e.data)
    recorderNode = node
  } catch {
    // Fallback for older browsers: the same job with the older ScriptProcessor.
    scriptNode = ctx.createScriptProcessor(4096, 1, 1)
    scriptNode.onaudioprocess = (e: AudioProcessingEvent) => keep(e.inputBuffer.getChannelData(0).slice(0))
    recorderNode = scriptNode
  }
  source.connect(recorderNode)
  recorderNode.connect(silent)

  let released = false
  function release(): void {
    if (released) return
    released = true
    for (const track of stream.getTracks()) track.stop() // this turns off the browser's "recording" light
    if (scriptNode) scriptNode.onaudioprocess = null
    source.disconnect()
    recorderNode?.disconnect()
    silent.disconnect()
    void ctx.close()
  }

  const rate = ctx.sampleRate // usually 48000 or 44100

  return {
    seconds: () => sampleCount / rate,
    cancel: release,
    stop: async () => {
      if (released) throw voiceError('failed')
      await sleep(TAIL_MS)
      release()

      const seconds = sampleCount / rate
      if (seconds < MIN_SECONDS) throw voiceError('too-short')

      const samples = new Float32Array(sampleCount)
      let offset = 0
      for (const chunk of chunks) {
        samples.set(chunk, offset)
        offset += chunk.length
      }
      let peak = 0
      for (const value of samples) peak = Math.max(peak, Math.abs(value))
      if (peak < SILENCE_PEAK) throw voiceError('silent')

      return samplesToWav([samples], rate)
    },
  }
}
