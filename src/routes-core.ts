/**
 * /xssn/* handler logic, dependency-injected. Pure core: tests drive the same
 * code with doubles; the HTTP wiring in routes.ts and the ctx binding in
 * index.ts are the only other layers. Each handler validates its payload,
 * enforces the live-session guard plus the workspace rule, delegates to the
 * cross-session services, and returns the browser-facing payload shape.
 *
 * Security model: these routes are loopback-only and share the local user's
 * trust domain. Listing is always workspace-scoped — a caller only ever sees
 * sessions whose recorded cwd equals its own, plus itself. Reading one
 * explicitly named reference may leave that scope (the documented cross-
 * workspace inline-snapshot feature); the model-facing session-query tools
 * enforce exact-cwd on their own retrieval path regardless.
 *
 * @module dsh-web-cross-session/routes-core
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  PreparedReferencedMessage,
  SessionReferenceCandidate,
  SessionReferenceInput,
} from '@deepseek-ai/dsh-session-reference'

/** One relay message's content ceiling, UTF-8 bytes. */
export const MAX_RELAY_BYTES = 64 * 1024

/** A session reference is at most the core's hard cap. */
export const MAX_REFERENCES = 3

/** Display-label ceiling for model-facing text, Unicode code points. */
export const MAX_LABEL_CHARS = 80

/** Services the handlers delegate to; index.ts binds them to ctx. */
export interface CrossSessionDeps {
  /** Resolve the live agent for one session id, or undefined when not live. */
  getAgent(sessionId: SessionId): Agent | undefined
  /** Candidate discovery, delegated to the mounted resolver. */
  listCandidates(
    agent: Agent,
    query: string,
    limit: number,
    signal: AbortSignal,
  ): Promise<SessionReferenceCandidate[]>
  /** Snapshot preparation, delegated to the mounted resolver. */
  prepare(
    agent: Agent,
    references: SessionReferenceInput[],
    signal: AbortSignal,
  ): Promise<PreparedReferencedMessage>
  /** Forward one relay message to a live target agent. */
  forward(target: Agent, fromSessionId: SessionId, text: string): void
  /**
   * One corpus observation: session id → parent session id (subagent
   * sessions, shown under their parent's second level) and session id →
   * recorded cwd (workspace authorization). One listSessions call serves
   * both; async because the full corpus (live and persisted) answers it.
   */
  corpus(signal: AbortSignal): Promise<{
    readonly parents: ReadonlyMap<string, string>
    readonly cwds: ReadonlyMap<string, string>
  }>
  /** True when references serialize as inline snapshots instead of pointers. */
  readonly inlineSnapshot: boolean
}

/** One second-level row: a subagent session under its parent. */
export interface ChildItem {
  readonly id: SessionId
  readonly label: string
}

/** One first-level candidate row the browser picker renders. */
export interface CandidateItem {
  readonly id: SessionId
  readonly label: string
  /** The candidate's fork children (subagent sessions), in discovery order. */
  children: ChildItem[]
}

export interface CandidatesPayload {
  readonly items: readonly CandidateItem[]
}

export interface PreparePayload {
  /** The rendered snapshot text (untrusted warning + JSON), empty when no reference survived. */
  readonly text: string
}

export interface SerializePayload {
  /**
   * The model-facing text for one reference: the untrusted snapshot when
   * inlineSnapshot is configured, otherwise a short pointer that tells the
   * model to retrieve the session with the session-query tools.
   */
  readonly text: string
}

export interface SendPayload {
  readonly ok: true
}

/** Transported error shape; the browser surfaces `message` and keeps `code` machine-addressable. */
export interface RouteErrorBody {
  readonly error: {
    readonly code?: string
    readonly message: string
  }
}

/** Rejections carry an HTTP status; the wiring layer maps them to responses. */
export class RouteError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'RouteError'
  }
}

// ---------------------------------------------------------------------------
// Payload validation

function requireObject(body: unknown, what: string): Record<string, unknown> {
  if (typeof body !== 'object' || body === null) {
    throw new RouteError(400, `${what}: request body must be a JSON object`)
  }
  return body as Record<string, unknown>
}

function readString(body: Record<string, unknown>, key: string, what: string): string {
  const value = body[key]
  if (typeof value !== 'string' || value === '') {
    throw new RouteError(400, `${what}: ${key} must be a non-empty string`)
  }
  return value
}

/** Opaque-id alphabet echoed into model-facing text: no whitespace, no control characters, nothing quote-shaped. */
const SESSION_ID_TEXT = /^[\w:@.+-]+$/

/**
 * Accept an id destined for model-facing instructions. Values outside the
 * conservative token alphabet are refused at the door rather than escaped.
 */
function readIdText(body: Record<string, unknown>, key: string, what: string): string {
  const value = readString(body, key, what)
  if (!SESSION_ID_TEXT.test(value)) {
    throw new RouteError(400, `${what}: ${key} contains unsupported characters`)
  }
  return value
}

function readOptionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new RouteError(400, `${key} must be a string`)
  return value
}

