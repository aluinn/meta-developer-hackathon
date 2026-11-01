// A small text label that always faces the camera (a three.js "sprite").
// The text is drawn onto a canvas and used as a texture.

import * as THREE from 'three'

const FONT_PX = 64
const PAD_X = 28
const PAD_Y = 14
const MAX_TEXT_WIDTH = 720

/** `height` is how tall the label is in the 3D world, in metres. */
export function createLabelSprite(text: string, height = 0.24): THREE.Sprite {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not make a 2D canvas for a label')

  const font = `600 ${FONT_PX}px system-ui, -apple-system, sans-serif`
  ctx.font = font
  const textWidth = Math.min(ctx.measureText(text).width, MAX_TEXT_WIDTH)
  // Changing the canvas size wipes its settings, so set the font again afterwards.
  canvas.width = Math.ceil(textWidth + PAD_X * 2)
  canvas.height = FONT_PX + PAD_Y * 2
  ctx.font = font

  // Rounded dark pill with white text: readable on any background.
  const w = canvas.width
  const h = canvas.height
  const r = h / 2
  ctx.fillStyle = 'rgba(20, 24, 34, 0.82)'
  ctx.beginPath()
  ctx.moveTo(r, 0)
  ctx.arcTo(w, 0, w, h, r)
  ctx.arcTo(w, h, 0, h, r)
  ctx.arcTo(0, h, 0, 0, r)
  ctx.arcTo(0, 0, w, 0, r)
  ctx.closePath()
  ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, PAD_X, h / 2 + 3, MAX_TEXT_WIDTH)

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  // depthTest off: labels are never hidden behind furniture.
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false })
  const sprite = new THREE.Sprite(material)
  sprite.scale.set(height * (w / h), height, 1)
  sprite.renderOrder = 10
  return sprite
}
