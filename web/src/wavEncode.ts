// Turning raw microphone samples into a WAV file. Pure maths: no browser code, so it can be tested alone.
//
// The microphone gives us "samples": a long list of numbers between -1 and 1, one for every tick of
// the sound card's clock (44,100 or 48,000 times a second). The server wants a WAV file that is:
//   - mono         (one channel, not left + right)
//   - 16 kHz       (16,000 samples a second: plenty for speech, and a third of the data)
//   - 16-bit PCM   (each sample is a whole number from -32768 to 32767)
// A WAV file is just a 44-byte "header" saying those facts, followed by the samples.

export const TARGET_RATE = 16_000

/** Average the channels into one. `channels` is e.g. [left, right]; a mono mic is just [samples]. */
export function mixToMono(channels: Float32Array[]): Float32Array {
  const first = channels[0]
  if (!first) return new Float32Array(0)
  if (channels.length === 1) return first
  const out = new Float32Array(first.length)
  for (const channel of channels) {
    for (let i = 0; i < out.length; i++) out[i] += (channel[i] ?? 0) / channels.length
  }
  return out
}

/**
 * Change `samples` recorded at `fromRate` to `toRate` (default 16 kHz). Normally this SHRINKS them (48 kHz -> 16 kHz).
 *
 * Each new sample is the AVERAGE of the old samples that fall inside its time slot. For 48 kHz -> 16 kHz
 * that is the average of 3 old samples. Averaging (rather than just skipping samples) acts as a simple
 * filter that stops high-pitched sounds turning into false low-pitched buzzing ("aliasing").
 * When the rates don't divide evenly (44.1 kHz -> 16 kHz) the old samples at the edges of a slot
 * count only for the part of them that lies inside it.
 */
export function resample(samples: Float32Array, fromRate: number, toRate = TARGET_RATE): Float32Array {
  if (fromRate === toRate) return samples
  if (fromRate < toRate) return stretch(samples, fromRate, toRate)
  const ratio = fromRate / toRate // old samples per new sample, e.g. 3 or 2.75625
  const outLength = Math.floor(samples.length / ratio)
  const out = new Float32Array(outLength)
  for (let i = 0; i < outLength; i++) {
    const start = i * ratio
    const end = start + ratio
    let sum = 0
    let first = Math.floor(start)
    const last = Math.min(Math.ceil(end), samples.length)
    for (; first < last; first++) {
      // How much of old sample `first` (which covers first..first+1) lies inside start..end?
      const overlap = Math.min(first + 1, end) - Math.max(first, start)
      sum += (samples[first] ?? 0) * overlap
    }
    out[i] = sum / ratio
  }
  return out
}

/** The rare opposite case (a microphone slower than 16 kHz): draw straight lines between the old samples. */
function stretch(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  const out = new Float32Array(Math.floor((samples.length * toRate) / fromRate))
  for (let i = 0; i < out.length; i++) {
    const position = (i * fromRate) / toRate
    const before = Math.floor(position)
    const a = samples[before] ?? 0
    const b = samples[before + 1] ?? a
    out[i] = a + (b - a) * (position - before)
  }
  return out
}

/** Float samples (-1..1) -> 16-bit whole numbers (-32768..32767). Louder than the limits is clipped. */
export function floatTo16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const clipped = Math.max(-1, Math.min(1, samples[i] ?? 0))
    out[i] = clipped < 0 ? Math.round(clipped * 32768) : Math.round(clipped * 32767)
  }
  return out
}

function writeText(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
}

/** Build a complete mono 16-bit PCM WAV file from 16-bit samples. */
export function encodeWav(samples: Int16Array, sampleRate = TARGET_RATE): Blob {
  const dataBytes = samples.length * 2 // 2 bytes per 16-bit sample
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)

  // The 44-byte header. All numbers are "little-endian" (the flag `true`).
  writeText(view, 0, 'RIFF') //          this is a RIFF file...
  view.setUint32(4, 36 + dataBytes, true) //  ...of this many more bytes
  writeText(view, 8, 'WAVE') //          ...and it is a WAV
  writeText(view, 12, 'fmt ') //         the "format" section follows
  view.setUint32(16, 16, true) //        ...which is 16 bytes long
  view.setUint16(20, 1, true) //         format 1 = plain PCM (uncompressed)
  view.setUint16(22, 1, true) //         1 channel (mono)
  view.setUint32(24, sampleRate, true) // samples per second
  view.setUint32(28, sampleRate * 2, true) // bytes per second (1 channel x 2 bytes x rate)
  view.setUint16(32, 2, true) //         bytes per sample frame (1 channel x 2 bytes)
  view.setUint16(34, 16, true) //        bits per sample
  writeText(view, 36, 'data') //         the samples follow
  view.setUint32(40, dataBytes, true) // ...this many bytes of them

  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i] ?? 0, true)
  return new Blob([buffer], { type: 'audio/wav' })
}

/** Everything in one go: channels recorded at `rate` Hz -> a 16 kHz mono 16-bit WAV. */
export function samplesToWav(channels: Float32Array[], rate: number): Blob {
  return encodeWav(floatTo16(resample(mixToMono(channels), rate)))
}
