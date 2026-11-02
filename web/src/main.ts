import './style.css'
import { checkScanFile, processScan } from './api.ts'
import { openCharacterPanel } from './characterPanel.ts'
import type { PlayMode } from './play.ts'
import { scanMeshUrl } from './scanMesh.ts'
import { createScreens, type Mode } from './screens.ts'
import { createViewer, type Viewer } from './viewer.ts'
import { loadExampleWorld, loadTestWorld, type World } from './world.ts'

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
// Bumped whenever we leave a mode, so a slow-loading play mode knows it's no longer wanted.
let session = 0

function closeAll(): void {
  session++
  viewer?.dispose()
  viewer = null
  play?.dispose()
  play = null
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

  onUseExample: (mode) => openWorld('Example room', loadExampleWorld, mode),

  // Development only: the production build leaves this out.
  onUseTestRoom: import.meta.env.DEV ? () => openWorld('Test room', loadTestWorld, 'game') : undefined,

  onPlay: () => void enterPlay(),

  onCharacter: () => {
    openCharacterPanel()
  },

  onStartOver: () => {
    closeAll()
    delete document.body.dataset.mode
    screens.show('upload')
  },
})
