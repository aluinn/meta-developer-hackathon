import './style.css'
import { createScreens } from './screens.ts'
import { createViewer, type Viewer } from './viewer.ts'
import { loadExampleWorld, loadTestWorld, type World } from './world.ts'

const root = document.querySelector<HTMLDivElement>('#app')
if (!root) throw new Error('Missing #app element in index.html')

/** Pause for a moment so the Loading screen can be seen (fake wait for now). */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// At most one 3D viewer exists at a time, and only while the Results screen is showing.
let viewer: Viewer | null = null

function closeViewer(): void {
  viewer?.dispose()
  viewer = null
}

/** Upload -> Loading (about 1 second) -> Results, for any world loader. */
async function openWorld(title: string, load: () => Promise<World>): Promise<void> {
  closeViewer()
  screens.setStatus(`Loading ${title.toLowerCase()}…`)
  screens.show('loading')
  try {
    const [world] = await Promise.all([load(), wait(1000)])
    const n = world.objects.length
    screens.setResultsSummary(title, `${n} ${n === 1 ? 'object' : 'objects'} found`)
    screens.show('results') // show first, so the 3D area has a real size when the viewer starts
    viewer = createViewer(screens.viewContainer, world)
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

  onStartOver: () => {
    closeViewer()
    screens.show('upload')
  },
})
