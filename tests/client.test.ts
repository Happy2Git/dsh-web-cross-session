// @vitest-environment jsdom
/**
 * Browser-half tests: the '@' source (level one = main sessions; children
 * open the second-level picker), the '/xsend ' claim, the serialize codec
 * (pointer form through /xssn/serialize), and the picker store's insert and
 * send flows.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, TRIGGER_NAME } from '../src/client/index.ts'
import {
  decodeSessionReferenceUri,
  encodeSessionReferenceUri,
  getPickerState,
  pickOption,
  resetPickerForTests,
  displayLabel,
} from '../src/client/picker.tsx'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { InputTriggerServiceContract, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'

interface FakeCtx {
  get(name: string): unknown
  effect(work: () => void): () => void
  inject(_deps: string[], callback: (ctx: FakeCtx) => void): void
  slots: {
    inject(_slot: string, register: () => unknown): void
    register(): () => void
  }
  sessions: {
    scope(sessionId: string): unknown
    scopeOf(actx: unknown): string | undefined
    list: { getSnapshot(): { byId: Record<string, { id: string; displayTitle?: string; parentId?: string }> } }
  }
  bail(_self: unknown, event: string, payload: unknown): boolean
}

function makeCtx(): {
  ctx: FakeCtx
  registered: InputTriggerSource[]
  bails: { event: string; payload: unknown }[]
  scopes: Map<string, unknown>
  located: { sessionId: string; seq: number }[]
  opened: string[]
} {
  const registered: InputTriggerSource[] = []
  const bails: { event: string; payload: unknown }[] = []
  const service: Partial<InputTriggerServiceContract> = {
    registerSource: source => {
      registered.push(source)
      return () => { }
    },
  }
  const scope = {
    sessionId: 'session-1',
    bail: (_self: unknown, event: string, payload: unknown) => {
      bails.push({ event, payload })
      return true
    },
  }
  const scopes = new Map<string, unknown>([['session-1', scope]])
  const located: { sessionId: string; seq: number }[] = []
  const opened: string[] = []
  const sessions = {
    scope: (sessionId: string) => scopes.get(sessionId) ?? {
      sessionId,
      // Mirrors the real scope-addressed service lookup the wiring performs.
      get: (name: string) => (name === 'conversation'
        ? { locate: (seq: number) => { located.push({ sessionId, seq }) } }
        : undefined),
    },
    scopeOf: (actx: unknown) => (actx as { sessionId?: string } | undefined)?.sessionId,
    open: (sessionId: string) => { opened.push(sessionId) },
    list: {
      getSnapshot: () => ({
        byId: {
          'session-1': { id: 'session-1', displayTitle: '当前会话' },
          'session-2': { id: 'session-2', displayTitle: '目标会话' },
          'session-9': { id: 'session-9', displayTitle: '目标会话', parentId: 'session-2' },
        },
      }),
    },
  }
  const ctx: FakeCtx = {
    get: name => {
      if (name === 'inputTriggers') return service
      if (name === 'sessions') return sessions
      return undefined
    },
    effect: work => {
      work()
      return () => { }
    },
    inject: (_deps, callback) => { callback(ctx) },
    slots: {
      inject: (_slot, register) => { register() },
      register: () => () => { },
    },
    sessions,
    bail: (_self, event, payload) => {
      bails.push({ event, payload })
      return true
    },
  }
  return { ctx, registered, bails, scopes, located, opened }
}

/** The projection the pipeline hands to callbacks. */
const session = { sessionId: 'session-1' } as never
const signal = new AbortController().signal

