import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    // Lets the dev server read ../shared (the world.json contract) which sits outside /web.
    fs: { allow: ['..'] },
  },
  // Prepare three.js and Rapier up front. Otherwise Vite finds them mid-session, re-prepares
  // them, and the first click on "Use example room" or "Play" can fail until you refresh.
  optimizeDeps: {
    include: ['three', 'three/addons/controls/OrbitControls.js', '@dimforge/rapier3d-compat'],
  },
})
