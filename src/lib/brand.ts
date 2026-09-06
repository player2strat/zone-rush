// =============================================================================
// Foray — brand palette for code that can't read CSS variables.
//
// Mapbox paint properties (fill-color, line-color, …) need literal color
// strings, so GameMap and ZoneBuilder import from here. Everything else should
// use the CSS custom properties in src/index.css, e.g. `var(--ink)`.
// src/lib/brand.test.ts asserts these values match index.css.
// =============================================================================

export const BRAND = {
  marigold: '#FFD626',
  blue: '#1EB2F2',
  pink: '#E67DD1',
  red: '#FF4443',
  lightblue: '#67DAF5',
  green: '#28B770',

  marigoldDeep: '#7A6400',
  greenDeep: '#1E7A4C',
  pinkDeep: '#9B4F8C',
  redDeep: '#B02F2E',

  paper: '#FDFFF1',
  surface: '#FFFFFF',
  line: '#E6E5DA',
  lineStrong: '#D6D5CA',
  ink: '#202122',
  inkSoft: '#3A3935',
  inkMuted: '#55544E',
  inkFaint: '#6F6E66',
  inkGhost: '#8F8E85',
} as const

export type BrandColor = keyof typeof BRAND
