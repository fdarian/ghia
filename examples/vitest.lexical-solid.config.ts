import { ghia } from 'ghia'
import { solid } from '@ghia/solid/vite'
import { defineConfig } from 'vitest/config'

// Spike: vanilla Lexical inside a @ghia/solid component. Same plugins as the Kobalte suite.
export default defineConfig({
  plugins: [ghia(), solid()],
  test: { environment: 'node', setupFiles: ['@ghia/native/testing-setup'], include: ['lexical/solid*.test.tsx'] },
})
