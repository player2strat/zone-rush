import { describe, it, expect } from 'vitest'
import { dueMilestone, MILESTONE_GRACE_MS } from './milestones'

const MIN = 60_000

describe('dueMilestone', () => {
  it('sends nothing before the first mark', () => {
    expect(dueMilestone(180, 91 * MIN, [])).toBeNull()
  })

  it('sends halfway right at the mark, quoting the minutes left', () => {
    const m = dueMilestone(180, 90 * MIN, [])
    expect(m?.key).toBe('halfway')
    expect(m?.message).toContain('90 minutes left')
  })

  it('rounds minutes up, so a check a few seconds late still says 30', () => {
    const m = dueMilestone(180, 30 * MIN - 4_000, ['halfway'])
    expect(m?.key).toBe('30min')
    expect(m?.message).toContain('30 minutes remaining')
  })

  it('never sends one twice', () => {
    expect(dueMilestone(180, 89 * MIN, ['halfway'])).toBeNull()
  })

  it('still sends within the grace window, with the real time left', () => {
    const m = dueMilestone(180, 27 * MIN, ['halfway'])
    expect(m?.key).toBe('30min')
    expect(m?.message).toContain('27 minutes remaining')
  })

  it('skips a milestone that is past the grace window', () => {
    expect(dueMilestone(180, 30 * MIN - MILESTONE_GRACE_MS - 1, ['halfway'])).toBeNull()
  })

  it('drops an earlier unsent milestone once a later one is due', () => {
    // Away from halfway (90) until 4 minutes left: only the 5 minute one goes.
    const m = dueMilestone(180, 4 * MIN, [])
    expect(m?.key).toBe('5min')
    expect(m?.message).toContain('4 minutes left')
  })

  it('in a 60 minute game halfway and 30 coincide; halfway wins once', () => {
    expect(dueMilestone(60, 30 * MIN, [])?.key).toBe('halfway')
    expect(dueMilestone(60, 29 * MIN, ['halfway'])).toBeNull()
  })

  it('leaves out marks that are not inside the game', () => {
    // 30 minute game: no "30 minutes remaining" at the start.
    expect(dueMilestone(30, 30 * MIN, [])).toBeNull()
    expect(dueMilestone(30, 15 * MIN, [])?.key).toBe('halfway')
  })

  it('skips halfway in very short games', () => {
    expect(dueMilestone(8, 4 * MIN, ['5min'])).toBeNull()
  })

  it('says "1 minute" in the singular', () => {
    expect(dueMilestone(180, 1 * MIN, ['halfway', '30min'])?.message).toContain('1 minute left')
  })

  it('sends nothing once time is up', () => {
    expect(dueMilestone(180, 0, [])).toBeNull()
  })
})
