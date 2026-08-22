/**
 * Handler-core unit tests: validation, live-session guards, delegation, and
 * error shapes, all driven through injected doubles (no HTTP, no ctx).
 */

import { describe, expect, it, vi } from 'vitest'
import {
  handleCandidates,
  handlePrepare,
  handleSerialize,
  handleSend,
  RouteError,
  errorBody,
  errorStatus,
  sanitizeLabel,
  workspaceVisible,
  MAX_RELAY_BYTES,
  type CrossSessionDeps,
} from '../src/routes-core.ts'

/** The caller projection the handlers read: id plus the workspace header. */
const callerAgent = (id: string, cwd?: string) =>
  ({ id, ...(cwd === undefined ? {} : { session: { header: { cwd } } }) }) as never

interface DepsOverrides {
  getAgent?: CrossSessionDeps['getAgent']
  listCandidates?: CrossSessionDeps['listCandidates']
  prepare?: CrossSessionDeps['prepare']
  forward?: CrossSessionDeps['forward']
  corpus?: CrossSessionDeps['corpus']
  inlineSnapshot?: boolean
}

function makeDeps(overrides: DepsOverrides = {}): CrossSessionDeps & { forwarded: string[] } {
  const forwarded: string[] = []
  return {
    getAgent: overrides.getAgent ?? (() => undefined),
    listCandidates: overrides.listCandidates ?? vi.fn(async () => []),
    prepare: overrides.prepare ?? vi.fn(async () => ({ content: [] })),
    forward: overrides.forward ?? vi.fn((_target, from, text) => { forwarded.push(`${from}|${text}`) }),
    corpus: overrides.corpus ?? (async () => ({
      parents: new Map([['session-9', 'session-2']]),
      cwds: new Map([['session-2', '/work/a'], ['session-9', '/work/a']]),
    })),
    inlineSnapshot: overrides.inlineSnapshot ?? false,
    forwarded,
  }
}

const signal = new AbortController().signal

