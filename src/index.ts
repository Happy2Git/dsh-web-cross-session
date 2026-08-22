/**
 * dsh-web-cross-session — host half.
 *
 * Mounts the cross-session capability for the Web UI:
 *  1. the session-reference resolver service (own lifecycle, configurable),
 *  2. the model-facing session-query tools (session_search & friends),
 *     config-gated so a deployment can keep the shipped tools-off default,
 *  3. the /xssn/* routes the browser half speaks (candidates, prepare, send),
 *  4. the /xsend command: forward a message into another live session.
 *
 * The composition patch (cordis.patch.yml) enables the persisted FTS index
 * that the sidebar content search and the tools both need; this file owns
 * everything else.
 *
 * @module dsh-web-cross-session
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-session-query'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  SessionReferenceResolver,
} from '@deepseek-ai/dsh-session-reference'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { registerRoutes } from './routes.ts'
import type { CrossSessionDeps } from './routes-core.ts'

export const name = 'cross-session'

export interface Config {
  /** Mount the model-facing session-query tools globally; false keeps the shipped tools-off default. */
  readonly mountModelTools?: boolean
  /** Maximum distinct sessions one reference may cite; the core hard cap is 3. */
  readonly maxReferences?: number
  /** Candidate discovery bound for the composer @ picker. */
  readonly candidateLimit?: number
  /** Per-source snapshot byte cap, UTF-8. */
  readonly maxReferenceBytes?: number
  /**
   * True renders references as inline untrusted snapshots (up to 65 KB per
   * source); false (default) emits a short pointer the model resolves with
   * the session-query tools.
   */
  readonly inlineSnapshot?: boolean
}

export const Config: z<Config> = z.object({
  mountModelTools: z.boolean().default(true),
  maxReferences: z.number().step(1).min(1).max(3).default(3),
  candidateLimit: z.number().step(1).min(1).default(50),
  maxReferenceBytes: z.number().step(1).min(1).default(65_536),
  inlineSnapshot: z.boolean().default(false),
})

export const inject = ['agents', 'sessions', 'sessionQuery'] as const

/** The producer tag recorded on every relay message this plugin forwards. */
export const RELAY_PRODUCER = 'dsh-web-cross-session'

