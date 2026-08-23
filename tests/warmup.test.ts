import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { scheduleIndexWarmup, WARMUP_QUERY } from '../src/warmup.ts'

interface WarmupCtx {
  sessionQuery: { searchSessions: ReturnType<typeof vi.fn> }
  logger: { warn: ReturnType<typeof vi.fn> }
}

function makeCtx(searchImpl?: () => Promise<unknown>): WarmupCtx {
  return {
    sessionQuery: {
      searchSessions: vi.fn().mockImplementation(searchImpl ?? (() => Promise.resolve({ items: [] }))),
    },
    logger: { warn: vi.fn() },
  }
}

describe('scheduleIndexWarmup', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('fires one discarded search after the configured delay', async () => {
    const ctx = makeCtx()
    const dispose = scheduleIndexWarmup(ctx as unknown as Parameters<typeof scheduleIndexWarmup>[0], 10_000)
    expect(ctx.sessionQuery.searchSessions).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(9_999)
    expect(ctx.sessionQuery.searchSessions).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(ctx.sessionQuery.searchSessions).toHaveBeenCalledExactlyOnceWith({ query: WARMUP_QUERY, limit: 1 })
    expect(ctx.logger.warn).not.toHaveBeenCalled()
    dispose()
  })

  it('reports a failed warmup through warn and keeps the failure contained', async () => {
    const ctx = makeCtx(() => Promise.reject(new Error('db locked')))
    const dispose = scheduleIndexWarmup(ctx as unknown as Parameters<typeof scheduleIndexWarmup>[0], 0)
    await vi.advanceTimersByTimeAsync(0)
    expect(ctx.sessionQuery.searchSessions).toHaveBeenCalledTimes(1)
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      'cross-session: index warmup skipped (%s)',
      'db locked',
    )
    dispose()
  })

  it('cancels a not-yet-fired warmup on disposal', async () => {
    const ctx = makeCtx()
    const dispose = scheduleIndexWarmup(ctx as unknown as Parameters<typeof scheduleIndexWarmup>[0], 5_000)
    dispose()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(ctx.sessionQuery.searchSessions).not.toHaveBeenCalled()
  })
})
