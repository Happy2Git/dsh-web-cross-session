/**
 * Corpus TTL cache: in-flight sharing, TTL reuse, and failure isolation.
 * The loader is a full-corpus session listing, the most expensive thing on
 * the request path, so a duplicated load is the cost this cache exists to
 * prevent.
 */

import { describe, expect, it, vi } from 'vitest'
import { cachedCorpus } from '../src/index.ts'

const observation = (tag: string) => ({
  parents: new Map<string, string>(),
  cwds: new Map([[tag, '/w']]),
})

const signal = new AbortController().signal

describe('cachedCorpus', () => {
  it('shares one load across requests that arrive before it resolves', async () => {
    let release!: (value: ReturnType<typeof observation>) => void
    const load = vi.fn(() => new Promise<ReturnType<typeof observation>>((r) => { release = r }))
    const corpus = cachedCorpus(load)

    const a = corpus(signal)
    const b = corpus(signal)
    const c = corpus(signal)
    // A cold burst must not start three full-corpus listings.
    expect(load).toHaveBeenCalledTimes(1)

    release(observation('one'))
    const [ra, rb, rc] = await Promise.all([a, b, c])
    expect(ra).toBe(rb)
    expect(rb).toBe(rc)
  })

  it('serves later calls from the TTL cache without reloading', async () => {
    const load = vi.fn(async () => observation('one'))
    const corpus = cachedCorpus(load)
    await corpus(signal)
    await corpus(signal)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('does not cache a failed load, and retries on the next call', async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('listing failed'))
      .mockResolvedValueOnce(observation('two'))
    const corpus = cachedCorpus(load)

    await expect(corpus(signal)).rejects.toThrow('listing failed')
    // A transient listing error must not poison the cache window.
    await expect(corpus(signal)).resolves.toMatchObject({ cwds: new Map([['two', '/w']]) })
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('hands one rejection to every waiter sharing the in-flight load', async () => {
    let fail!: (error: Error) => void
    const load = vi.fn(() => new Promise<ReturnType<typeof observation>>((_r, reject) => { fail = reject }))
    const corpus = cachedCorpus(load)
    const a = corpus(signal)
    const b = corpus(signal)
    fail(new Error('boom'))
    await expect(a).rejects.toThrow('boom')
    await expect(b).rejects.toThrow('boom')
    expect(load).toHaveBeenCalledTimes(1)
  })
})
