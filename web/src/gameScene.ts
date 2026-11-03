// What the race looks like in the 3D room: checkpoint gates, item boxes, rolling spiky hazards, the flag, the arrow that points at
// the next target, and the effects around the player (shield bubble, wings, boost/jump aura). Everything is built from simple shapes
// (original, nothing downloaded) and sized from the character's height `s`, so it fits the tiny character and the person-sized one.

import * as THREE from 'three'
import { disposeChildren } from './dispose.ts'
import type { Game } from './game.ts'

const COLOR = {
  gateNext: 0x22d3ee,
  gateDone: 0x22c55e,
  gateFuture: 0x94a3b8,
  item: 0xfbbf24,
  hazard: 0xef4444,
  flag: 0xfacc15,
  flagLocked: 0x94a3b8,
  flagFrozen: 0x60a5fa,
  boost: 0xfb923c,
  spring: 0x4ade80,
}

export interface GameScene {
  group: THREE.Group
  /** Move everything to match the game. `feet` is where the player's feet are, `time` is seconds since the race scene was made. */
  update: (game: Game, feet: THREE.Vector3, time: number, camera: THREE.Camera) => void
  dispose: () => void
}

/** A small white wing, drawn on a canvas, for a sprite (so it always faces the camera). */
function wingTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 96
  const g = canvas.getContext('2d') as CanvasRenderingContext2D
  g.fillStyle = '#ffffff'
  g.strokeStyle = '#94a3b8'
  g.lineWidth = 3
  for (let i = 0; i < 4; i++) { // four feathers fanning out
    g.save()
    g.translate(16, 70)
    g.rotate((-0.15 - i * 0.28))
    g.beginPath()
    g.ellipse(48, 0, 50 - i * 6, 12, 0, 0, Math.PI * 2)
    g.fill()
    g.stroke()
    g.restore()
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

function label(text: string, color: string, onTop = false): THREE.Sprite {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 128
  const g = canvas.getContext('2d') as CanvasRenderingContext2D
  g.fillStyle = 'rgba(15, 23, 42, 0.85)'
  g.beginPath()
  g.arc(64, 64, 58, 0, Math.PI * 2)
  g.fill()
  g.lineWidth = 8
  g.strokeStyle = color
  g.stroke()
  g.fillStyle = '#ffffff'
  g.font = 'bold 72px sans-serif'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(text, 64, 70)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: !onTop }))
  if (onTop) sprite.renderOrder = 6
  return sprite
}

const basic = (color: number, opacity = 1, extra: THREE.MeshBasicMaterialParameters = {}) =>
  new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, ...extra })

/** A flat dark disc that lies on the surface under something, showing where it is (and where it would land). */
function shadowDisc(radius: number): THREE.Mesh {
  const material = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.4, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
  const disc = new THREE.Mesh(new THREE.CircleGeometry(1, 24), material)
  disc.rotation.x = -Math.PI / 2
  disc.scale.setScalar(radius)
  disc.renderOrder = 2
  return disc
}

/** A flat ring on the surface, drawn on top of the picture of the room so it can always be seen. */
function floorRing(inner: number, outer: number, color: number, opacity: number): THREE.Mesh {
  const ring = new THREE.Mesh(new THREE.RingGeometry(inner, outer, 40), basic(color, opacity, { side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }))
  ring.rotation.x = -Math.PI / 2
  ring.renderOrder = 3
  return ring
}

/**
 * `onTop`: the room is a scan, whose walls and clutter would hide the gates and item boxes, so those are drawn over the room
 * (they stay visible through furniture, like objective markers in a game). Made-up rooms are clear, so they keep normal depth.
 */
