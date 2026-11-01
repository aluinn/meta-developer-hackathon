import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    // Lets the dev server read ../shared (the world.json contract) which sits outside /web.
    fs: { allow: ['..'] },
  },
  // Prepare three.js up front. Otherwise Vite finds it mid-session, re-prepares it,
  // and the first click on "Use example room" can fail until you refresh.
  optimizeDeps: {
    include: ['three', 'three/addons/controls/OrbitControls.js'],
  },
})
