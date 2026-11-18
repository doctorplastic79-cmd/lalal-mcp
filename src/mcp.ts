/**
 * Endpoint MCP (`/mcp`), trasporto Streamable HTTP senza sessioni: ogni POST è autonoma.
 *
 * Il protocollo è implementato qui direttamente, senza SDK: per un server di soli strumenti
 * bastano quattro metodi, e così ogni richiesta costa una frazione di millisecondo di CPU,
 * dentro i limiti del piano gratuito di Cloudflare Workers anche a freddo.
 */
import { Validator } from '@cfworker/json-schema';
import { Lalal, LalalApiError, errorText } from './lalal';
import { UserError } from './sources';
import { TOOLS, type Session, type Tool } from './tools';
import type { Env, Props } from './types';

/** Dalla più recente; se il client ne chiede un'altra si risponde con la prima. */
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'lalal-ai', title: 'LALAL.AI', version: '1.0.0' };
const KEEP_ALIVE_MS = 15_000;

const INSTRUCTIONS = `Tools for the user's LALAL.AI account: stem separation, voice cleaning and voice changing.

Typical flow: get the file into LALAL.AI, start a task, read the result tracks (direct download URLs).
- File reachable by URL: pass "url" directly to a processing tool.
- File attached to the chat or on the user's device: call lalal_create_upload_link first.
- Pick the tool by content: songs -> lalal_separate_stem / lalal_separate_multistem; speech with noise -> lalal_clean_voice; speech over music -> lalal_remove_music.
- Every task spends the user's minutes: file duration x number of stems. Reuse source_id to run more tasks on the same file without uploading it again.
- If a tool returns status "progress", call lalal_check_tasks with the task_id.`;

const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));
const VALIDATORS = new Map(TOOLS.map((tool) => [tool.name, new Validator(tool.inputSchema, '2020-12', false)]));
const TOOL_LIST = TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({
  name,
  title,
  description,
  inputSchema,
  annotations,
}));

// ── JSON-RPC ────────────────────────────────────────────────────────────────────────────

type Id = string | number | null;
type Reply =
  | { jsonrpc: '2.0'; id: Id; result: unknown }
  | { jsonrpc: '2.0'; id: Id; error: { code: number; message: string } };

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

const success = (id: Id, result: unknown): Reply => ({ jsonrpc: '2.0', id, result });
const failure = (id: Id, code: number, message: string): Reply => ({ jsonrpc: '2.0', id, error: { code, message } });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const requestId = (message: unknown): Id =>
  isObject(message) && (typeof message.id === 'string' || typeof message.id === 'number') ? message.id : null;

