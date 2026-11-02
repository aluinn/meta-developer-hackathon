// The on-screen parts of the race: the time and what to do next, the item button, banners ("Gate 2!", "Got Boost!"), the 3-2-1-GO countdown,
// the power-up timers and the finish dialog. Plain page elements over the 3D view; no game rules in here (those are in game.ts).

import { ITEM_INFO, TUNING, type Game, type ItemKind } from './game.ts'

export interface EndScreen {
  title: string
  lines: string[]
  onRestart: () => void
  onBack: () => void
}

export interface RaceHud {
  /** Refresh everything from the game. Call every frame. */
  update: (game: Game) => void
  banner: (text: string, tone?: 'good' | 'bad' | 'info') => void
  showEnd: (end: EndScreen) => void
  hideEnd: () => void
  dispose: () => void
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const ITEM_SYMBOL: Record<ItemKind, string> = { boost: 'BOOST', spring: 'SPRING', wings: 'WINGS', shield: 'SHIELD', freeze: 'FREEZE' }

/**
 * `hud` is the play screen's overlay. `timer` is the existing timer element (it now shows the time LEFT).
 * `onUse` is called when the item button is pressed.
 */
export function createRaceHud(hud: HTMLElement, timer: HTMLElement, onUse: () => void): RaceHud {
  const info = el('div', 'race-info')
  const effects = el('div', 'race-effects')
  const banner = el('div', 'race-banner')
  banner.setAttribute('role', 'status')
  const countdown = el('div', 'race-countdown')
  const item = el('button', 'item-btn')
  item.type = 'button'
  item.setAttribute('aria-label', 'Use item')
  const itemName = el('span', 'item-name')
  const itemKey = el('span', 'item-key', 'E')
  item.append(itemName, itemKey)
  item.addEventListener('click', onUse)
  item.addEventListener('pointerdown', (e) => e.stopPropagation()) // pressing it must not also start a look-drag
  const end = el('div', 'race-end')
  end.hidden = true
  end.setAttribute('role', 'dialog')
  hud.append(info, effects, banner, countdown, item, end)

  let bannerTimer = 0
  let lastCount = ''
  return {
    update(game) {
      const urgent = game.timeLeft < 10 && game.phase === 'running'
      timer.textContent = `${Math.ceil(game.timeLeft)} s`
      timer.classList.toggle('urgent', urgent)
      const gates = game.course.checkpoints.length
      info.textContent = game.flagUnlocked ? `Catch the flag!  ${game.tags}/${TUNING.tagsNeeded}` : `Gate ${Math.min(game.cpIndex + 1, gates)} of ${gates}`
      info.classList.toggle('flag', game.flagUnlocked)

      const text = game.phase === 'countdown' ? (game.countdown > 0 ? String(Math.ceil(game.countdown)) : 'GO!') : ''
      if (text !== lastCount) {
        lastCount = text
        countdown.textContent = text
        countdown.classList.remove('pop')
        void countdown.offsetWidth // restart the little pop animation
        if (text) countdown.classList.add('pop')
      }
      countdown.hidden = text === ''

      if (game.held) {
        itemName.textContent = ITEM_SYMBOL[game.held]
        item.title = ITEM_INFO[game.held].blurb
      } else {
        itemName.textContent = 'No item'
        item.title = 'Drive through a ? box to get one'
      }
      item.classList.toggle('has-item', game.held !== null)
      item.dataset.item = game.held ?? ''
      item.disabled = game.phase !== 'running'

      const active = (Object.keys(game.effects) as ItemKind[]).filter((k) => game.effects[k] > 0)
      const key = active.map((k) => `${k}${Math.ceil(game.effects[k])}`).join('|')
      if (effects.dataset.key !== key) {
        effects.dataset.key = key
        effects.replaceChildren(...active.map((k) => el('span', `chip chip-${k}`, `${ITEM_INFO[k].name} ${Math.ceil(game.effects[k])}s`)))
      }
    },
    banner(text, tone = 'info') {
      banner.textContent = text
      banner.className = `race-banner show ${tone}`
      window.clearTimeout(bannerTimer)
      bannerTimer = window.setTimeout(() => banner.classList.remove('show'), 1800)
    },
    showEnd(e) {
      const title = el('h2', '', e.title)
      const lines = e.lines.map((l) => el('p', 'race-end-line', l))
      const again = el('button', 'btn btn-primary', 'Race again')
      again.type = 'button'
      again.addEventListener('click', e.onRestart)
      const back = el('button', 'btn btn-secondary', 'Back to the room')
      back.type = 'button'
      back.addEventListener('click', e.onBack)
      end.replaceChildren(title, ...lines, again, back)
      end.hidden = false
      again.focus({ preventScroll: true })
    },
    hideEnd() {
      end.hidden = true
    },
    dispose() {
      window.clearTimeout(bannerTimer)
      for (const node of [info, effects, banner, countdown, item, end]) node.remove()
      timer.classList.remove('urgent')
    },
  }
}