function readLimit(body: Record<string, unknown>): number {
  const value = body.limit
  if (value === undefined) return 50
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > 200) {
    throw new RouteError(400, 'limit must be a positive integer at most 200')
  }
  return value
}

/**
 * Sanitize a display label destined for model-facing text: control
 * characters (including newlines) become spaces so no label can forge an
 * instruction line of its own, then the result is capped.
 */
export function sanitizeLabel(raw: string, max = MAX_LABEL_CHARS): string {
  // eslint-disable-next-line no-control-regex -- stripping them is the point
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned
}

function readReferences(body: Record<string, unknown>): SessionReferenceInput[] {
  const value = body.references
  if (!Array.isArray(value) || value.length === 0) {
    throw new RouteError(400, 'references must be a non-empty array')
  }
  if (value.length > MAX_REFERENCES) {
    throw new RouteError(400, `references must contain at most ${MAX_REFERENCES} entries`)
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new RouteError(400, `references[${index}] must be an object`)
    }
    const record = entry as Record<string, unknown>
    const sessionId = readIdText(record, 'sessionId', `references[${index}]`)
    const label = readOptionalString(record, 'label')
    return label === undefined
      ? { sessionId: sessionId as SessionId }
      : { sessionId: sessionId as SessionId, label: sanitizeLabel(label) }
  })
}

function liveAgent(deps: CrossSessionDeps, sessionId: string, what: string): Agent {
  const agent = deps.getAgent(sessionId as SessionId)
  if (agent === undefined) {
    throw new RouteError(404, `${what}: session ${JSON.stringify(sessionId)} is not live; open it in the web UI first`)
  }
  return agent
}

// ---------------------------------------------------------------------------
// Workspace rule (mirrors @deepseek-ai/dsh-tool-session-query/workspace-access)

/**
 * Whether a caller may see the session identified by `targetId`, given the
 * target's recorded cwd from one corpus observation. The caller always sees
 * itself; every other session requires exact cwd equality with a caller
 * that has a cwd — a caller without a cwd sees only itself, the same rule
 * the model-facing tools enforce.
 */
export function workspaceVisible(
  callerId: string,
  callerCwd: string | undefined,
  targetId: string,
  targetCwd: string | undefined,
): boolean {
  if (targetId === callerId) return true
  return callerCwd !== undefined && targetCwd !== undefined && targetCwd === callerCwd
}

// ---------------------------------------------------------------------------
// Handlers

/**
 * POST /xssn/candidates — session candidates for the composer @ picker,
 * workspace-scoped before assembly: rows outside the caller's cwd never
 * reach the browser, including any children they would have carried.
 * Body: { sessionId, query?, limit? } → { items: [{ id, label, children }] }.
 */
export async function handleCandidates(
  deps: CrossSessionDeps,
  body: unknown,
  signal: AbortSignal,
): Promise<CandidatesPayload> {
  const record = requireObject(body, 'candidates')
  const sessionId = readIdText(record, 'sessionId', 'candidates')
  const query = readOptionalString(record, 'query') ?? ''
  const limit = readLimit(record)
  const agent = liveAgent(deps, sessionId, 'candidates')
  const [{ parents, cwds }, candidates] = await Promise.all([
    deps.corpus(signal),
    deps.listCandidates(agent, query, limit, signal),
  ])
  const callerCwd = agent.session?.header?.cwd
  const visible = candidates.filter(candidate =>
    workspaceVisible(sessionId, callerCwd, candidate.sessionId, cwds.get(candidate.sessionId)),
  )
  // Order-independent two-pass assembly: identity first, then parenting. A
  // row nests under its parent whenever the parent survived filtering and is
  // itself still a top-level row (cycle guard); delivery order between
  // parent and child rows cannot change the shape.
  const byId = new Map<string, CandidateItem>()
  for (const candidate of visible) {
    byId.set(candidate.sessionId, { id: candidate.sessionId, label: candidate.label, children: [] })
  }
  const items: CandidateItem[] = []
  // Ids already consumed as someone's child. A row may nest only under a
  // parent that is still top-level; that single rule breaks cycles (in an
  // a↔b pair the second row stays level one and keeps the first as its
  // child) while deep chains collapse into the two rendered levels.
  const isChild = new Set<string>()
  for (const candidate of visible) {
    const parent = parents.get(candidate.sessionId)
    const parentItem = parent !== undefined && parent !== candidate.sessionId
      ? byId.get(parent)
      : undefined
    if (parentItem !== undefined && !isChild.has(parentItem.id)) {
      parentItem.children.push({ id: candidate.sessionId, label: candidate.label })
      isChild.add(candidate.sessionId)
      continue
    }
    if (!isChild.has(candidate.sessionId)) {
      const item = byId.get(candidate.sessionId);
      if (item !== undefined) items.push(item)
    }
  }
  return { items }
}