function pickSpan() {
  return { start: 0, end: 3, draftRev: 1 }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => {
  resetPickerForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('apply', () => {
  it('registers the @ source and the / source', () => {
    const { ctx, registered } = makeCtx()
    apply(ctx as unknown as ClientContext)
    expect(registered.map(source => source.trigger)).toEqual(['@', '/'])
    expect(registered[0]?.name).toBe(TRIGGER_NAME)
    expect(registered[1]?.name).toBe('cross-session')
  })
})

describe('@ session source', () => {
  it('maps level-one candidates with the id in the description', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      items: [
        { id: 'session-2', label: '主调查', children: [{ id: 'session-9', label: '主调查' }] },
        { id: 'session-3', label: '独立会话', children: [] },
      ],
    })))
    const { ctx, registered } = makeCtx()
    apply(ctx as unknown as ClientContext)
    const source = registered[0]!
    const rows = await source.candidates(session, { query: '', position: 'inline', signal })
    expect(rows).toEqual([
      { name: '主调查', description: 'session-2', hint: 'session-2' },
      { name: '独立会话', description: 'session-3', hint: 'session-3' },
    ])
  })

  it('opens the second-level picker when the picked session has children', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      items: [{ id: 'session-2', label: '主调查', children: [{ id: 'session-9', label: '主调查' }] }],
    })))
    const { ctx, registered } = makeCtx()
    apply(ctx as unknown as ClientContext)
    const source = registered[0]!
    await source.candidates(session, { query: '', position: 'inline', signal })
    const outcome = source.onPick({
      candidate: { name: '主调查', hint: 'session-2' },
      session,
      position: 'inline',
      via: 'menu',
      span: pickSpan(),
    })
    expect(outcome).toBe('handled')
    const state = getPickerState()
    expect(state.open).toBe(true)
    expect(state.mode).toBe('reference')
    expect(state.options.map(option => option.id)).toEqual(['session-2', 'session-9'])
    // Subagent rows whose label repeats the parent's fall back to a short id.
    expect(displayLabel(state.options[1]!)).toBe('[subagent] session-9')
  })

  it('settles the second-level pick to a reference insert at the original span', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      items: [{ id: 'session-2', label: '主调查', children: [{ id: 'session-9', label: '自己的标题' }] }],
    })))
    const { ctx, registered, bails } = makeCtx()
    apply(ctx as unknown as ClientContext)
    const source = registered[0]!
    await source.candidates(session, { query: '', position: 'inline', signal })
    const span = pickSpan()
    source.onPick({
      candidate: { name: '主调查', hint: 'session-2' },
      session,
      position: 'inline',
      via: 'menu',
      span,
    })
    await pickOption({ id: 'session-9', label: '自己的标题', subagent: true, parentLabel: '主调查' })
    expect(getPickerState().open).toBe(false)
    expect(bails).toHaveLength(1)
    const inserted = (bails[0]!.payload as { reference: { source: string; ref: string; label: string; clipboardText: string } }).reference
    expect(inserted.source).toBe(TRIGGER_NAME)
    expect(inserted.label).toBe('自己的标题')
    // The ref carries its own binding: the composer that picked it, the target, and the pick-time label.
    expect(decodeSessionReferenceUri(inserted.ref)).toEqual({
      f: 'session-1',
      t: 'session-9',
      l: '自己的标题',
    })
    expect(inserted.clipboardText).toBe(`@[自己的标题](${inserted.ref})`)
  })

  it('inserts directly when the picked session has no children', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      items: [{ id: 'session-3', label: '独立会话', children: [] }],
    })))
    const { ctx, registered } = makeCtx()
    apply(ctx as unknown as ClientContext)
    const source = registered[0]!
    await source.candidates(session, { query: '', position: 'inline', signal })
    const outcome = source.onPick({
      candidate: { name: '独立会话', hint: 'session-3' },
      session,
      position: 'inline',
      via: 'menu',
      span: pickSpan(),
    })
    if (outcome === undefined || typeof outcome !== 'object' || !('insert' in outcome)) throw new Error('expected insert')
    expect(outcome.insert.label).toBe('独立会话')
    expect(decodeSessionReferenceUri(outcome.insert.ref)).toEqual({
      f: 'session-1',
      t: 'session-3',
      l: '独立会话',
    })
    expect(outcome.insert.clipboardText).toBe(`@[独立会话](${outcome.insert.ref})`)
  })

  it('binds each chip to its own composer, never a shared session global', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      items: [
        { id: 'session-2', label: 'A 会话', children: [] },
        { id: 'session-3', label: 'B 会话', children: [] },
      ],
    })))
    const { ctx, registered, scopes } = makeCtx()
    apply(ctx as unknown as ClientContext)
    // A second composer scope exists beside session-1's.
    scopes.set('other-session', { sessionId: 'other-session', bail: () => true })
    const source = registered[0]!
    await source.candidates(
      { sessionId: 'session-1' } as never,
      { query: '', position: 'inline', signal },
    )
    const first = source.onPick({
      candidate: { name: 'A 会话', hint: 'session-2' },
      session: { sessionId: 'session-1' } as never,
      position: 'inline',
      via: 'menu',
      span: pickSpan(),
    })
    const second = source.onPick({
      candidate: { name: 'B 会话', hint: 'session-3' },
      session: { sessionId: 'other-session' } as never,
      position: 'inline',
      via: 'menu',
      span: pickSpan(),
    })
    if (first === undefined || typeof first !== 'object' || !('insert' in first)) throw new Error('expected insert')
    if (second === undefined || typeof second !== 'object' || !('insert' in second)) throw new Error('expected insert')
    expect(decodeSessionReferenceUri(first.insert.ref)).toMatchObject({ f: 'session-1', t: 'session-2' })
    expect(decodeSessionReferenceUri(second.insert.ref)).toMatchObject({ f: 'other-session', t: 'session-3' })
    // Serializing in any order still resolves each chip to its own composer.
    expect(decodeSessionReferenceUri(first.insert.ref)!.f).not.toBe(decodeSessionReferenceUri(second.insert.ref)!.f)
  })

  it('blocks the send on an unrecognized ref instead of downgrading to clipboard text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ items: [] })))
    const { ctx, registered } = makeCtx()
    apply(ctx as unknown as ClientContext)
    const source = registered[0]!
    await expect(source.codec!.serialize('not-a-reference-uri', signal)).rejects.toThrow('unrecognized session reference')
    // A well-schemed but corrupt body is equally refused.
    await expect(source.codec!.serialize('dsh-session:bm90LWpzb24', signal)).rejects.toThrow('unrecognized session reference')
  })

  it('serializes through /xssn/serialize with the remembered label', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(_input)
      if (url === '/xssn/candidates') {
        return jsonResponse({ items: [{ id: 'session-3', label: '独立会话', children: [] }] })
      }
      return jsonResponse({ text: 'Referenced session: 独立会话 (session-3)' })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { ctx, registered } = makeCtx()
    apply(ctx as unknown as ClientContext)
    const source = registered[0]!
    await source.candidates(session, { query: '', position: 'inline', signal })
    const picked = source.onPick({
      candidate: { name: '独立会话', hint: 'session-3' },
      session,
      position: 'inline',
      via: 'menu',
      span: pickSpan(),
    })
    if (picked === undefined || typeof picked !== 'object' || !('insert' in picked)) throw new Error('expected insert')
    // Serialize the exact chip the pick produced (the codec receives only the ref).
    const text = await source.codec!.serialize(picked.insert.ref, signal)
    expect(text).toContain('Referenced session: 独立会话')
    const call = fetchMock.mock.calls.find(call => call[0] === '/xssn/serialize')!
    expect(JSON.parse(String(call[1]?.body))).toEqual({
      sessionId: 'session-1',
      references: [{ sessionId: 'session-3', label: '独立会话' }],
    })
  })

  it('rejects when the host fails, blocking the send', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(_input)
      if (url === '/xssn/candidates') {
        return jsonResponse({ items: [{ id: 'session-3', label: '独立会话', children: [] }] })
      }
      return jsonResponse({
        error: { code: 'SESSION_REFERENCE_READ_FAILED', message: 'failed to read referenced session' },
      }, 422)
    }))
    const { ctx, registered } = makeCtx()
    apply(ctx as unknown as ClientContext)
    const source = registered[0]!
    await source.candidates(session, { query: '', position: 'inline', signal })
    source.onPick({
      candidate: { name: '独立会话', hint: 'session-3' },
      session,
      position: 'inline',
      via: 'menu',
      span: pickSpan(),
    })
    await expect(source.codec!.serialize(encodeSessionReferenceUri({ f: 'session-1', t: 'session-3', l: '独立会话' }), signal))
      .rejects.toThrow('failed to read referenced session')
  })
})

