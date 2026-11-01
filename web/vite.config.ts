import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    // Lets the dev server read ../shared (the world.json contract) which sits outside /web.
    fs: { allow: ['..'] },
  },
})
