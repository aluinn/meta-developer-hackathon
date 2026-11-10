// Times the clearance check (src/clearance.ts) on every world in the repo. Run from /web: node scripts/bench-clearance.ts
// Prints a markdown table. Not a test: it only measures.
import { readFileSync } from 'node:fs'
import os from 'node:os'
import { buildFloorMap, checkClearance, PERSON_WIDTHS } from '../src/clearance.ts'
import { parseWorld } from '../src/world.ts'

const RUNS = 20
const worlds: [string, string][] = [
  ['shared/example_world.json', '../shared/example_world.json'],
  ['shared/real_world_01.json (bathroom scan)', '../shared/real_world_01.json'],
  ['examples/zac-room (real scan)', 'public/examples/zac-room/world.json'],
  ['examples/studio-apartment (real scan)', 'public/examples/studio-apartment/world.json'],
  ['src/clearance_test_world.json (narrow gap)', 'src/clearance_test_world.json'],
]

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const time = (fn: () => void) => {
  const t = performance.now()
  fn()
  return performance.now() - t
}

console.log(`Node ${process.version}, ${os.cpus()[0].model}, ${os.cpus().length} cores, ${os.platform()} ${os.arch()}`)
console.log(`Median of ${RUNS} runs after 3 warm-up runs, milliseconds.\n`)
console.log('| World | Objects | Grid (cells) | Build floor map | Check, walking (0.5 m) | Check, wheelchair (0.85 m) |')
console.log('|---|---|---|---|---|---|')
for (const [name, path] of worlds) {
  const world = parseWorld(JSON.parse(readFileSync(path, 'utf8')))
  for (let i = 0; i < 3; i++) checkClearance(world, 0.5)
  const map = buildFloorMap(world)
  const build = median(Array.from({ length: RUNS }, () => time(() => buildFloorMap(world))))
  const walking = median(Array.from({ length: RUNS }, () => time(() => checkClearance(world, PERSON_WIDTHS.walking.widthM))))
  const chair = median(Array.from({ length: RUNS }, () => time(() => checkClearance(world, PERSON_WIDTHS.wheelchair.widthM))))
  console.log(`| ${name} | ${world.objects.length} | ${map.nx} x ${map.nz} | ${build.toFixed(1)} | ${walking.toFixed(1)} | ${chair.toFixed(1)} |`)
}
