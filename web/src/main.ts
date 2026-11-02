import './style.css'
import type { PlayMode } from './play.ts'
import { createScreens } from './screens.ts'
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
  if (world) viewer = createViewer(screens.viewContainer, world)
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
async function openWorld(title: string, load: () => Promise<World>): Promise<void> {
  closeAll()
  screens.setStatus(`Loading ${title.toLowerCase()}…`)
  screens.show('loading')
  try {
    const [loaded] = await Promise.all([load(), wait(1000)])
    world = loaded
    const n = loaded.objects.length
    screens.setResultsSummary(title, `${n} ${n === 1 ? 'object' : 'objects'} found`)
    screens.show('results') // show first, so the 3D area has a real size when the viewer starts
    showViewer()
  } catch (err) {
    screens.show('upload')
    screens.showError(`Could not load ${title.toLowerCase()}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

const screens = createScreens(root, {
  // A real file: just show its name and size. Nothing is uploaded yet.
  onFileChosen: (file) => screens.showFile(file),

  onUseExample: () => openWorld('Example room', loadExampleWorld),

  // Development only: the production build leaves this out.
  onUseTestRoom: import.meta.env.DEV ? () => openWorld('Test room', loadTestWorld) : undefined,

  onPlay: () => void enterPlay(),

  onStartOver: () => {
    closeAll()
    screens.show('upload')
  },
})
