import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'

import { tanstackRouter } from '@tanstack/router-plugin/vite'
import { fileURLToPath, URL } from 'node:url'

const base = '/'

export default defineConfig({
  base,
  plugins: [
    wasm(),
    topLevelAwait(),
    devtools(),
    tanstackRouter({
      target: 'react',
      autoCodeSplitting: true,
    }),
    viteReact(),
    tailwindcss(),
    VitePWA({
      registerType: 'prompt',
      manifest: {
        name: 'ClaraPOS',
        short_name: 'ClaraPOS',
        description: 'Sistema POS y gestion de negocio offline-first',
        display: 'standalone',
        scope: '/',
        start_url: '/',
        orientation: 'any',
        theme_color: '#2563eb',
        background_color: '#ffffff',
        categories: ['business', 'finance', 'productivity'],
        icons: [
          {
            src: '/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        maximumFileSizeToCacheInBytes: 5000000,
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest}'],
        navigateFallback: `${base}index.html`,
        navigateFallbackAllowlist: [/.*/],
      },
      devOptions: {
        enabled: true,
        type: 'module',
      },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 4000,
    allowedHosts: true,
    proxy: {
      '/proxy/bcv': {
        target: 'https://nexo21-tax-rate-api.onrender.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/proxy\/bcv/, '/api/rates/bcv'),
      },
    },
  },
  worker: {
    format: 'es',
    plugins: () => [wasm(), topLevelAwait()],
  },
  build: {
    target: 'esnext',
  },
  optimizeDeps: {
    exclude: ['@journeyapps/wa-sqlite', '@powersync/web'],
    include: ['@powersync/web > uuid', '@powersync/web > event-iterator'],
  },
})