/**
 * POST /xssn/prepare — render one referenced session as snapshot text. The
 * reference is explicit (user-picked), so it may leave the caller's
 * workspace; that is the documented cross-workspace snapshot feature.
 * Body: { sessionId, references: [{ sessionId, label? }] } → { text }.
 */
export async function handlePrepare(
  deps: CrossSessionDeps,
  body: unknown,
  signal: AbortSignal,
): Promise<PreparePayload> {
  const record = requireObject(body, 'prepare')
  const sessionId = readIdText(record, 'sessionId', 'prepare')
  const references = readReferences(record)
  const agent = liveAgent(deps, sessionId, 'prepare')
  const prepared = await deps.prepare(agent, references, signal)
  return { text: renderContextText(prepared) }
}

/**
 * POST /xssn/send — forward one message into another live session's inbox.
 * Both ends must be live and distinct; the relay prefix names the verified
 * source session, not a caller-chosen string.
 * Body: { fromSessionId, targetSessionId, content } → { ok: true }.
 */
export async function handleSend(
  deps: CrossSessionDeps,
  body: unknown,
  signal: AbortSignal,
): Promise<SendPayload> {
  const record = requireObject(body, 'send')
  const fromSessionId = readIdText(record, 'fromSessionId', 'send')
  const targetSessionId = readIdText(record, 'targetSessionId', 'send')
  if (fromSessionId === targetSessionId) {
    throw new RouteError(400, 'send: target session must differ from the source')
  }
  const content = readString(record, 'content', 'send').trim();
  if (content === '') throw new RouteError(400, 'send: content must not be blank');
  if (Buffer.byteLength(content, 'utf8') > MAX_RELAY_BYTES) {
    throw new RouteError(413, `send: content exceeds ${MAX_RELAY_BYTES} UTF-8 bytes`);
  }
  liveAgent(deps, fromSessionId, 'send')
  const target = liveAgent(deps, targetSessionId, 'send')
  deps.forward(target, fromSessionId as SessionId, content);
  void signal;
  return { ok: true };
}

/**
 * POST /xssn/serialize — the model-facing text for one reference. Inline
 * mode renders the untrusted snapshot (prepare); pointer mode (the default)
 * returns a short citation plus a retrieval instruction the model fulfills
 * with the session-query tools, so referencing a long session costs a few
 * tokens instead of up to 65 KB.
 * Body: { sessionId, references: [{ sessionId, label? }] } → { text }.
 */
export async function handleSerialize(
  deps: CrossSessionDeps,
  body: unknown,
  signal: AbortSignal,
): Promise<SerializePayload> {
  const record = requireObject(body, 'serialize')
  const sessionId = readIdText(record, 'sessionId', 'serialize')
  const references = readReferences(record)
  const agent = liveAgent(deps, sessionId, 'serialize')
  // The model-facing session-query tools authorize by exact cwd equality, so
  // a pointer reference is only resolvable when every referenced session
  // shares the caller's workspace; any cross-workspace (or unknown-cwd)
  // reference falls back to the inline snapshot, which the resolver can read
  // from any session.
  const { cwds } = await deps.corpus(signal)
  const agentCwd = agent.session?.header?.cwd
  const sameWorkspace = references.every(reference => {
    const targetCwd = cwds.get(reference.sessionId)
    return agentCwd !== undefined && targetCwd !== undefined && targetCwd === agentCwd
  })
  if (deps.inlineSnapshot === true || !sameWorkspace) {
    const prepared = await deps.prepare(agent, references, signal)
    return { text: renderContextText(prepared) }
  }
  return { text: pointerText(references) }
}

/**
 * The pointer form of one reference: the model receives the session identity
 * and an explicit retrieval instruction instead of the snapshot bytes.
 * Labels and ids are sanitized at read time, so neither can forge a line.
 */
function pointerText(references: SessionReferenceInput[]): string {
  return references.map((reference) => {
    const label = reference.label ?? reference.sessionId;
    const id = reference.sessionId;
    return [
      `Referenced session: ${label} (${id})`,
      `Its content is not inlined. If this task needs information from it, retrieve it with session_event_search (targetSessionId ${id}) or session_search, then answer from what you retrieve. Do not fabricate content from this session.`,
    ].join('\n');
  }).join('\n\n');
}

/** Render the prepared additional context to the plain text the composer inserts. */
function renderContextText(prepared: PreparedReferencedMessage): string {
  const context = prepared.additionalContext;
  if (context === undefined) return '';
  return context.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n');
}

/**
 * Map any thrown error to the transport shape. RouteError carries its own
 * precise message; every other failure stays opaque — unknown messages can
 * carry filesystem or database internals, so they never reach the wire.
 */
export function errorBody(error: unknown): RouteErrorBody {
  if (error instanceof RouteError) {
    return { error: { ...(error.code === undefined ? {} : { code: error.code }), message: error.message } };
  }
  return { error: { code: 'XSSN_INTERNAL', message: 'internal error' } };
}

/** HTTP status for any thrown error. */
export function errorStatus(error: unknown): number {
  if (error instanceof RouteError) return error.status;
  return 500;
}
