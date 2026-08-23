/**
 * One-time FTS index warmup.
 *
 * A fresh deployment builds the whole persisted corpus into the FTS index on
 * the first query that reaches {@link SessionQueryService.searchSessions}
 * (~30s per hundred sessions, one large transaction). Left to chance that
 * cost lands on a user's first real search. Scheduling one throwaway query
 * shortly after boot moves the build to an idle moment instead.
 *
 * The backfill runs before MATCH and does not depend on the term; any
 * non-empty query merely makes the call legal, so the result is discarded.
 *
 * @module dsh-web-cross-session/warmup
 */

import type { Context } from '@deepseek-ai/cordis'

/** Any common term works — see the module doc for why it is arbitrary. */
export const WARMUP_QUERY = 'the'

/**
 * Schedule the throwaway query that triggers the first-search backfill.
 * @param ctx - host context with the mounted `sessionQuery` service.
 * @param delayMs - milliseconds to wait after mount before warming.
 * @returns disposer cancelling a not-yet-fired warmup.
 */
export function scheduleIndexWarmup(ctx: Context, delayMs: number): () => void {
  const timer = setTimeout(() => {
    void ctx.sessionQuery.searchSessions({ query: WARMUP_QUERY, limit: 1 }).catch((error: unknown) => {
      // Best-effort by design: an aborted or failed warmup only means the
      // next real search pays the build itself, exactly as before.
      ctx.logger.warn('cross-session: index warmup skipped (%s)', error instanceof Error ? error.message : String(error))
    })
  }, delayMs)
  return () => clearTimeout(timer)
}
