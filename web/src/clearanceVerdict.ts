// Plain-English PASS / FAIL for a clearance result (clearance.ts), and the short "Before / After" line.
// Pure text logic (no page code), so it can be tested on its own: node scripts/test-verdict.ts

import { PERSON_WIDTHS, type ClearanceResult } from './clearance.ts'

export interface Verdict {
  pass: boolean
  /** A sentence, e.g. "Narrowest point 62 cm: too tight for a wheelchair (needs 85 cm)." */
  text: string
}

/** "a wheelchair", "someone with a walker", ... or, for any other width, "a person 0.65 m wide". */
export function whoWords(widthM: number): string {
  const same = (m: number) => Math.abs(m - widthM) < 1e-6
  if (same(PERSON_WIDTHS.walking.widthM)) return 'a person walking'
  if (same(PERSON_WIDTHS.walker.widthM)) return 'someone with a walker'
  if (same(PERSON_WIDTHS.wheelchair.widthM)) return 'a wheelchair'
  return `a person ${widthM.toFixed(2).replace(/0$/, '')} m wide`
}

export function verdict(result: ClearanceResult): Verdict {
  const who = whoWords(result.personWidthM)
  const need = Math.round(result.personWidthM * 100)
  if (result.reachable) {
    return {
      pass: true,
      text:
        result.narrowestGapCm === null
          ? `No tight spots on the way: plenty of room for ${who} (needs ${need} cm).`
          : `Narrowest point ${result.narrowestGapCm} cm: wide enough for ${who} (needs ${need} cm).`,
    }
  }
  const b = result.blockedAt
  switch (b?.reason) {
    case 'gap':
      return { pass: false, text: `Narrowest point ${b.gapCm} cm: too tight for ${who} (needs ${need} cm).` }
    case 'sealed':
      return { pass: false, text: `Furniture closes the goal off completely, so ${who} cannot get there.` }
    case 'start':
      return { pass: false, text: `No room at the start for ${who} (needs ${need} cm).` }
    case 'goal':
      return { pass: false, text: `No room at the goal for ${who} (needs ${need} cm).` }
    default:
      return { pass: false, text: `${who} cannot get from the start to the goal.` }
  }
}

/** "PASS (94 cm)", "PASS (open)" or "FAIL (62 cm)", "FAIL (blocked)": the short form for the Before / After line. */
export function shortVerdict(result: ClearanceResult): string {
  if (result.reachable) return result.narrowestGapCm === null ? 'PASS (open)' : `PASS (${result.narrowestGapCm} cm)`
  const b = result.blockedAt
  return b?.reason === 'gap' && b.gapCm !== null ? `FAIL (${b.gapCm} cm)` : 'FAIL (blocked)'
}

export function beforeAfterLine(before: ClearanceResult, after: ClearanceResult): string {
  return `Before: ${shortVerdict(before)}  |  After: ${shortVerdict(after)}`
}
