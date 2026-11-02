// Player input: keyboard (laptop), on-screen thumbstick + Jump button (touch), and drag to look.
// Everything is read through one small interface, so play.ts doesn't care which device is used.

export interface Input {
  /** Wanted direction, each -1..1: x = right, y = forward (away from the camera). */
  move: () => { x: number; y: number }
  /** True once per Jump press (key or button). */
  takeJump: () => boolean
  /** True while Jump is held down (to fly up when you have Wings). */
  jumpHeld: () => boolean
  /** True once per press of the Use Item key (E or Shift). */
  takeUse: () => boolean
  /** How far the view was dragged since the last call, in screen pixels. */
  takeLook: () => { dx: number; dy: number }
  dispose: () => void
}

const KEYS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  use: ['KeyE', 'ShiftLeft', 'ShiftRight'],
}
const GAME_KEYS = new Set(Object.values(KEYS).flat())
const STICK_DEADZONE = 0.15

/** True on phones and tablets (and touch laptops): show the on-screen controls. */
export function hasTouch(): boolean {
  return window.matchMedia('(any-pointer: coarse)').matches || navigator.maxTouchPoints > 0
}

/**
 * `lookArea` is the element you drag to look around (the 3D canvas).
 * `hud` is where the thumbstick and Jump button are added (only on touch screens).
 */
export function createInput(lookArea: HTMLElement, hud: HTMLElement): Input {
  const cleanups: Array<() => void> = []
  const listen = <K extends keyof HTMLElementEventMap>(
    target: HTMLElement | Window,
    type: K,
    fn: (e: HTMLElementEventMap[K]) => void,
  ) => {
    target.addEventListener(type, fn as EventListener)
    cleanups.push(() => target.removeEventListener(type, fn as EventListener))
  }

  let jumpQueued = false
  let useQueued = false
  let jumpButtonHeld = false
  let lookDx = 0
  let lookDy = 0
  const stick = { x: 0, y: 0 }

  // ---- Keyboard ----
  const down = new Set<string>()
  listen(window, 'keydown', (e) => {
    if (!GAME_KEYS.has(e.code)) return
    e.preventDefault() // stop arrows and Space scrolling the page
    if (KEYS.jump.includes(e.code) && !e.repeat) jumpQueued = true
    if (KEYS.use.includes(e.code) && !e.repeat) useQueued = true
    down.add(e.code)
  })
  listen(window, 'keyup', (e) => down.delete(e.code))
  listen(window, 'blur', () => down.clear()) // switching windows: don't keep running
  const held = (codes: string[]) => codes.some((c) => down.has(c))

  // ---- Drag to look (mouse or a finger on the 3D view) ----
  let lookPointer: number | null = null
  let lastX = 0
  let lastY = 0
  listen(lookArea, 'pointerdown', (e) => {
    if (lookPointer !== null) return
    lookPointer = e.pointerId
    lastX = e.clientX
    lastY = e.clientY
    lookArea.setPointerCapture(e.pointerId)
  })
  listen(lookArea, 'pointermove', (e) => {
    if (e.pointerId !== lookPointer) return
    lookDx += e.clientX - lastX
    lookDy += e.clientY - lastY
    lastX = e.clientX
    lastY = e.clientY
  })
  const endLook = (e: PointerEvent) => {
    if (e.pointerId === lookPointer) lookPointer = null
  }
  listen(lookArea, 'pointerup', endLook)
  listen(lookArea, 'pointercancel', endLook)

  // ---- Touch: thumbstick (bottom left) and Jump button (bottom right) ----
  if (hasTouch()) {
    const base = document.createElement('div')
    base.className = 'stick'
    base.setAttribute('aria-label', 'Move')
    const knob = document.createElement('div')
    knob.className = 'stick-knob'
    base.append(knob)

    const jump = document.createElement('button')
    jump.type = 'button'
    jump.className = 'jump-btn'
    jump.textContent = 'Jump'
    hud.append(base, jump)
    cleanups.push(() => {
      base.remove()
      jump.remove()
    })

    let stickPointer: number | null = null
    const moveStick = (e: PointerEvent) => {
      const r = base.getBoundingClientRect()
      const radius = r.width / 2
      let dx = e.clientX - (r.left + radius)
      let dy = e.clientY - (r.top + radius)
      const dist = Math.hypot(dx, dy)
      if (dist > radius) {
        dx = (dx / dist) * radius
        dy = (dy / dist) * radius
      }
      knob.style.transform = `translate(${dx}px, ${dy}px)`
      const strength = Math.min(dist / radius, 1)
      // Ignore tiny wobbles near the middle, then scale smoothly up to full speed.
      const scale = strength < STICK_DEADZONE ? 0 : (strength - STICK_DEADZONE) / (1 - STICK_DEADZONE) / strength
      stick.x = (dx / radius) * scale
      stick.y = (-dy / radius) * scale // screen y points down; forward is up
    }
    const releaseStick = (e: PointerEvent) => {
      if (e.pointerId !== stickPointer) return
      stickPointer = null
      stick.x = 0
      stick.y = 0
      knob.style.transform = ''
    }
    listen(base, 'pointerdown', (e) => {
      e.preventDefault()
      stickPointer = e.pointerId
      base.setPointerCapture(e.pointerId)
      moveStick(e)
    })
    listen(base, 'pointermove', (e) => {
      if (e.pointerId === stickPointer) moveStick(e)
    })
    listen(base, 'pointerup', releaseStick)
    listen(base, 'pointercancel', releaseStick)

    listen(jump, 'pointerdown', (e) => {
      e.preventDefault()
      jumpQueued = true
      jumpButtonHeld = true
    })
    const releaseJump = () => {
      jumpButtonHeld = false
    }
    listen(jump, 'pointerup', releaseJump)
    listen(jump, 'pointercancel', releaseJump)
    listen(jump, 'pointerleave', releaseJump)
  }

  return {
    move: () => {
      const x = stick.x + (held(KEYS.right) ? 1 : 0) - (held(KEYS.left) ? 1 : 0)
      const y = stick.y + (held(KEYS.forward) ? 1 : 0) - (held(KEYS.back) ? 1 : 0)
      const length = Math.hypot(x, y)
      // Diagonals (W+D) would be 1.41x faster without this.
      return length > 1 ? { x: x / length, y: y / length } : { x, y }
    },
    takeJump: () => {
      const j = jumpQueued
      jumpQueued = false
      return j
    },
    jumpHeld: () => jumpButtonHeld || held(KEYS.jump),
    takeUse: () => {
      const u = useQueued
      useQueued = false
      return u
    },
    takeLook: () => {
      const d = { dx: lookDx, dy: lookDy }
      lookDx = 0
      lookDy = 0
      return d
    },
    dispose: () => {
      for (const fn of cleanups) fn()
    },
  }
}
