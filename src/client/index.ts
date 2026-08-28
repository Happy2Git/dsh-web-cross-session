/**
 * dsh-web-cross-session — browser half.
 *
 * Two input-pipeline sources plus one second-level picker overlay:
 *
 *  - '@' sessions source: level one lists main sessions only (subagent
 *    sessions ride their parent's `children`); picking a session without
 *    children inserts a reference directly, picking one with children opens
 *    the picker (main session + subagents) and inserts the settled row at the
 *    original '@' span via the scoped input event.
 *  - '/' cross-session source: claims `/xsend ` on space and opens the picker
 *    in send mode with the typed text; the settled target forwards it through
 *    the host route.
 *
 * References serialize on submit through /xssn/serialize: the host decides
 * between the untrusted inline snapshot and the short pointer form (pointer
 * by default, resolved by the model with the session-query tools).
 *
 * Cross-session fragment search lives in the core sidebar search (session.search
 * + the conversation locate reveal); this plugin no longer ships its own panel.
 *
 * @module dsh-web-cross-session/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  InputTriggerServiceContract,
  InputTriggerSource,
  PickOutcome,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import {
  decodeSessionReferenceUri,
  encodeSessionReferenceUri,
  openReferencePicker,
  openSendPicker,
  PickerOverlay,
  TRIGGER_NAME,
  type PickerOption,
} from './picker.tsx'

export const inject = ['inputTriggers', 'sessions', 'slots'] as const

export { TRIGGER_NAME } from './picker.tsx'

/** Host routes this half speaks; same origin, application/json fence. */
const XSSN_CANDIDATES = '/xssn/candidates'
const XSSN_SERIALIZE = '/xssn/serialize'
const XSSN_SEND = '/xssn/send'

interface ChildItem {
  readonly id: string
  readonly label: string
}

interface CandidateItem {
  readonly id: string
  readonly label: string
  readonly children: readonly ChildItem[]
}

interface CandidatesPayload {
  readonly items: readonly CandidateItem[]
}

interface SerializePayload {
  readonly text: string
}

/** POST one JSON body to a host route and decode the JSON response. */
async function routeFetch<T>(path: string, body: unknown, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  const data = (await response.json()) as { error?: { code?: string; message: string } } | T
  if (!response.ok) {
    const error = (data as { error?: { message?: string } }).error
    throw new Error(error?.message ?? `POST ${path} failed with status ${response.status}`)
  }
  return data as T
}

/** One candidate entry captured at menu time; onPick resolves it by hint. */
interface CandidateEntry {
  readonly label: string
  readonly children: readonly ChildItem[]
}

/**
 * The client sessions feed, structurally mirrored: the host package
 * (@deepseek-ai/dsh-session) and the client runtime both augment
 * `ctx.sessions` with different types, so the plugin resolves the facet
 * through ctx.get with a local structural interface (the out-of-tree
 * convention; drift from upstream is contained here).
 */
interface ClientSessionsFacet {
  scope(sessionId: string): ClientContext | undefined
  scopeOf(ctx: ClientContext): string | undefined
  open(sessionId: string): void
  list: {
    getSnapshot(): { byId: Record<string, { id: string; displayTitle?: string; parentId?: string }> }
  }
}

