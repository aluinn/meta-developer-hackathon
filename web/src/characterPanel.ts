// The "Character" panel: describe a character, get a picture drawn for you, and use it in play mode.
// The picture is kept in this browser only (characterStore.ts); play mode reads it when it starts.

import { ApiError, generateCharacter } from './api.ts'
import { characterPictureUrl, clearCustomCharacter, getCustomCharacter, saveCustomCharacter } from './characterStore.ts'

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** Open the panel over the page. Returns a function that closes it. */
export function openCharacterPanel(): () => void {
  const backdrop = el('div', 'character-overlay')
  const panel = el('div', 'character-panel')
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', 'Make your character')

  const title = el('h2', undefined, 'Your character')
  const preview = el('img', 'character-preview')
  preview.alt = 'Your character'
  const showCurrent = () => {
    preview.src = characterPictureUrl()
  }
  showCurrent()

  const hint = el('p', 'character-hint', 'Describe an original character: no existing characters or brands. It takes about 20 seconds.')
  const input = el('input', 'character-input')
  input.type = 'text'
  input.maxLength = 80
  input.placeholder = 'a sleepy red panda wearing a tiny hat'
  input.setAttribute('aria-label', 'Describe your character')
  const status = el('p', 'character-status')
  status.setAttribute('role', 'status')

  const draw = el('button', 'btn btn-primary', 'Draw it')
  draw.type = 'button'
  const reset = el('button', 'btn btn-secondary', 'Use the default')
  reset.type = 'button'
  reset.hidden = getCustomCharacter() === null
  const close = el('button', 'btn btn-small', 'Close')
  close.type = 'button'
  const buttons = el('div', 'character-buttons')
  buttons.append(draw, reset)

  let drawing = false
  const run = async () => {
    if (drawing) return
    drawing = true
    draw.disabled = true
    status.className = 'character-status'
    status.textContent = 'Drawing your character… about 20 seconds.'
    try {
      saveCustomCharacter(await generateCharacter(input.value))
      showCurrent()
      reset.hidden = false
      status.textContent = 'Done! Press Play to run around as your character.'
    } catch (err) {
      status.className = 'character-status error'
      status.textContent = err instanceof ApiError ? err.message : 'Something went wrong. Please try again.'
    } finally {
      drawing = false
      draw.disabled = false
    }
  }
  draw.addEventListener('click', () => void run())
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void run()
  })
  reset.addEventListener('click', () => {
    clearCustomCharacter()
    showCurrent()
    reset.hidden = true
    status.className = 'character-status'
    status.textContent = 'Back to the default character.'
  })

  const closePanel = () => {
    document.removeEventListener('keydown', onKey)
    backdrop.remove()
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closePanel()
  }
  document.addEventListener('keydown', onKey)
  close.addEventListener('click', closePanel)
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closePanel()
  })

  panel.append(title, preview, hint, input, buttons, status, close)
  backdrop.append(panel)
  document.body.append(backdrop)
  input.focus()
  return closePanel
}