export function apply(ctx: Context, config: Config): void {
  // 1. The reference resolver: exact reads, projection, budgets, and the
  //    untrusted snapshot rendering. Its only dependency (ctx.sessionQuery)
  //    is the shared service the web composition already mounts.
  ctx.plugin(SessionReferenceResolver, {
    maxReferences: config.maxReferences ?? 3,
    candidateLimit: config.candidateLimit ?? 50,
    maxReferenceBytes: config.maxReferenceBytes ?? 65_536,
  })

  // 2. Model-facing tools, config-gated and degradation-safe. The tool
  //    package is a module-form plugin; invoking its apply on the scoped
  //    context is the conditional equivalent of mounting its composition row.
  //    The package is not part of every dsh install's dependency closure, so
  //    the import is dynamic: when it is absent, the plugin warns and keeps
  //    references, search, and forwarding working.
  if (config.mountModelTools === true) {
    ctx.inject(['tools', 'systemPrompt', 'sessionQuery'], (toolCtx) => {
      toolCtx.effect(() => {
        void import('@deepseek-ai/dsh-tool-session-query')
          .then(({ apply: applySessionQueryTools }) => {
            applySessionQueryTools(toolCtx, {})
          })
          .catch((error: unknown) => {
            toolCtx.logger.warn(
              'cross-session: the five model session-query tools are NOT mounted (%s). '
              + 'References, /xsend, and search still work; the model itself cannot search history. '
              + 'Fix: install @deepseek-ai/dsh-tool-session-query next to this plugin'
              + ' (pnpm dsh plugin --profile web add github:...#<sha> resolves it), or set mountModelTools: false to silence this warning.',
              error instanceof Error ? error.message : String(error),
            )
          })
        // Registrations die with this inject scope; nothing to undo here.
        return () => { }
      }, 'cross-session: model session-query tools')
    })
  }

  // 3. The /xssn/* routes for the browser half.
  ctx.inject(['webServer'], (httpCtx) => {
    const deps: CrossSessionDeps = {
      getAgent: sessionId => ctx.agents.get(sessionId) ?? undefined,
      listCandidates: (agent, query, limit, signal) =>
        resolverFor(ctx).listCandidates(agent, query, limit, signal),
      prepare: (agent, references, signal) =>
        resolverFor(ctx).prepare(agent, [], references, signal),
      forward: (target, fromSessionId, text) => {
        target.inject(relayMessage(fromSessionId, text))
      },
      corpus: cachedCorpus(signal => {
        const parents = new Map<string, string>()
        const cwds = new Map<string, string>()
        return ctx.sessionQuery.listSessions(signal).then((records) => {
          for (const record of records) {
            const parent = record.header.parentSession
            if (parent !== undefined) parents.set(record.header.id, parent)
            if (record.header.cwd !== undefined) cwds.set(record.header.id, record.header.cwd)
          }
          return { parents, cwds }
        })
      }),
      inlineSnapshot: config.inlineSnapshot === true,
    }
    httpCtx.effect(() => registerRoutes(httpCtx, deps), 'cross-session: /xssn/* routes')
  })

  // 4. /xsend: forward a message into another live session without waking it.
  ctx.inject(['commands'], (cmdCtx) => {
    cmdCtx.effect(() => cmdCtx.commands.register({
      name: 'xsend',
      description: 'Forward a message to another live session: /xsend <sessionId> <text>',
      handler: ({ agent, rawInput }) => {
        const match = /^(\S+)\s+([\s\S]*)$/.exec(rawInput.trim())
        if (match === null) return { kind: 'error', text: 'usage: /xsend <sessionId> <text>' }
        const targetId = match[1]
        const text = match[2]?.trim() ?? ''
        if (text === '') return { kind: 'error', text: 'usage: /xsend <sessionId> <text>' }
        const target = ctx.agents.get(targetId as SessionId)
        if (target === undefined) {
          const live = ctx.sessions.list().map(session => session.header.id)
          const shown = live.slice(0, 8).join(', ')
          const tail = live.length > 8 ? `, … (${live.length} total)` : ''
          return {
            kind: 'error',
            text: `target session ${JSON.stringify(targetId)} is not live; open it in the web UI first. Live sessions: ${shown}${tail}`,
          }
        }
        target.inject(relayMessage(agent.id, text))
        return { kind: 'success', text: `forwarded ${text.length} chars to ${targetId}` }
      },
    }), 'cross-session: /xsend')
  })
}

/** How long one full-corpus observation answers repeated requests. The picker fires per keystroke; each observation costs a full session listing plus title reads. */
const CORPUS_TTL_MS = 1500

type CorpusObservation = Awaited<ReturnType<CrossSessionDeps['corpus']>>

/**
 * Wrap one corpus loader behind a short TTL cache. A cache hit ignores the
 * fresh signal — the window is bounded and the corpus is advisory data
 * (parent links, workspace labels), never message content.
 */
function cachedCorpus(load: (signal: AbortSignal) => Promise<CorpusObservation>): CrossSessionDeps['corpus'] {
  let cache: { at: number; value: CorpusObservation } | undefined
  return (signal) => {
    if (cache !== undefined && Date.now() - cache.at < CORPUS_TTL_MS) return Promise.resolve(cache.value)
    return load(signal).then((value) => {
      cache = { at: Date.now(), value }
      return value
    })
  }
}

/** The mounted resolver, resolved lazily so routes only fail when actually used. */
function resolverFor(ctx: Context): SessionReferenceResolver {
  const resolver = ctx.get('sessionReferenceResolver') as SessionReferenceResolver | undefined
  if (resolver === undefined) {
    throw new Error('cross-session: sessionReferenceResolver is not mounted')
  }
  return resolver
}

/**
 * One relay message: user-role, plugin-sourced, relay-formed. The origin
 * prefix is part of the model-facing text because the durable source record
 * is not rendered into the prompt; the message rides agent.inject(), which
 * never wakes the target.
 */
function relayMessage(fromSessionId: SessionId, text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: `(Forwarded from session ${fromSessionId})\n${text}` }],
    source: { kind: 'plugin', plugin: RELAY_PRODUCER, form: 'relay' },
  })
}