export function createGameScene(game: Game, s: number, onTop = false): GameScene {
  const seen: THREE.MeshBasicMaterialParameters = onTop ? { depthTest: false } : {}
  const raise = (mesh: THREE.Object3D) => { if (onTop) mesh.renderOrder = 5 }
  const group = new THREE.Group()
  group.name = 'race'

  // ---- gates ----
  const gates = game.course.checkpoints.map((cp, i) => {
    const gate = new THREE.Group()
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.62 * s, 0.07 * s, 8, 32), basic(COLOR.gateFuture, 0.5, { side: THREE.DoubleSide, ...seen }))
    ring.position.y = 0.7 * s
    raise(ring)
    const base = floorRing(0.44 * s, 0.58 * s, COLOR.gateFuture, 0.5) // the ring on the floor under the gate: stand inside it to pass
    base.position.y = 0.01 * s
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.06 * s, 0.06 * s, 5 * s, 8, 1, true), basic(COLOR.gateNext, 0.3, { side: THREE.DoubleSide, depthWrite: false, ...seen }))
    beam.position.y = 2.5 * s
    raise(beam)
    const number = label(String(i + 1), '#22d3ee', onTop)
    number.scale.setScalar(0.55 * s)
    number.position.y = 1.65 * s
    gate.add(ring, base, beam, number)
    gate.position.fromArray(cp.pos)
    group.add(gate)
    const disc = new THREE.Mesh(new THREE.CircleGeometry(0.44 * s, 32), basic(COLOR.gateFuture, 0.14, { depthWrite: false })) // a faint fill inside the floor ring
    disc.rotation.x = -Math.PI / 2
    disc.position.y = 0.008 * s
    gate.add(disc)
    return { gate, ring, base, beam, disc }
  })

  // ---- item boxes ----
  const boxes = game.items.map((box) => {
    const holder = new THREE.Group()
    const cube = new THREE.Mesh(new THREE.BoxGeometry(0.4 * s, 0.4 * s, 0.4 * s), basic(COLOR.item, 0.9, seen))
    raise(cube)
    const ground = shadowDisc(0.3 * s)
    const groundRing = floorRing(0.32 * s, 0.4 * s, COLOR.item, 0.55)
    const mark = label('?', '#fbbf24', onTop)
    mark.scale.setScalar(0.42 * s)
    mark.position.y = 0.5 * s // above the cube, where it can be seen
    holder.add(cube, mark)
    holder.position.fromArray(box.pos)
    group.add(holder)
    for (const o of [ground, groundRing]) { // these stay on the surface while the cube floats above them
      o.position.set(box.pos[0], box.pos[1] + 0.006 * s, box.pos[2])
      group.add(o)
    }
    return { holder, cube, ground, groundRing }
  })

  // ---- hazards ----
  const hazards = game.hazards.map((h) => {
    const ball = new THREE.Mesh(new THREE.IcosahedronGeometry(h.def.radius, 0), new THREE.MeshStandardMaterial({ color: COLOR.hazard, emissive: 0x7f1d1d, flatShading: true }))
    group.add(ball)
    const shadow = shadowDisc(h.def.radius * 1.25)
    group.add(shadow)
    return { ball, shadow }
  })

  // ---- the flag ----
  const flag = new THREE.Group()
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04 * s, 0.04 * s, 2.6 * s, 8), new THREE.MeshStandardMaterial({ color: 0xf1f5f9 }))
  pole.position.y = 1.3 * s
  const bannerGeometry = new THREE.PlaneGeometry(1.3 * s, 0.8 * s, 12, 4)
  const bannerMaterial = new THREE.MeshBasicMaterial({ color: COLOR.flag, side: THREE.DoubleSide })
  const banner = new THREE.Mesh(bannerGeometry, bannerMaterial)
  banner.position.set(0.65 * s, 2.15 * s, 0)
  const glow = new THREE.Mesh(new THREE.RingGeometry(0.4 * s, 0.65 * s, 28), basic(COLOR.flag, 0.55, { side: THREE.DoubleSide }))
  glow.rotation.x = -Math.PI / 2
  glow.position.y = 0.02 * s
  const flagBeam = new THREE.Mesh(new THREE.CylinderGeometry(0.07 * s, 0.07 * s, 7 * s, 8, 1, true), basic(COLOR.flag, 0.28, { side: THREE.DoubleSide, depthWrite: false }))
  flagBeam.position.y = 3.5 * s // a tall glow so the flag can be found from anywhere in the room
  flag.add(pole, banner, glow, flagBeam)
  group.add(flag)
  const bannerBase = Float32Array.from(bannerGeometry.attributes.position.array as ArrayLike<number>)

  // ---- the arrow over the player's head, pointing at the next target ----
  const arrowShape = new THREE.Shape() // a flat arrow lying in the air above the head, its tip towards the next target
  arrowShape.moveTo(0, 0.32 * s)
  arrowShape.lineTo(0.2 * s, -0.12 * s)
  arrowShape.lineTo(0, -0.02 * s)
  arrowShape.lineTo(-0.2 * s, -0.12 * s)
  arrowShape.closePath()
  const arrowGeometry = new THREE.ShapeGeometry(arrowShape)
  arrowGeometry.rotateX(Math.PI / 2) // lay it flat: the tip now points along +z
  const arrow = new THREE.Mesh(arrowGeometry, basic(COLOR.gateNext, 0.95, { side: THREE.DoubleSide, depthTest: false }))
  arrow.renderOrder = 10
  const arrowHolder = new THREE.Group()
  arrowHolder.add(arrow)
  group.add(arrowHolder)

  // ---- effects around the player ----
  const bubble = new THREE.Mesh(new THREE.SphereGeometry(0.75 * s, 22, 16), basic(0x67e8f9, 0.22, { depthWrite: false }))
  const wingMap = wingTexture()
  const wingL = new THREE.Sprite(new THREE.SpriteMaterial({ map: wingMap, transparent: true }))
  const wingR = new THREE.Sprite(new THREE.SpriteMaterial({ map: wingMap, transparent: true }))
  const aura = new THREE.Mesh(new THREE.RingGeometry(0.3 * s, 0.5 * s, 28), basic(COLOR.boost, 0.7, { side: THREE.DoubleSide, depthWrite: false }))
  aura.rotation.x = -Math.PI / 2
  for (const o of [bubble, wingL, wingR, aura]) {
    o.visible = false
    group.add(o)
  }

  const target = new THREE.Vector3()
  const right = new THREE.Vector3()
  return {
    group,
    update(g, feet, time, camera) {
      const pulse = 1 + Math.sin(time * 5) * 0.08
      gates.forEach((it, i) => {
        const state = i < g.cpIndex ? 'done' : i === g.cpIndex ? 'next' : 'future'
        const color = state === 'done' ? COLOR.gateDone : state === 'next' ? COLOR.gateNext : COLOR.gateFuture
        const opacity = state === 'next' ? 0.95 : state === 'done' ? 0.3 : 0.4
        for (const m of [it.ring, it.base, it.disc]) {
          const material = m.material as THREE.MeshBasicMaterial
          material.color.setHex(color)
          material.opacity = m === it.disc ? opacity * 0.3 : opacity
        }
        it.base.scale.setScalar(state === 'next' ? pulse : 1)
        it.beam.visible = state === 'next'
        it.ring.rotation.y = time * (state === 'next' ? 1.6 : 0.4)
        it.ring.scale.setScalar(state === 'next' ? pulse : 1)
      })
      boxes.forEach((b, i) => {
        const item = g.items[i]
        b.holder.visible = item.active
        b.ground.visible = b.groundRing.visible = item.active
        const bob = Math.sin(time * 2.4 + i)
        b.ground.scale.setScalar(0.3 * s * (1 - bob * 0.12)) // the shadow shrinks as the cube rises
        b.holder.position.set(item.pos[0], item.pos[1] + (0.42 + Math.sin(time * 2.4 + i) * 0.05) * s, item.pos[2])
        b.cube.rotation.y = time * 1.5
        b.cube.rotation.x = time * 0.9
      })
      hazards.forEach(({ ball, shadow }, i) => {
        const h = g.hazards[i]
        shadow.position.set(h.pos[0], h.pos[1] + 0.006 * s, h.pos[2])
        ball.position.set(h.pos[0], h.pos[1] + h.def.radius, h.pos[2])
        ball.rotation.x = time * 4 * h.dir
        ball.rotation.z = time * 2
      })

      // the flag: grey while locked, gold when it is fleeing, blue when frozen; droops when tired; waves in the wind
      const f = g.flag
      flag.position.set(f.pos[0], f.pos[1], f.pos[2])
      bannerMaterial.color.setHex(f.frozen ? COLOR.flagFrozen : g.flagUnlocked ? COLOR.flag : COLOR.flagLocked)
      ;(glow.material as THREE.MeshBasicMaterial).color.setHex(f.frozen ? COLOR.flagFrozen : g.flagUnlocked ? COLOR.flag : COLOR.flagLocked)
      banner.rotation.z = f.tired > 0 ? -0.9 : 0
      banner.position.y = (f.tired > 0 ? 1.2 : 1.55) * s
      const wave = f.dash > 0 ? 0.2 : f.tired > 0 ? 0.03 : 0.09
      const position = bannerGeometry.attributes.position
      for (let v = 0; v < position.count; v++) {
        const x = bannerBase[v * 3]
        position.setZ(v, Math.sin(time * 7 + x * 6 / s) * wave * s * ((x / s + 0.5) * 1.2))
      }
      position.needsUpdate = true
      flag.scale.setScalar(f.dash > 0 ? 1.15 : 1)
      flag.rotation.y = Math.atan2(camera.position.x - f.pos[0], camera.position.z - f.pos[2]) // the banner always faces you
      flagBeam.visible = g.flagUnlocked

      // the arrow points at the next gate, or at the flag once every gate is passed
      const toFlag = g.flagUnlocked
      target.set(toFlag ? f.pos[0] : g.course.checkpoints[Math.min(g.cpIndex, g.course.checkpoints.length - 1)].pos[0], 0, toFlag ? f.pos[2] : g.course.checkpoints[Math.min(g.cpIndex, g.course.checkpoints.length - 1)].pos[2])
      const dx = target.x - feet.x
      const dz = target.z - feet.z
      arrowHolder.visible = g.phase === 'running' && Math.hypot(dx, dz) > 1.6 * s
      const aim = Math.atan2(dx, dz)
      const lead = (1.6 + Math.sin(time * 4) * 0.08) * s // on the floor, a little way ahead of you, so it never covers the character
      arrowHolder.position.set(feet.x + Math.sin(aim) * lead, feet.y + 0.03 * s, feet.z + Math.cos(aim) * lead)
      arrowHolder.rotation.y = aim
      ;(arrow.material as THREE.MeshBasicMaterial).color.setHex(toFlag ? COLOR.flag : COLOR.gateNext)

      // effects
      bubble.visible = g.effects.shield > 0
      bubble.position.set(feet.x, feet.y + 0.5 * s, feet.z)
      bubble.scale.setScalar(1 + Math.sin(time * 6) * 0.03)
      const flying = g.effects.wings > 0
      wingL.visible = wingR.visible = flying
      if (flying) {
        right.set(1, 0, 0).applyQuaternion(camera.quaternion) // the camera's right-hand direction, so the wings sit either side on screen
        const flap = 0.85 + Math.sin(time * 18) * 0.25
        wingL.position.copy(feet).addScaledVector(right, -0.5 * s).setY(feet.y + 0.6 * s)
        wingR.position.copy(feet).addScaledVector(right, 0.5 * s).setY(feet.y + 0.6 * s)
        wingL.scale.set(-0.6 * s * flap, 0.45 * s, 1) // a negative width mirrors the left wing
        wingR.scale.set(0.6 * s * flap, 0.45 * s, 1)
      }
      aura.visible = g.effects.boost > 0 || g.effects.spring > 0
      if (aura.visible) {
        ;(aura.material as THREE.MeshBasicMaterial).color.setHex(g.effects.boost > 0 ? COLOR.boost : COLOR.spring)
        aura.position.set(feet.x, feet.y + 0.02 * s, feet.z)
        aura.scale.setScalar(1 + Math.sin(time * 9) * 0.15)
      }
    },
    dispose() {
      disposeChildren(group)
      group.removeFromParent()
    },
  }
}
