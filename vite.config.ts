import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        /* Split the heavyweight libraries into parallel, long-cacheable
         * chunks instead of one monolithic bundle. */
        manualChunks: {
          'vendor-three': ['three', '@react-three/fiber', '@react-three/drei'],
          'vendor-motion': ['gsap', 'lenis'],
        },
      },
    },
  },
})
