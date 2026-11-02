// Offline test of the PASS / FAIL words (src/clearanceVerdict.ts). Run from /web: node scripts/test-verdict.ts
import { checkClearance, PERSON_WIDTHS } from '../src/clearance.ts'
import { beforeAfterLine, shortVerdict, verdict, whoWords } from '../src/clearanceVerdict.ts'
import { parseWorld, type World } from '../src/world.ts'
import { readFileSync } from 'node:fs'

const failures: string[] = []
const check = (ok: boolean, what: string) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failures.push(what)
}
const load = (path: string): World => parseWorld(JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')))

const narrow = load('../src/clearance_test_world.json') // a 78 cm gap
const example = load('../../shared/example_world.json')
const wheelchair = PERSON_WIDTHS.wheelchair.widthM
const walking = PERSON_WIDTHS.walking.widthM

const blocked = checkClearance(narrow, wheelchair)
const v1 = verdict(blocked)
console.log('  ', v1.text)
check(!v1.pass && /^Narrowest point \d+ cm: too tight for a wheelchair \(needs 85 cm\)\.$/.test(v1.text), 'FAIL words for a gap that is too narrow')
check(shortVerdict(blocked).startsWith('FAIL ('), 'short FAIL form')

const through = checkClearance(narrow, walking)
const v2 = verdict(through)
console.log('  ', v2.text)
check(v2.pass && /wide enough for a person walking \(needs 50 cm\)/.test(v2.text), 'PASS words with a gap')

const open = checkClearance(example, walking)
const v3 = verdict(open)
console.log('  ', v3.text)
check(v3.pass, 'the example room passes for a person walking')
check(/^PASS \(/.test(shortVerdict(open)), 'short PASS form')

// a room whose goal is walled in
const sealed: World = structuredClone(example)
sealed.objects = [
  { id: 'w1', label: 'wall', role: 'fixed', confidence: 1, position: [2.5, 1, -1.0], size: [1.4, 2, 0.1], rotation_y: 0 },
  { id: 'w2', label: 'wall', role: 'fixed', confidence: 1, position: [2.5, 1, -2.6], size: [1.4, 2, 0.1], rotation_y: 0 },
  { id: 'w3', label: 'wall', role: 'fixed', confidence: 1, position: [1.8, 1, -1.8], size: [0.1, 2, 1.7], rotation_y: 0 },
  { id: 'w4', label: 'wall', role: 'fixed', confidence: 1, position: [3.2, 1, -1.8], size: [0.1, 2, 1.7], rotation_y: 0 },
]
const closedOff = checkClearance(sealed, walking)
const v4 = verdict(closedOff)
console.log('  ', v4.text, `(${closedOff.blockedAt?.reason})`)
check(!v4.pass && closedOff.blockedAt !== null && v4.text.length > 10 && shortVerdict(closedOff).startsWith('FAIL'), 'a sealed goal fails in words')

const line = beforeAfterLine(blocked, through)
console.log('  ', line)
check(/^Before: FAIL \(\d+ cm\)  \|  After: PASS \(\d+ cm\)$/.test(line), 'the Before / After line')

check(whoWords(0.5) === 'a person walking' && whoWords(0.7) === 'someone with a walker' && whoWords(0.85) === 'a wheelchair' && whoWords(0.65) === 'a person 0.65 m wide', 'who the width is for, in words')
for (let w = 0.4; w <= 1.2001; w += 0.05) {
  const r = checkClearance(narrow, Math.round(w * 100) / 100)
  const v = verdict(r)
  if (v.pass !== r.reachable || v.text === '') failures.push(`width ${w}: verdict disagrees with reachable`)
}
check(true, 'verdict always agrees with "reachable" at every slider width')

console.log(failures.length ? `\nFAILED:\n - ${failures.join('\n - ')}` : '\nPASS')
process.exit(failures.length ? 1 : 0)