export function apply(ctx: ClientContext): void {
  const inputTriggers = ctx.get('inputTriggers') as InputTriggerServiceContract | undefined
  if (inputTriggers === undefined) {
    throw new Error('cross-session: inputTriggers service is unavailable')
  }

  const sessions = ctx.get('sessions') as ClientSessionsFacet | undefined
  if (sessions === undefined) {
    throw new Error('cross-session: sessions service is unavailable')
  }

  // The menu-open snapshot for onPick resolution (one menu at a time). The
  // serialize identity rides each ref itself (from-session encoded at pick
  // time), so no module-level session state survives between menus.
  let candidateEntries: Map<string, CandidateEntry> = new Map()

  const referenceSource: InputTriggerSource = {
    trigger: '@',
    name: TRIGGER_NAME,
    order: 10,
    async candidates(session, { query, signal }) {
      const payload = await routeFetch<CandidatesPayload>(XSSN_CANDIDATES, {
        sessionId: session.sessionId,
        query,
      }, signal)
      candidateEntries = new Map(payload.items.map(item => [item.id, {
        label: item.label,
        children: item.children,
      }]))
      return payload.items.map(item => ({
        name: item.label,
        // The menu renders name and description only; the session id rides the
        // description so the user can copy it for /xsend.
        description: item.id,
        hint: item.id,
      }))
    },
    onPick(pick): PickOutcome {
      const id = pick.candidate.hint ?? ''
      if (id === '') return undefined
      const entry = candidateEntries.get(id)
      if (entry === undefined) return undefined
      const actx = sessions.scope(pick.session.sessionId)
      if (actx === undefined) return undefined
      if (entry.children.length > 0) {
        // Second level: main session + its subagent children; the picker binds
        // every inserted reference to THIS composer via fromSessionId.
        openReferencePicker(actx, pick.span, { id, label: entry.label }, entry.children, pick.session.sessionId)
        return 'handled'
      }
      const uri = encodeSessionReferenceUri({ f: pick.session.sessionId, t: id, l: entry.label })
      return {
        insert: {
          source: TRIGGER_NAME,
          ref: uri,
          label: entry.label,
          clipboardText: `@[${entry.label}](${uri})`,
        },
      }
    },
    codec: {
      // The clipboard form is the same URI — copy/paste keeps a lossless,
      // self-describing reference instead of a bare id.
      clipboardText: (ref) => {
        const payload = decodeSessionReferenceUri(ref)
        return payload === undefined ? ref : encodeSessionReferenceUri(payload)
      },
      async serialize(ref, signal) {
        const payload = decodeSessionReferenceUri(ref)
        if (payload === undefined) {
          // Never a silent downgrade to the clipboard text: an unrecognized
          // ref blocks the send so the user can re-insert the chip.
          throw new Error('cross-session: unrecognized session reference; delete the chip and re-insert it with @')
        }
        const response = await routeFetch<SerializePayload>(XSSN_SERIALIZE, {
          sessionId: payload.f,
          references: [{ sessionId: payload.t, ...(payload.l === undefined ? {} : { label: payload.l }) }],
        }, signal)
        return response.text
      },
    },
  }

  // Live session rows for the send picker, from the client list feed (zero RPC).
  const sendOptions = (): PickerOption[] => {
    const { byId } = sessions.list.getSnapshot()
    return Object.values(byId).map(entry => ({
      id: entry.id,
      label: entry.displayTitle || entry.id,
      subagent: entry.parentId !== undefined,
    }))
  }

  /** Open the send picker for one /xsend line, shared by claim and enter paths. */
  const openSendFlow = (actx: ClientContext, args: string): PickOutcome => {
    const text = args.trim()
    if (text === '') {
      // Bare /xsend stays with the host command's usage error.
      return undefined
    }
    const fromSessionId = sessions.scopeOf(actx)
    if (fromSessionId === undefined) {
      // Cannot happen through the input pipeline (the enter path resolved a
      // scope above); the claim path surfaces it as its own error.
      return undefined
    }
    openSendPicker(actx, text, sendOptions(), async (option, signal) => {
      await routeFetch(XSSN_SEND, {
        fromSessionId,
        targetSessionId: option.id,
        content: text,
      }, signal)
    })
    return 'handled'
  }

  const xsendSource: InputTriggerSource = {
    trigger: '/',
    name: 'cross-session',
    candidates: async () => [],
    // The host command catalog owns the '/' menu rows; this source only
    // intercepts the '/xsend ' flow, so menu picks never reach it.
    onPick: () => undefined,
    matchSpace(_session, token) {
      if (token !== '/xsend') return undefined
      return {
        claim: {
          token: '/xsend ',
          hint: '<text> — 转发到所选会话',
          submit: async (args, actx) => {
            const outcome = openSendFlow(actx, args)
            if (outcome === undefined) {
              return { kind: 'error', text: 'usage: /xsend <text>（随后选择目标会话）' }
            }
            return { kind: 'success', text: '' }
          },
        },
      }
    },
    // Enter-path interception: ui-commands yields on argued lines of host
    // commands without an input descriptor, so '/xsend <text>' reaches us.
    async matchEnter(session, line) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('/xsend ')) return undefined
      const text = trimmed.slice('/xsend '.length)
      const actx = sessions.scope(session.sessionId)
      if (actx === undefined) return undefined
      return openSendFlow(actx, text)
    },
  }

  ctx.effect(() => inputTriggers.registerSource(referenceSource), 'cross-session: @ session source')
  ctx.effect(() => inputTriggers.registerSource(xsendSource), 'cross-session: /xsend source')

  // The second-level picker overlay, registered like the slash menu's MenuView:
  // the slot frame hands session ids; the store is a module singleton.
  ctx.inject(['slots'], (scope) => {
    scope.slots.inject('conversation.input.overlay', () => scope.slots.register({
      name: 'conversation.input.overlay',
      id: 'cross-session-picker',
      order: 5,
      inject: () => ({}),
    }, PickerOverlay))
  })
}
