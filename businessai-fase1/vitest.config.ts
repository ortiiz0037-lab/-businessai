import { defineConfig } from 'vitest/config'

try {
  process.loadEnvFile('.env.local')
} catch {
  // Sin .env.local: las pruebas de Supabase se omiten.
}

export default defineConfig({
  test: { testTimeout: 30000, include: ['tests/**/*.test.ts'] },
})
