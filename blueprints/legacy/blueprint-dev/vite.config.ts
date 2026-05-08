import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import { blueprintsPlugin } from './vite-plugin-blueprints'

export default defineConfig({
  plugins: [
    vue(),
    blueprintsPlugin(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  }
})
