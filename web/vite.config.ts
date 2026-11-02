import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    // Lets the dev server read ../shared (the world.json contract) which sits outside /web.
    fs: { allow: ['..'] },
    // The server (Aluinn's, port 8000) answers these paths. We forward them from port 5173, so the
    // web app can use the same relative paths (like "/transcribe") in development and in production.
    proxy: Object.fromEntries(
      ['/scan', '/world', '/layout', '/render', '/transcribe', '/score', '/health'].map((path) => [
        path,
        'http://localhost:8000',
      ]),
    ),
  },
  // Prepare three.js and Rapier up front. Otherwise Vite finds them mid-session, re-prepares
  // them, and the first click on "Use example room" or "Play" can fail until you refresh.
  optimizeDeps: {
    include: ['three', 'three/addons/controls/OrbitControls.js', '@dimforge/rapier3d-compat'],
  },
})
