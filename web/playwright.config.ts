import { defineConfig } from '@playwright/test'

// One end-to-end smoke test against the production build (vite preview), so it checks what ships.
// Locally you can use your installed Chrome instead of downloading Chromium: E2E_CHANNEL=chrome npm run e2e
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:4189',
    channel: process.env.E2E_CHANNEL || undefined,
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    // Software 3D, so the three.js canvas works on machines without a GPU (like CI).
    launchOptions: { args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
  },
  webServer: {
    command: 'npm run build && npm run preview -- --port 4189 --strictPort',
    url: 'http://localhost:4189',
    reuseExistingServer: false,
    timeout: 180_000,
  },
})
