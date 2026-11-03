import { defineConfig } from 'vite'

// The API paths served by the Python server (server/). The page calls them with relative addresses like fetch('/scan'),
// and in development this forwards them to the server on port 8000. (In production the same server serves this page.)
const API_PATHS = /^\/(scan|world|layout|character|render|transcribe|score|health)(\/|$)/

export default defineConfig({
  server: {
    // Lets the dev server read ../shared (the world.json contract) which sits outside /web.
    fs: { allow: ['..'] },
    proxy: { [API_PATHS.source]: 'http://localhost:8000' },
  },
  // Prepare three.js and Rapier up front. Otherwise Vite finds them mid-session, re-prepares
  // them, and the first click on "Use example room" or "Play" can fail until you refresh.
  optimizeDeps: {
    include: ['three', 'three/addons/controls/OrbitControls.js', '@dimforge/rapier3d-compat'],
  },
})
