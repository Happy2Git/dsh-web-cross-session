/**
 * Composition patch test: the plugin's cordis.patch.yml must (a) override the
 * shipped session-query-sqlite row config to a persistent first-search index
 * and (b) insert the plugin's own dual-face row. The base and web-app bundle
 * rows are reproduced as minimal fixtures; the real patch file is parsed and
 * applied through the same applyEntryPatches the profile boot uses.
 *
 * The file's `!!js dshHomePath(...)` expression is a Loader-evaluated node;
 * js-yaml cannot evaluate it, so the test substitutes the literal value the
 * expression would produce before parsing.
 */

import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { applyEntryPatches, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { describe, expect, it } from 'vitest'
import { load as loadYaml } from 'js-yaml'

/** The entry shape applyEntryPatches consumes; the package does not export it. */
type EntryRow = Parameters<typeof applyEntryPatches>[0][number]

function parsePatchFile(path: string): PatchOptions[] {
  const text = readFileSync(path, 'utf8')
    // The Loader evaluates `!!js expr` at row activation; the test pins the
    // literal the shipped expression resolves to (dshHomePath('session-query.db')).
    .replace("!!js dshHomePath('session-query.db')", JSON.stringify('/home/u/.dsh/session-query.db'))
  return loadYaml(text) as PatchOptions[]
}

/** The shipped base row, as pinned in packages/bundle/base/cordis.patch.yml. */
function baseRows(): EntryRow[] {
  return [
    {
      id: 'session-query-sqlite',
      name: '@deepseek-ai/dsh-session-query-sqlite',
      config: { path: ':memory:', openAt: 'never' },
    },
  ]
}

/** The web-app bundle restates the same row, still openAt: never. */
function webAppRows(base: EntryRow[]): EntryRow[] {
  return [
    {
      id: 'session-query-sqlite',
      name: '@deepseek-ai/dsh-session-query-sqlite',
      config: { path: ':memory:', openAt: 'never' },
    },
    ...base.filter(row => row.id !== 'session-query-sqlite'),
  ]
}

const PATCH_PATH = resolvePath(import.meta.dirname, '../cordis.patch.yml')

describe('cordis.patch.yml', () => {
  it('restates every base config key when overriding session-query-sqlite', () => {
    const patch = parsePatchFile(PATCH_PATH)
    const override = patch.find(row => row.id === 'session-query-sqlite')
    expect(override).toBeDefined()
    expect(override?.config).toEqual({
      path: '/home/u/.dsh/session-query.db',
      openAt: 'first-search',
      tokenize: 'trigram',
    })
  })

  it('inserts the plugin row under the package name', () => {
    const patch = parsePatchFile(PATCH_PATH)
    const insert = patch.find(row => Array.isArray(row.insert))
    const inserted = (insert?.insert as EntryRow[] | undefined) ?? []
    expect(inserted).toEqual([{ id: 'cross-session', name: 'dsh-web-cross-session' }])
  })

  it('wins over the base and web-app rows when applied in bundle order', () => {
    const patch = parsePatchFile(PATCH_PATH)
    const entries = applyEntryPatches(webAppRows(baseRows()), patch, () => {})
    const row = entries.find(entry => entry.id === 'session-query-sqlite')
    expect(row?.config).toEqual({
      path: '/home/u/.dsh/session-query.db',
      openAt: 'first-search',
      tokenize: 'trigram',
    })
    expect(entries.some(entry => entry.id === 'cross-session' && entry.name === 'dsh-web-cross-session')).toBe(true)
  })

  it('leaves exact reads available: the index row stays mounted (openAt never would still serve titles)', () => {
    // The override changes only the opening phase; the row itself must remain
    // present with its package name so ctx.sessionQuery keeps serving.
    const patch = parsePatchFile(PATCH_PATH)
    const entries = applyEntryPatches(webAppRows(baseRows()), patch, () => {})
    const row = entries.find(entry => entry.id === 'session-query-sqlite')
    expect(row?.name).toBe('@deepseek-ai/dsh-session-query-sqlite')
  })
})
