import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  // Relative base -> works when hosted on GitHub Pages under any repo path
  base: './',
  plugins: [react()],
})