describe('/xsend claim', () => {
  it('claims /xsend on space with a submit that opens the send picker', async () => {
    const { ctx, registered } = makeCtx()
    apply(ctx as unknown as ClientContext)
    const source = registered[1]!
    const outcome = source.matchSpace!(session, '/xsend')
    expect(outcome).toMatchObject({ claim: { token: '/xsend ' } })
    if (outcome === undefined || typeof outcome !== 'object' || !('claim' in outcome)) throw new Error('expected claim')
    const actx = { sessionId: 'session-1' }
    const result = await outcome.claim.submit('把结论转过去', actx as unknown as ClientContext)
    expect(result).toEqual({ kind: 'success', text: '' })
    const state = getPickerState()
    expect(state.open).toBe(true)
    expect(state.mode).toBe('send')
    expect(state.pendingText).toBe('把结论转过去')
    expect(state.options.some(option => option.id === 'session-9' && option.subagent)).toBe(true)
  })

  it('intercepts an argued /xsend line on enter and opens the send picker', async () => {
    const { ctx, registered } = makeCtx()
    apply(ctx as unknown as ClientContext)
    const source = registered[1]!
    const outcome = await source.matchEnter!(session, '/xsend 把结论转过去', new AbortController().signal)
    expect(outcome).toBe('handled')
    const state = getPickerState()
    expect(state.open).toBe(true)
    expect(state.mode).toBe('send')
    expect(state.pendingText).toBe('把结论转过去')
  })

  it('leaves non-/xsend lines and bare /xsend alone', async () => {
    const { ctx, registered } = makeCtx()
    apply(ctx as unknown as ClientContext)
    const source = registered[1]!
    const other = await source.matchEnter!(session, '/compact', new AbortController().signal)
    expect(other).toBeUndefined()
    const bare = await source.matchEnter!(session, '/xsend', new AbortController().signal)
    expect(bare).toBeUndefined()
  })

  it('rejects an empty /xsend text', async () => {
    const { ctx, registered } = makeCtx()
    apply(ctx as unknown as ClientContext)
    const source = registered[1]!
    const outcome = source.matchSpace!(session, '/xsend')
    if (outcome === undefined || typeof outcome !== 'object' || !('claim' in outcome)) throw new Error('expected claim')
    const result = await outcome.claim.submit('   ', { sessionId: 'session-1' } as unknown as ClientContext)
    expect(result).toEqual({ kind: 'error', text: expect.stringContaining('usage') })
  })

  it('forwards to the picked target through /xssn/send', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    const { ctx, registered } = makeCtx()
    apply(ctx as unknown as ClientContext)
    const source = registered[1]!
    const outcome = source.matchSpace!(session, '/xsend')
    if (outcome === undefined || typeof outcome !== 'object' || !('claim' in outcome)) throw new Error('expected claim')
    await outcome.claim.submit('把结论转过去', { sessionId: 'session-1' } as unknown as ClientContext)
    await pickOption({ id: 'session-2', label: '目标会话', subagent: false })
    const call = fetchMock.mock.calls.find(call => call[0] === '/xssn/send')!
    expect(JSON.parse(String(call[1]?.body))).toEqual({
      fromSessionId: 'session-1',
      targetSessionId: 'session-2',
      content: '把结论转过去',
    })
    const state = getPickerState()
    expect(state.status).toBe('done')
    expect(state.statusText).toContain('目标会话')
  })
})
