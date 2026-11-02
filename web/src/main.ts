import './style.css'
import { createClearancePanel, type ClearancePanel } from './clearancePanel.ts'
import { setLayoutGoal } from './layoutGoal.ts'
import { createChangeOverlay, type ChangeOverlay } from './changeOverlay.ts'
import { createLayoutPanel, type LayoutPanel, type ProposalState, type RearrangeHooks } from './layoutPanel.ts'
import { checkScanFile, layout as askForLayout, processScan, type LayoutResult } from './api.ts'
import { openCharacterPanel } from './characterPanel.ts'
import type { PlayMode } from './play.ts'
import { scanMeshUrl } from './scanMesh.ts'
import { createScreens, type Mode } from './screens.ts'
import { createViewer, type Viewer } from './viewer.ts'
import { loadClearanceTestWorld, loadExampleWorld, loadTestWorld, type World } from './world.ts'

const root = document.querySelector<HTMLDivElement>('#app')
if (!root) throw new Error('Missing #app element in index.html')

/** Pause for a moment so the Loading screen can be seen (fake wait for now). */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// The world on the Results screen, and what is showing it: the 3D viewer OR play mode, never both.
let world: World | null = null // the room as it is now (in Work mode this can be a layout you chose to keep)
let originalWorld: World | null = null // the room as it was loaded: Reset goes back to it, and play mode always uses it
let mode: Mode = 'game'
let proposal: LayoutResult | null = null // the AI's latest suggestion for `world`, not kept yet (Work mode, Layout tab)
let showing: 'before' | 'after' = 'before' // which one the 3D view is drawing
let changeOverlay: ChangeOverlay | null = null // pink outlines and arrows on the objects the proposal moves
let viewer: Viewer | null = null
let play: PlayMode | null = null
let layout: LayoutPanel | null = null // the Layout tab's panel (exists once it has been opened)
let clearance: ClearancePanel | null = null // the clearance check, under the Layout panel (draws on the viewer)
let layoutOpen = false
// Bumped whenever we leave a mode, so a slow-loading play mode knows it's no longer wanted.
let session = 0

function closeAll(): void {
  session++
  clearance?.dispose() // before the viewer it draws on
  clearance = null
  changeOverlay?.dispose()
  changeOverlay = null
  proposal = null
  showing = 'before'
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

/** The room the 3D view should be drawing: the proposal while "After" is on, otherwise the current room. */
function viewedWorld(): World | null {
  return proposal && showing === 'after' ? proposal.world : world
}

function proposalState(): ProposalState | null {
  const changed = world !== originalWorld
  return proposal || changed ? { result: proposal, showing, canReset: changed, hasScan: world !== null && scanMeshUrl(world) !== null } : null
}

/** What the clearance panel compares: the current room against the proposal (null when there is no proposal). */
function compareState(): { before: World; after: World; showing: 'before' | 'after' } | null {
  return proposal && world ? { before: world, after: proposal.world, showing } : null
}

/** Draw whatever should be on screen now: the room, the scan (only for the room as loaded: it cannot move), the pink changes, the panels. */
function applyView(): void {
  const shown = viewedWorld()
  if (!viewer || !shown) return
  viewer.setWorld(shown)
  viewer.setShowScan(shown === originalWorld)
  screens.setWorkInfo(shown)
  screens.setViewMessage(shown !== originalWorld && scanMeshUrl(shown) ? 'The scan picture is hidden while the layout is changed: the scan itself cannot move. The boxes show the new arrangement.' : '')
  changeOverlay ??= createChangeOverlay(viewer)
  if (proposal) changeOverlay.show(proposal.changes, proposal.world.objects, showing)
  else changeOverlay.show([], [], 'before')
  clearance?.setWorld(shown)
  clearance?.setCompare(compareState())
  layout?.setProposal(proposalState())
}

const rearrangeHooks: RearrangeHooks = {
  request: async (goal) => {
    const base = world
    if (!base) throw new Error('No room loaded')
    const mySession = session
    const result = await askForLayout(goal, base)
    if (mySession !== session || world !== base) return result // you left or changed the room while the AI was thinking
    proposal = result
    showing = result.changes.length > 0 ? 'after' : 'before'
    applyView()
    return result
  },
  setShowing: (which) => {
    showing = which
    applyView()
  },
  keep: () => {
    if (!proposal) return
    world = proposal.world // Work mode only: play mode uses originalWorld
    proposal = null
    showing = 'before'
    applyView()
  },
  reset: () => {
    world = originalWorld
    proposal = null
    showing = 'before'
    applyView()
  },
}

/** The Layout tab opens the panel (voice, then the clearance check); pressing it again closes it. The 3D view stays visible. */
function toggleLayout(): void {
  if (!world || play) return
  layoutOpen = !layoutOpen
  if (layoutOpen) {
    layout ??= createLayoutPanel(screens.layoutContainer, mode === 'work' ? rearrangeHooks : undefined)
    layout.setProposal(proposalState())
    if (viewer) {
      clearance ??= createClearancePanel(screens.layoutContainer, viewer, viewedWorld() ?? world, rearrangeHooks.setShowing)
      clearance.setCompare(compareState())
    }
  } else {
    layout?.stopRecording() // closing the panel must not leave the microphone on
  }
  clearance?.setActive(layoutOpen) // the route and person only show while the Layout tab is open
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
    const started = await startPlay(screens.viewContainer, originalWorld ?? world, showViewer) // always the room as loaded, never a proposed layout
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
async function openWorld(title: string, load: () => Promise<World>, nextMode: Mode): Promise<void> {
  closeAll()
  mode = nextMode
  screens.setMode(nextMode)
  screens.setStatus(`Loading ${title.toLowerCase()}…`)
  screens.show('loading')
  try {
    const [loaded] = await Promise.all([load(), wait(1000)])
    world = loaded
    originalWorld = loaded
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

  onUseExample: (mode) => openWorld('Example room', loadExampleWorld, mode),

  // Development only: the production build leaves this out.
  onUseTestRoom: import.meta.env.DEV ? () => openWorld('Test room', loadTestWorld, 'game') : undefined,
  onUseGapTestRoom: import.meta.env.DEV ? () => openWorld('Narrow-gap test room', loadClearanceTestWorld, 'work') : undefined, // Work mode: that is where Rearrange and Before / After live

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