describe('handleCandidates', () => {
  it('rejects a missing sessionId', async () => {
    const deps = makeDeps()
    await expect(handleCandidates(deps, {}, signal)).rejects.toMatchObject({ status: 400 })
  })

  it('rejects a caller session that is not live', async () => {
    const deps = makeDeps()
    await expect(handleCandidates(deps, { sessionId: 'session-1' }, signal))
      .rejects.toMatchObject({ status: 404 })
  })

  it('groups subagent sessions under their parent and keeps the rest on level one', async () => {
    const deps = makeDeps({
      getAgent: id => (id === 'session-1' ? callerAgent('session-1', '/work/a') : undefined),
      listCandidates: vi.fn(async () => [
        { sessionId: 'session-2', label: '主调查', createdAt: 1 },
        { sessionId: 'session-9', label: '主调查', createdAt: 2 },
        { sessionId: 'session-10', label: '独立会话', createdAt: 3 },
      ] as never),
      corpus: async () => ({
        parents: new Map([['session-9', 'session-2']]),
        cwds: new Map([['session-2', '/work/a'], ['session-9', '/work/a'], ['session-10', '/work/a']]),
      }),
    })
    const payload = await handleCandidates(deps, { sessionId: 'session-1', query: '调' }, signal)
    expect(payload.items).toEqual([
      { id: 'session-2', label: '主调查', children: [{ id: 'session-9', label: '主调查' }] },
      { id: 'session-10', label: '独立会话', children: [] },
    ])
    expect(deps.listCandidates).toHaveBeenCalledWith(callerAgent('session-1', '/work/a'), '调', 50, signal)
  })

  it('keeps a child whose parent is not in the list as a level-one row', async () => {
    const deps = makeDeps({
      getAgent: id => (id === 'session-1' ? callerAgent('session-1', '/w') : undefined),
      // The caller (session-1) is excluded by the resolver; its child must not vanish.
      listCandidates: vi.fn(async () => [
        { sessionId: 'session-7', label: '主会话的子代理', createdAt: 1 },
      ] as never),
      corpus: async () => ({
        parents: new Map([['session-7', 'session-1']]),
        cwds: new Map([['session-7', '/w']]),
      }),
    })
    const payload = await handleCandidates(deps, { sessionId: 'session-1' }, signal)
    expect(payload.items).toEqual([
      { id: 'session-7', label: '主会话的子代理', children: [] },
    ])
  })

  it('drops candidates outside the caller workspace before assembly', async () => {
    const deps = makeDeps({
      getAgent: id => (id === 'session-1' ? callerAgent('session-1', '/work/a') : undefined),
      listCandidates: vi.fn(async () => [
        { sessionId: 'session-2', label: '同区', createdAt: 1 },
        { sessionId: 'session-11', label: '别的工作区', createdAt: 2 },
        { sessionId: 'session-12', label: 'cwd 未知的持久会话', createdAt: 3 },
      ] as never),
      corpus: async () => ({
        parents: new Map(),
        cwds: new Map([['session-2', '/work/a']]),
      }),
    })
    const payload = await handleCandidates(deps, { sessionId: 'session-1' }, signal)
    expect(payload.items.map(item => item.id)).toEqual(['session-2'])
  })

  it('shows a cwd-less caller only itself', async () => {
    const deps = makeDeps({
      getAgent: id => (id === 'session-1' ? callerAgent('session-1') : undefined),
      listCandidates: vi.fn(async () => [
        { sessionId: 'session-2', label: '同区', createdAt: 1 },
      ] as never),
      corpus: async () => ({
        parents: new Map(),
        cwds: new Map([['session-2', '/work/a']]),
      }),
    })
    const payload = await handleCandidates(deps, { sessionId: 'session-1' }, signal)
    expect(payload.items).toEqual([])
  })

  it('nests correctly when the child row arrives before its parent', async () => {
    const deps = makeDeps({
      getAgent: id => (id === 'session-1' ? callerAgent('session-1', '/work/a') : undefined),
      listCandidates: vi.fn(async () => [
        { sessionId: 'session-9', label: '子', createdAt: 1 },
        { sessionId: 'session-2', label: '父', createdAt: 2 },
      ] as never),
      corpus: async () => ({
        parents: new Map([['session-9', 'session-2']]),
        cwds: new Map([['session-2', '/work/a'], ['session-9', '/work/a']]),
      }),
    })
    const payload = await handleCandidates(deps, { sessionId: 'session-1' }, signal)
    expect(payload.items).toEqual([
      { id: 'session-2', label: '父', children: [{ id: 'session-9', label: '子' }] },
    ])
  })

  it('survives a parent/child cycle without dropping either row', async () => {
    const deps = makeDeps({
      getAgent: id => (id === 'session-1' ? callerAgent('session-1', '/w') : undefined),
      listCandidates: vi.fn(async () => [
        { sessionId: 'session-a', label: 'A', createdAt: 1 },
        { sessionId: 'session-b', label: 'B', createdAt: 2 },
      ] as never),
      corpus: async () => ({
        parents: new Map([['session-a', 'session-b'], ['session-b', 'session-a']]),
        cwds: new Map([['session-a', '/w'], ['session-b', '/w']]),
      }),
    })
    const payload = await handleCandidates(deps, { sessionId: 'session-1' }, signal)
    // One row stays top-level carrying the other as its child; neither vanishes.
    const all = payload.items.flatMap(item => [item.id, ...item.children.map(child => child.id)])
    expect(new Set(all)).toEqual(new Set(['session-a', 'session-b']))
  })

  it('never lists the caller itself out of the visible set', async () => {
    const seen = workspaceVisible('s1', '/a', 's1', undefined)
    expect(seen).toBe(true)
    expect(workspaceVisible('s1', undefined, 's2', '/a')).toBe(false)
    expect(workspaceVisible('s1', '/a', 's2', '/b')).toBe(false)
    expect(workspaceVisible('s1', '/a', 's2', '/a')).toBe(true)
  })
})

