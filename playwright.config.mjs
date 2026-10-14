// Playwright browser-test settings. Run with: npx playwright test
// It starts Python's built-in static file server — no backend code is involved.
import { defineConfig, devices } from '@playwright/test';

const PORT = 8123;
// To test a deployed copy instead, set BASE_URL, e.g.
//   BASE_URL=https://your-site.netlify.app npx playwright test
const BASE_URL = process.env.BASE_URL;

export default defineConfig({
  testDir: 'tests',
  testMatch: '*.spec.mjs',
  timeout: 45000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: BASE_URL || `http://127.0.0.1:${PORT}` },
  webServer: BASE_URL ? undefined : {
    command: `python -m http.server ${PORT} --bind 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: true,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } }, grepInvert: /@mobile/ },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, grep: /@mobile/ },
  ],
});
