// Offline test of scanMeshUrl (which worlds get the scanned room drawn). Run: node scripts/test-scanmesh.ts
import { scanMeshUrl } from '../src/scanMesh.ts'
import type { World } from '../src/world.ts'

const failures: string[] = []
const world = (source_scan: string) => ({ source_scan }) as World
const id = 'ab12'.repeat(8)

const cases: [string, string | null][] = [
  [`${id}/original.glb`, `/scan/${id}/mesh`], // a world the server made from an upload
  ['example_living_room.usdz', null], // shared/example_world.json
  ['three_links_bathroom.glb', null], // shared/real_world_01.json (no scan on the server)
  ['', null],
  [`${id.toUpperCase()}/original.glb`, null], // the server only makes lower-case ids
  [`${id.slice(1)}/original.glb`, null], // too short
  [`../${id}/original.glb`, null], // must not be steerable to another path
  [`${id}`, null], // no slash
]
for (const [source, expected] of cases) {
  const got = scanMeshUrl(world(source))
  console.log(`  ${JSON.stringify(source).slice(0, 44).padEnd(46)} -> ${got}`)
  if (got !== expected) failures.push(`${source}: expected ${expected}, got ${got}`)
}
console.log(failures.length ? `\nFAIL:\n - ${failures.join('\n - ')}` : '\nPASS')
process.exit(failures.length ? 1 : 0)
