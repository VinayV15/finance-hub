import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Built files land in web/dist: served by the Flask app on the Mac, or published to GitHub Pages (cloud mode).
// `npm run dev` proxies API calls to the running Flask server for live-reload development.
// VITE_BASE is the site's sub-path when published (e.g. /finance-hub/ on GitHub Pages).
export default defineConfig({
  base: process.env.VITE_BASE || '/',
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:8750',
      '/login': 'http://localhost:8750',
      '/logout': 'http://localhost:8750',
    },
  },
})