describe('handlePrepare', () => {
  it('rejects non-array references', async () => {
    const deps = makeDeps({ getAgent: () => ({ id: 'session-1' }) as never })
    await expect(handlePrepare(deps, { sessionId: 'session-1', references: 'nope' }, signal))
      .rejects.toMatchObject({ status: 400 })
  })

  it('rejects more than the hard cap of references', async () => {
    const deps = makeDeps({ getAgent: () => ({ id: 'session-1' }) as never })
    const references = [1, 2, 3, 4].map(i => ({ sessionId: `session-${i}` }))
    await expect(handlePrepare(deps, { sessionId: 'session-1', references }, signal))
      .rejects.toMatchObject({ status: 400 })
  })

  it('delegates to prepare and renders the snapshot text', async () => {
    const agent = { id: 'session-1' } as never
    const deps = makeDeps({
      getAgent: id => (id === 'session-1' ? agent : undefined),
      prepare: vi.fn(async () => ({
        content: [],
        additionalContext: {
          id: 'm1', role: 'user',
          content: [{ type: 'text', text: '## Referenced sessions\nsnapshot-json' }],
          source: { kind: 'session-reference' },
        },
      }) as never),
    })
    const payload = await handlePrepare(
      deps,
      { sessionId: 'session-1', references: [{ sessionId: 'session-2', label: '旧调查' }] },
      signal,
    )
    expect(payload.text).toBe('## Referenced sessions\nsnapshot-json')
    expect(deps.prepare).toHaveBeenCalledWith(
      agent,
      [{ sessionId: 'session-2', label: '旧调查' }],
      signal,
    )
  })
})

describe('handleSerialize', () => {
  const agent = { id: 'session-1' } as never
  const body = {
    sessionId: 'session-1',
    references: [{ sessionId: 'session-2', label: '旧调查' }],
  }

  it('emits the pointer form by default when every reference shares the caller cwd', async () => {
    const deps = makeDeps({
      getAgent: id => (id === 'session-1' ? { id: 'session-1', session: { header: { cwd: '/work/a' } } } : undefined) as never,
      prepare: vi.fn(async () => ({ content: [] }) as never),
    })
    const payload = await handleSerialize(deps, body, signal)
    expect(payload.text).toContain('Referenced session: 旧调查 (session-2)')
    expect(payload.text).toContain('session_event_search (targetSessionId session-2)')
    expect(payload.text).not.toContain('<referenced-sessions>')
    expect(deps.prepare).not.toHaveBeenCalled()
  })

  it('falls back to the inline snapshot when a reference is cross-workspace', async () => {
    const deps = makeDeps({
      getAgent: id => (id === 'session-1' ? { id: 'session-1', session: { header: { cwd: '/work/other' } } } : undefined) as never,
      prepare: vi.fn(async () => ({
        content: [],
        additionalContext: {
          id: 'm1', role: 'user',
          content: [{ type: 'text', text: '## Referenced sessions\nsnapshot-json' }],
          source: { kind: 'session-reference' },
        },
      }) as never),
    })
    const payload = await handleSerialize(deps, body, signal)
    expect(payload.text).toBe('## Referenced sessions\nsnapshot-json')
    expect(deps.prepare).toHaveBeenCalled()
  })

  it('renders the inline snapshot when inlineSnapshot is configured', async () => {
    const deps = makeDeps({
      getAgent: id => (id === 'session-1' ? agent : undefined),
      inlineSnapshot: true,
      prepare: vi.fn(async () => ({
        content: [],
        additionalContext: {
          id: 'm1', role: 'user',
          content: [{ type: 'text', text: '## Referenced sessions\nsnapshot-json' }],
          source: { kind: 'session-reference' },
        },
      }) as never),
    })
    const payload = await handleSerialize(deps, body, signal)
    expect(payload.text).toBe('## Referenced sessions\nsnapshot-json')
    expect(deps.prepare).toHaveBeenCalled()
  })

  it('rejects a caller that is not live', async () => {
    const deps = makeDeps()
    await expect(handleSerialize(deps, body, signal)).rejects.toMatchObject({ status: 404 })
  })
})

