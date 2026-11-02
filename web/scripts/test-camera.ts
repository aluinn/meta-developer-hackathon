// Checks the follow camera can look UP (sit below the character's head) and doesn't undo it.
import * as THREE from 'three'
import { CAMERA, createFollowCamera } from '../src/followCamera.ts'

const camera = new THREE.PerspectiveCamera()
const cam = createFollowCamera(camera)
const feet = new THREE.Vector3(0, 0, 0)
cam.reset(feet, 0)
const open = () => 100 // nothing in the way
// Drag the mouse up a lot: dy negative = look up.
for (let i = 0; i < 40; i++) cam.update(1 / 60, feet, 0, 0, { dx: 0, dy: -20 }, open)
for (let i = 0; i < 120; i++) cam.update(1 / 60, feet, 0, 0, { dx: 0, dy: 0 }, open)
if (!(camera.position.y < CAMERA.headHeight - 0.2)) throw new Error(`camera did not go below the head: y=${camera.position.y}`)
// Mouse down a lot: the camera rises above the head.
for (let i = 0; i < 80; i++) cam.update(1 / 60, feet, 0, 0, { dx: 0, dy: 20 }, open)
for (let i = 0; i < 120; i++) cam.update(1 / 60, feet, 0, 0, { dx: 0, dy: 0 }, open)
if (!(camera.position.y > CAMERA.headHeight + 0.2)) throw new Error(`camera did not rise: y=${camera.position.y}`)
// Looking up with a floor right below the camera: it must not be lifted away.
for (let i = 0; i < 80; i++) cam.update(1 / 60, feet, 0, 0, { dx: 0, dy: -20 }, (_f, d, m) => (d.y < 0 ? 0.3 : m))
for (let i = 0; i < 120; i++) cam.update(1 / 60, feet, 0, 0, { dx: 0, dy: 0 }, (_f, d, m) => (d.y < 0 ? 0.3 : m))
if (!(camera.position.y < CAMERA.headHeight)) throw new Error(`auto-raise undid looking up: y=${camera.position.y}`)
console.log('camera test passed')
