import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Built files land in web/dist and are served by the Flask app (app.py).
// `npm run dev` proxies API calls to the running Flask server for live-reload development.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:8750',
      '/login': 'http://localhost:8750',
      '/logout': 'http://localhost:8750',
    },
  },
})