/** Esegue un messaggio. `null` per ciò che non vuole risposta (notifiche, risposte del client). */
async function handle(message: unknown, session: Session): Promise<Reply | null> {
  if (!isObject(message) || message.jsonrpc !== '2.0') {
    return failure(null, INVALID_REQUEST, 'Invalid JSON-RPC message.');
  }
  if (typeof message.method !== 'string') {
    // Una risposta del client a una nostra richiesta (non ne facciamo) o un messaggio malformato.
    return 'result' in message || 'error' in message ? null : failure(null, INVALID_REQUEST, 'Missing method.');
  }
  if (message.id === undefined) return null; // notifica
  const id = requestId(message);
  if (id === null) return failure(null, INVALID_REQUEST, 'Invalid request id.');

  const params = isObject(message.params) ? message.params : {};

  switch (message.method) {
    case 'initialize': {
      const requested = params.protocolVersion;
      const protocolVersion =
        typeof requested === 'string' && PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
      return success(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return success(id, {});
    case 'tools/list':
      return success(id, { tools: TOOL_LIST });
    case 'tools/call': {
      const tool = typeof params.name === 'string' ? TOOLS_BY_NAME.get(params.name) : undefined;
      if (!tool) return failure(id, INVALID_PARAMS, `Unknown tool: ${String(params.name)}`);
      const args = params.arguments ?? {};
      if (!isObject(args)) return failure(id, INVALID_PARAMS, 'Tool arguments must be an object.');
      return success(id, await callTool(tool, args, session));
    }
    default:
      return failure(id, METHOD_NOT_FOUND, `Method not found: ${message.method}`);
  }
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: true };

const toolError = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

/**
 * Gli errori di uno strumento (parametri sbagliati compresi) tornano come risultato con
 * `isError`, non come errore di protocollo: così il modello li legge e può correggersi.
 */
async function callTool(tool: Tool, rawArguments: Record<string, unknown>, session: Session): Promise<ToolResult> {
  // Un opzionale passato come null equivale a non passarlo.
  const args = Object.fromEntries(Object.entries(rawArguments).filter(([, value]) => value !== null));

  const validation = VALIDATORS.get(tool.name)?.validate(args);
  if (validation && !validation.valid) {
    const problems = validation.errors
      // Le voci "properties"/"items" ripetono soltanto che un figlio non è valido.
      .filter((entry) => entry.keyword !== 'properties' && entry.keyword !== 'items')
      .map((entry) => `${entry.instanceLocation.replace(/^#\/?/, '') || 'arguments'}: ${entry.error}`);
    return toolError(`Invalid arguments for ${tool.name}. ${problems.join(' ')}`);
  }

  try {
    return { content: [{ type: 'text', text: JSON.stringify(await tool.run(session, args), null, 2) }] };
  } catch (error) {
    if (error instanceof UserError) return toolError(error.message);
    if (error instanceof LalalApiError && error.invalidKey) {
      return toolError(
        'LALAL.AI rejected the activation key: it is invalid or no longer active. Ask the user to disconnect and reconnect the LALAL.AI connector in Claude with a valid key.',
      );
    }
    if (error instanceof LalalApiError) return toolError(error.message);
    return toolError(`Unexpected error: ${errorText(error)}`);
  }
}

// ── HTTP ────────────────────────────────────────────────────────────────────────────────

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

/**
 * Risposta in streaming (SSE) per le chiamate agli strumenti: un'elaborazione può durare
 * minuti e i commenti di keep-alive impediscono che la connessione venga chiusa per inattività.
 */
function eventStream(reply: Promise<Reply>): Response {
  const encoder = new TextEncoder();
  let keepAlive: ReturnType<typeof setInterval> | null = null;
  const stopKeepAlive = () => {
    if (keepAlive !== null) clearInterval(keepAlive);
    keepAlive = null;
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // Il client ha chiuso la connessione: non c'è più nessuno a cui scrivere.
        }
      };
      keepAlive = setInterval(() => write(': keepalive\n\n'), KEEP_ALIVE_MS);
      reply
        .then((message) => write(`event: message\ndata: ${JSON.stringify(message)}\n\n`))
        .finally(() => {
          stopKeepAlive();
          try {
            controller.close();
          } catch {
            // Già chiuso dal client.
          }
        });
    },
    cancel: stopKeepAlive,
  });

  return new Response(body, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' },
  });
}

export const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Solo POST: il server non apre flussi propri verso il client e non tiene sessioni.
    if (request.method !== 'POST') {
      return json(failure(null, -32000, 'Method not allowed.'), 405, { Allow: 'POST' });
    }

    // `props` è ciò che la pagina di collegamento ha legato al token, decifrato dal provider OAuth.
    const licenseKey = (ctx.props as Partial<Props> | undefined)?.licenseKey;
    if (!licenseKey) {
      return json(failure(null, INTERNAL_ERROR, 'Missing LALAL.AI credentials: reconnect the connector.'), 500);
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return json(failure(null, PARSE_ERROR, 'Parse error: the body is not valid JSON.'), 400);
    }

    const session: Session = {
      env,
      origin: new URL(request.url).origin,
      licenseKey,
      lalal: new Lalal(licenseKey, env.LALAL_API_BASE),
      startedAt: Date.now(),
    };
    // Qualunque imprevisto diventa un errore JSON-RPC, mai una risposta HTTP rotta.
    const run = (message: unknown): Promise<Reply | null> =>
      handle(message, session).catch((error) => failure(requestId(message), INTERNAL_ERROR, errorText(error)));

    if (Array.isArray(payload)) {
      if (payload.length === 0) return json(failure(null, INVALID_REQUEST, 'Empty batch.'), 400);
      const replies = (await Promise.all(payload.map(run))).filter((reply) => reply !== null);
      return replies.length ? json(replies) : new Response(null, { status: 202 });
    }

    const wantsStream = (request.headers.get('accept') ?? '').includes('text/event-stream');
    if (wantsStream && isObject(payload) && payload.method === 'tools/call' && requestId(payload) !== null) {
      return eventStream(run(payload).then((reply) => reply ?? failure(null, INTERNAL_ERROR, 'No reply.')));
    }

    const reply = await run(payload);
    return reply ? json(reply) : new Response(null, { status: 202 });
  },
};
