// =============================================================================
// Foray — brand icons
//
// The designer's icon set (colored circle + black symbol), used in place of
// emoji wherever a matching icon exists. Each icon has one fixed brand color so
// it reads the same everywhere; the files live in public/icons/ as
// `<name>-<color>.png` (resized from the 2160px originals in "Design Elements").
// To use another color, resize that variant into public/icons/ and pass `color`.
//
// Sized in `em` so an icon scales with the text around it, the way an emoji
// does — `<span style={{ fontSize: '2.5rem' }}><Icon name="flag" /></span>`
// gives a big flag.
//
// Usage:
//   <Icon name="trophy" />                       decorative, next to text
//   <Icon name="first" label="1st place" />      stands alone, so it gets alt text
//   <EmojiIcon emoji={badge.emoji} />            data that stores an emoji: draws
//                                                the matching icon, else the emoji
//
// Plain-text places (chat messages, the activity log, map label text, reel
// captions) can't hold images, so they keep their emoji.
// =============================================================================

import type { CSSProperties } from 'react'

export type IconName =
  | 'trophy' | 'flag' | 'stopwatch' | 'lock' | 'unlocked' | 'arrow'
  | 'first' | 'second' | 'third'

export type IconColor = 'marigold' | 'lightblue' | 'richblue' | 'pink' | 'green' | 'red'

const DEFAULT_COLOR: Record<IconName, IconColor> = {
  trophy: 'marigold',
  first: 'marigold',
  second: 'lightblue',
  third: 'pink',
  lock: 'richblue',
  unlocked: 'green',
  stopwatch: 'lightblue',
  flag: 'pink',
  arrow: 'green',
}

// Emoji that have a designer icon. 🚩 is only used as a warning, so it gets red
// (the brand's warning color).
const EMOJI_ICONS: Record<string, { name: IconName; color?: IconColor }> = {
  '🏆': { name: 'trophy' },
  '🥇': { name: 'first' },
  '🥈': { name: 'second' },
  '🥉': { name: 'third' },
  '🔒': { name: 'lock' },
  '🔓': { name: 'unlocked' },
  '⏳': { name: 'stopwatch' },
  '⏱': { name: 'stopwatch' },
  '⏱️': { name: 'stopwatch' },
  '🏁': { name: 'flag' },
  '🏴': { name: 'flag' },
  '🚩': { name: 'flag', color: 'red' },
}

interface IconProps {
  name: IconName
  color?: IconColor
  /** CSS size; defaults to a little larger than the text, like an emoji. */
  size?: string
  /** Alt text. Leave out when the icon sits next to words that say the same thing. */
  label?: string
  style?: CSSProperties
}

export function Icon({ name, color, size = '1.2em', label, style }: IconProps) {
  return (
    <img
      src={`/icons/${name}-${color ?? DEFAULT_COLOR[name]}.png`}
      alt={label ?? ''}
      aria-hidden={label ? undefined : true}
      draggable={false}
      style={{
        width: size,
        height: size,
        display: 'inline-block',
        verticalAlign: '-0.25em',
        flexShrink: 0,
        ...style,
      }}
    />
  )
}

export function EmojiIcon({ emoji, color, ...rest }: { emoji: string } & Omit<IconProps, 'name'>) {
  const match = EMOJI_ICONS[emoji]
  if (!match) return <>{emoji}</>
  return <Icon {...rest} name={match.name} color={color ?? match.color} />
}
