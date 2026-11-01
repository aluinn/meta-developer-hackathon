import './style.css'
import { createScreens } from './screens.ts'
import { loadExampleWorld } from './world.ts'

const root = document.querySelector<HTMLDivElement>('#app')
if (!root) throw new Error('Missing #app element in index.html')

/** Pause for a moment so the Loading screen can be seen (fake wait for now). */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const screens = createScreens(root, {
  // A real file: just show its name and size. Nothing is uploaded yet.
  onFileChosen: (file) => screens.showFile(file),

  onUseExample: async () => {
    screens.setStatus('Loading the example room…')
    screens.show('loading')
    try {
      const [world] = await Promise.all([loadExampleWorld(), wait(1000)])
      const n = world.objects.length
      screens.setResultsSummary('Example room', `${n} ${n === 1 ? 'object' : 'objects'} found`)
      screens.show('results')
    } catch (err) {
      screens.show('upload')
      screens.showError(`Could not load the example room: ${err instanceof Error ? err.message : String(err)}`)
    }
  },

  onStartOver: () => screens.show('upload'),
})
