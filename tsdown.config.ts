/**
 * tsdown build for dsh-web-cross-session: the node-half entry (lib/index.js —
 * ESM, node, @deepseek-ai/* external via the two-anchor resolution) plus the
 * browser client bundle (lib/client.js — CJS closure factory registering with
 * the package-name id via window.__ModuleLoader__.load).
 *
 * The browser half is pure logic (trigger source + host-route fetch): no React
 * components, no CSS, no runtime imports beyond the frozen module table, so
 * the client external list is minimal. Every @deepseek-ai import in the node
 * half is either type-only (erased in transpile) or a value import of a
 * core package the installing dsh provides (peer closure).
 */
const ID = 'dsh-web-cross-session'

/** Module specifiers the web shell shares into the frozen module table. */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-runtime/client',
]

export default [
  {
    name: `${ID}/node`,
    entry: ['src/index.ts', 'src/routes.ts', 'src/routes-core.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    // Two-anchor resolution: the installing dsh provides every @deepseek-ai
    // package, so none of them may inline into the node bundle.
    external: [/^@deepseek-ai\//],
  },
  {
    name: `${ID}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    external: CLIENT_EXTERNALS,
    // Bundle everything the frozen module table cannot answer; a require()
    // the table cannot answer is a guaranteed runtime throw.
    noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
]
