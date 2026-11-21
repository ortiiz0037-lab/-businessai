import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

try {
  process.loadEnvFile('.env.local')
} catch {
  // Sin .env.local: las pruebas de Supabase se omiten.
}

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: { testTimeout: 30000, include: ['tests/**/*.test.ts'] },
})
