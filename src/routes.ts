/**
 * /xssn/* HTTP wiring: the exact-route registrations on the host webserver.
 * Thin by design — every decision lives in routes-core.ts, which tests drive
 * directly; this file only gates the method, reads the JSON body, runs the
 * handler, and writes the JSON response inside the cross-site write fence,
 * logging (never returning) the internal errors the body sanitizer hides.
 *
 * @module dsh-web-cross-session/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  errorBody,
  errorStatus,
  handleCandidates,
  handlePrepare,
  handleSend,
  handleSerialize,
  RouteError,
  type CrossSessionDeps,
} from './routes-core.ts'

export const XSSN_CANDIDATES = '/xssn/candidates'
export const XSSN_PREPARE = '/xssn/prepare'
export const XSSN_SERIALIZE = '/xssn/serialize'
export const XSSN_SEND = '/xssn/send'

/** Cross-site write fence: reject non-JSON bodies before reading (compass pattern). */
const MAX_BODY_BYTES = 1 << 20

/** The browser half speaks POST only; every other verb gets a flat 405. */
function assertPostMethod(req: IncomingMessage): void {
  if (req.method !== 'POST') {
    throw new RouteError(405, 'method not allowed; use POST', 'XSSN_METHOD');
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const mediaType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') {
    throw new RouteError(415, 'content type must be application/json');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req as AsyncIterable<Buffer | string>) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new RouteError(413, 'request body too large');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RouteError(400, 'body is not JSON');
  }
}

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

/** One request-bound abort signal: a client disconnect aborts host work. */
function requestSignal(res: ServerResponse): AbortSignal {
  const controller = new AbortController();
  res.once('close', () => {
    if (!res.writableEnded) controller.abort(new Error('client disconnected'));
  });
  return controller.signal;
}

/** Run one handler; RouteError messages reach the wire verbatim, everything else is masked and logged. */
async function serve(
  res: ServerResponse,
  run: () => Promise<unknown>,
  logInternal: (error: unknown) => void,
): Promise<void> {
  try {
    writeJson(res, 200, await run());
  } catch (error: unknown) {
    if (!(error instanceof RouteError)) logInternal(error);
    writeJson(res, errorStatus(error), errorBody(error));
  }
}

/** One gated registration on the host webserver: POST-only entry that then serves its handler. */
function gatedRoute(
  ctx: Context,
  path: string,
  handle: (body: unknown, signal: AbortSignal) => Promise<unknown>,
): () => void {
  // Masked errors still need their cause server-side, or debugging becomes
  // guesswork; the logger sees what the browser must not.
  const logInternal = (error: unknown): void => {
    ctx.logger.error('cross-session: %s', error instanceof Error ? error.stack ?? error.message : String(error));
  };
  return ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      assertPostMethod(req);
      const signal = requestSignal(res);
      await serve(res, async () => handle(await readJsonBody(req), signal), logInternal);
    },
  }), `cross-session: ${path}`);
}

/**
 * Register the four /xssn/* routes on the host webserver. Loopback-only:
 * these routes read other sessions and forward messages into live ones, so
 * they must never be reachable from a network interface.
 * @returns the combined disposer for all registrations.
 */
export function registerRoutes(ctx: Context, deps: CrossSessionDeps): () => void {
  if (ctx.webServer.host !== '127.0.0.1') {
    throw new Error('cross-session: /xssn/* is loopback-only; refuse to serve on a non-loopback host');
  }
  const disposers = [
    gatedRoute(ctx, XSSN_CANDIDATES, (body, signal) => handleCandidates(deps, body, signal)),
    gatedRoute(ctx, XSSN_PREPARE, (body, signal) => handlePrepare(deps, body, signal)),
    gatedRoute(ctx, XSSN_SERIALIZE, (body, signal) => handleSerialize(deps, body, signal)),
    gatedRoute(ctx, XSSN_SEND, (body, signal) => handleSend(deps, body, signal)),
  ];
  return () => {
    for (const disposer of disposers) disposer();
  };
}