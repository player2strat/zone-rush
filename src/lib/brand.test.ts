import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { BRAND } from './brand'

// Guards against the two color sources drifting apart.
const CSS_NAME: Record<keyof typeof BRAND, string> = {
  marigold: 'marigold', blue: 'blue', pink: 'pink', red: 'red', lightblue: 'lightblue', green: 'green',
  marigoldDeep: 'marigold-deep', greenDeep: 'green-deep', pinkDeep: 'pink-deep', redDeep: 'red-deep',
  paper: 'paper', surface: 'surface', line: 'line', lineStrong: 'line-strong',
  ink: 'ink', inkSoft: 'ink-soft', inkMuted: 'ink-muted', inkFaint: 'ink-faint', inkGhost: 'ink-ghost',
}

describe('brand.ts matches index.css tokens', () => {
  const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8')
  for (const [key, cssName] of Object.entries(CSS_NAME) as [keyof typeof BRAND, string][]) {
    it(`--${cssName}`, () => {
      const m = css.match(new RegExp(`--${cssName}:\\s*(#[0-9A-Fa-f]{6})`))
      expect(m?.[1].toUpperCase()).toBe(BRAND[key].toUpperCase())
    })
  }
})
