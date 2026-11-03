import './style.css'
import { createClearancePanel, type ClearancePanel } from './clearancePanel.ts'
import { createLayoutAgentPanel, type LayoutAgentPanel } from './layoutAgentPanel.ts'
import { setLayoutGoal } from './layoutGoal.ts'
import { createLayoutPanel, type LayoutPanel } from './layoutPanel.ts'
import { checkScanFile, processScan } from './api.ts'
import { openCharacterPanel } from './characterPanel.ts'
import type { PlayMode } from './play.ts'
import { scanMeshUrl } from './scanMesh.ts'
import { loadBigExampleWorld } from './bigExample.ts'
import { createScreens, type Mode } from './screens.ts'
import { createViewer, type Viewer } from './viewer.ts'
import { loadClearanceTestWorld, loadTestWorld, type World } from './world.ts'

const root = document.querySelector<HTMLDivElement>('#app')
if (!root) throw new Error('Missing #app element in index.html')

/** Pause for a moment so the Loading screen can be seen (fake wait for now). */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// The world on the Results screen, and what is showing it: the 3D viewer OR play mode, never both.
let world: World | null = null
let viewer: Viewer | null = null
let play: PlayMode | null = null
let layout: LayoutPanel | null = null // the Layout tab's panel (exists once it has been opened)
let agent: LayoutAgentPanel | null = null // the layout agent (suggest, before/after), under the voice panel (draws on the viewer)
let clearance: ClearancePanel | null = null // the clearance check, under the layout agent (draws on the viewer)
let layoutOpen = false
// Bumped whenever we leave a mode, so a slow-loading play mode knows it's no longer wanted.
let session = 0

function closeAll(): void {
  session++
  agent?.dispose() // these two draw on the viewer, so they go before it
  agent = null
  clearance?.dispose()
  clearance = null
  viewer?.dispose()
  viewer = null
  play?.dispose()
  play = null
  layout?.dispose() // also turns the microphone off
  layout = null
  layoutOpen = false
  screens.setLayoutOpen(false)
  screens.setPlaying(false)
  screens.setViewMessage('')
}

function showViewer(): void {
  closeAll()
  if (!world) return
  const mine = createViewer(screens.viewContainer, world)
  viewer = mine
  // A world made from an uploaded scan comes with the scanned room itself: show it under the boxes. The boxes alone are the fallback.
  const scanUrl = scanMeshUrl(world)
  if (scanUrl) {
    mine.loadScanMesh(scanUrl).catch(() => {
      if (viewer === mine) screens.setViewMessage("The scan picture couldn't be loaded, so you're seeing simple boxes.")
    })
  }
}

/** The Layout tab opens the panel (voice, the layout agent, then the clearance check); pressing it again closes it. The 3D view stays visible. */
function toggleLayout(): void {
  if (!world || play) return
  layoutOpen = !layoutOpen
  if (layoutOpen) {
    layout ??= createLayoutPanel(screens.layoutContainer)
    if (viewer && !agent) {
      agent = createLayoutAgentPanel(screens.layoutContainer, { viewer, viewArea: screens.viewContainer, world })
      clearance = createClearancePanel(screens.layoutContainer, viewer, world)
      agent.link(clearance)
    }
  } else {
    layout?.stopRecording() // closing the panel must not leave the microphone on
  }
  agent?.setActive(layoutOpen) // the suggested layout, and the route and person, only show while the Layout tab is open
  clearance?.setActive(layoutOpen)
  screens.setLayoutOpen(layoutOpen)
}

async function enterPlay(): Promise<void> {
  if (!world || play) return
  closeAll()
  const mySession = session
  screens.setPlaying(true)
  screens.setViewMessage('Loading play mode…')
  try {
    // Loaded only when needed: the physics engine is big, so the first screens stay quick.
    const { startPlay } = await import('./play.ts')
    const started = await startPlay(screens.viewContainer, world, showViewer)
    if (mySession !== session) {
      started.dispose() // you left while it was loading
      return
    }
    play = started
    screens.setViewMessage('')
  } catch (err) {
    if (mySession !== session) return
    showViewer()
    screens.setViewMessage(`Play mode could not start: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Upload -> Loading (about 1 second) -> Results, for any world loader. */
async function openWorld(title: string, load: () => Promise<World>, mode: Mode): Promise<void> {
  closeAll()
  screens.setMode(mode)
  screens.setStatus(`Loading ${title.toLowerCase()}…`)
  screens.show('loading')
  try {
    const [loaded] = await Promise.all([load(), wait(1000)])
    world = loaded
    setLayoutGoal('') // a new room, so the old goal no longer applies
    const n = loaded.objects.length
    screens.setResultsSummary(title, `${n} ${n === 1 ? 'object' : 'objects'} found`)
    screens.setWorkInfo(loaded)
    screens.show('results') // show first, so the 3D area has a real size when the viewer starts
    showViewer()
  } catch (err) {
    delete document.body.dataset.mode
    screens.show('upload')
    screens.showError(`Could not load ${title.toLowerCase()}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

const screens = createScreens(root, {
  // A real scan: send it to the server (upload, find furniture, work out roles) and show the world it comes back with.
  onFileChosen: (file, mode) => {
    try {
      checkScanFile(file) // wrong type, too big or empty: say so straight away
    } catch (err) {
      screens.showError(err instanceof Error ? err.message : String(err))
      return
    }
    void openWorld(file.name.replace(/\.[^.]+$/, ''), () => processScan(file, screens.setStatus), mode)
  },

  // Game mode gets a roomier example, because the race needs space to dodge in. Work mode gets the small one with the table and chair
  // moved to leave a 77 cm gap: walking and a walker get through, a wheelchair does not, so the clearance check and the layout agent have something to do.
  onUseExample: (mode) => openWorld('Example room', mode === 'game' ? loadBigExampleWorld : loadClearanceTestWorld, mode),

  // Development only: the production build leaves this out.
  onUseTestRoom: import.meta.env.DEV ? () => openWorld('Test room', loadTestWorld, 'game') : undefined,
  onUseGapTestRoom: import.meta.env.DEV ? () => openWorld('Narrow-gap test room', loadClearanceTestWorld, 'game') : undefined,

  onPlay: () => void enterPlay(),

  onLayout: toggleLayout,
  onCharacter: () => {
    openCharacterPanel()
  },

  onStartOver: () => {
    closeAll()
    delete document.body.dataset.mode
    screens.show('upload')
  },
})