describe('handleSend', () => {
  it('rejects blank content', async () => {
    const deps = makeDeps({ getAgent: () => ({ id: 'session-2' }) as never })
    await expect(handleSend(deps, {
      fromSessionId: 'session-1', targetSessionId: 'session-2', content: '   ',
    }, signal)).rejects.toMatchObject({ status: 400 })
  })

  it('rejects oversized content', async () => {
    const deps = makeDeps({ getAgent: () => ({ id: 'session-2' }) as never })
    await expect(handleSend(deps, {
      fromSessionId: 'session-1',
      targetSessionId: 'session-2',
      content: 'x'.repeat(MAX_RELAY_BYTES + 1),
    }, signal)).rejects.toMatchObject({ status: 413 })
  })

  it('rejects a target that is not live', async () => {
    const deps = makeDeps()
    await expect(handleSend(deps, {
      fromSessionId: 'session-1', targetSessionId: 'session-2', content: 'hi',
    }, signal)).rejects.toMatchObject({ status: 404 })
  })

  it('forwards the relay text to the live target', async () => {
    const deps = makeDeps({
      getAgent: id => ((id === 'session-1' || id === 'session-2') ? { id } : undefined) as never,
    })
    const payload = await handleSend(deps, {
      fromSessionId: 'session-1', targetSessionId: 'session-2', content: ' 把结论转过去  ',
    }, signal)
    expect(payload).toEqual({ ok: true })
    expect(deps.forwarded).toEqual(['session-1|把结论转过去'])
  })

  it('rejects a send whose source session is not live', async () => {
    const deps = makeDeps({
      getAgent: id => (id === 'session-2' ? { id: 'session-2' } : undefined) as never,
    })
    await expect(handleSend(deps, {
      fromSessionId: 'session-fake', targetSessionId: 'session-2', content: 'hi',
    }, signal)).rejects.toMatchObject({ status: 404 })
    expect(deps.forwarded).toEqual([])
  })

  it('rejects a self-addressed send', async () => {
    const agent = callerAgent('session-1', '/w')
    const deps = makeDeps({ getAgent: () => agent })
    await expect(handleSend(deps, {
      fromSessionId: 'session-1', targetSessionId: 'session-1', content: 'hi',
    }, signal)).rejects.toMatchObject({ status: 400 })
    expect(deps.forwarded).toEqual([])
  })

  it('refuses ids outside the opaque-token alphabet before any lookup', async () => {
    const deps = makeDeps()
    for (const bad of ['a b\nc', 'x) drop table (', 'tab\there']) {
      await expect(handleCandidates(deps, { sessionId: bad }, signal))
        .rejects.toMatchObject({ status: 400 });
      await expect(handlePrepare(deps, {
        sessionId: 's1',
        references: [{ sessionId: bad }],
      }, signal)).rejects.toMatchObject({ status: 400 });
    }
    expect(deps.forwarded).toEqual([])
  })
})

describe('sanitizeLabel', () => {
  it('flattens control characters so a label cannot forge instruction lines', () => {
    expect(sanitizeLabel('正常标题')).toBe('正常标题')
    expect(sanitizeLabel('line one\nline two')).toBe('line one line two')
    expect(sanitizeLabel('bad\u0000\u001fchars')).toBe('bad  chars')
    expect(sanitizeLabel('  padded  ')).toBe('padded')
  })

  it('caps the label with an ellipsis at the configured width', () => {
    const long = 'x'.repeat(200)
    const capped = sanitizeLabel(long)
    expect(capped.length).toBe(80)
    expect(capped.endsWith('…')).toBe(true)
  })
})

describe('error mapping', () => {
  it('maps RouteError to its status and body', () => {
    const error = new RouteError(422, 'boom', 'SESSION_REFERENCE_TOO_MANY')
    expect(errorStatus(error)).toBe(422)
    expect(errorBody(error)).toEqual({ error: { code: 'SESSION_REFERENCE_TOO_MANY', message: 'boom' } })
  })

  it('masks unknown errors to a fixed body and defaults them to 500', () => {
    expect(errorStatus(new Error('x'))).toBe(500)
    // Unknown messages can carry filesystem or database internals; they never reach the wire.
    const leaky = Object.assign(new Error('/home/u/.dsh/session.db: locked'), { code: 'CUSTOM' })
    expect(errorBody(leaky)).toEqual({ error: { code: 'XSSN_INTERNAL', message: 'internal error' } })
  })
})
