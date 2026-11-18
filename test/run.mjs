/**
 * Test end-to-end: avvia il Worker in locale (wrangler dev) davanti a un finto LALAL.AI e
 * percorre lo stesso cammino di Claude: scoperta OAuth, registrazione, pagina di collegamento,
 * scambio dei token, chiamate MCP a tutti gli strumenti.
 *
 *   npm test
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SONG_BYTES, VALID_KEY, startMockLalal } from './mock-lalal.mjs';

const WORKER_PORT = 8787;
const MOCK_PORT = 8799;
const BASE = `http://127.0.0.1:${WORKER_PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

let passed = 0;
const failures = [];
async function test(name, run) {
  try {
    await run();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${String(error?.message ?? error).split('\n').join('\n       ')}`);
  }
}

// ── Avvio ───────────────────────────────────────────────────────────────────────────────

// Un Worker rimasto acceso da una prova precedente falserebbe i risultati.
if (await fetch(`${BASE}/`).then(() => true, () => false)) {
  console.error(`La porta ${WORKER_PORT} è già occupata: chiudi il processo che la usa e riprova.`);
  process.exit(1);
}

const mock = await startMockLalal(MOCK_PORT);
const stateDir = mkdtempSync(join(tmpdir(), 'lalal-mcp-test-'));
const worker = spawn(
  'npx',
  [
    'wrangler', 'dev',
    '--port', String(WORKER_PORT),
    '--ip', '127.0.0.1',
    '--var', `LALAL_API_BASE:${MOCK}/api/v1`,
    '--persist-to', stateDir,
    '--show-interactive-dev-session=false',
  ],
  // Gruppo di processi proprio: alla fine si chiude wrangler insieme al runtime che ha avviato.
  { env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
);
let workerLog = '';
worker.stdout.on('data', (chunk) => (workerLog += chunk));
worker.stderr.on('data', (chunk) => (workerLog += chunk));

async function shutdown(code) {
  const signalGroup = (signal) => {
    try {
      process.kill(-worker.pid, signal);
    } catch {
      // Già terminato.
    }
  };
  signalGroup('SIGTERM');
  mock.close();
  await sleep(1500);
  signalGroup('SIGKILL');
  rmSync(stateDir, { recursive: true, force: true });
  process.exit(code);
}

for (let attempt = 0; ; attempt++) {
  try {
    if ((await fetch(`${BASE}/`)).ok) break;
  } catch {
    // Non ancora pronto.
  }
  if (attempt > 120 || worker.exitCode !== null) {
    console.error(`Il Worker non è partito.\n${workerLog}`);
    await shutdown(1);
  }
  await sleep(500);
}

// ── Aiuti ───────────────────────────────────────────────────────────────────────────────

const mockState = async () => (await fetch(`${MOCK}/__state`)).json();

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function register(redirectUri = CLAUDE_CALLBACK) {
  const response = await fetch(`${BASE}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Claude',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()).client_id;
}

function authorizeUrl(clientId, challenge, redirectUri = CLAUDE_CALLBACK) {
  const url = new URL(`${BASE}/authorize`);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'state-123',
    scope: 'lalal offline_access',
    resource: `${BASE}/mcp`,
  }).toString();
  return url;
}

/** Apre la pagina di collegamento come farebbe il browser e ne restituisce modulo e cookie. */
async function openConsent(clientId, challenge) {
  const response = await fetch(authorizeUrl(clientId, challenge), { redirect: 'manual' });
  const html = await response.text();
  const cookie = response.headers
    .getSetCookie()
    .map((entry) => entry.split(';')[0])
    .join('; ');
  const fields = Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1], m[2]]));
  return { response, html, cookie, fields };
}

function submitConsent(consent, extra) {
  return fetch(`${BASE}/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: consent.cookie },
    body: new URLSearchParams({ ...consent.fields, ...extra }),
  });
}

function token(params) {
  return fetch(`${BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
}

async function connect(accessToken) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    }),
  );
  return client;
}

/** Chiama uno strumento e ne legge la risposta JSON (o il testo d'errore). */
async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content[0].text;
  if (result.isError) return { isError: true, text };
  return JSON.parse(text);
}

// ── Scoperta e collegamento ─────────────────────────────────────────────────────────────

console.log('\nScoperta OAuth');
let clientId;
let tokens;

await test('una richiesta senza token riceve 401 con il puntatore ai metadati', async () => {
  const response = await fetch(`${BASE}/mcp`, { method: 'POST', body: '{}' });
  assert.equal(response.status, 401);
  const challenge = response.headers.get('www-authenticate');
  assert.match(challenge, /^Bearer /);
  assert.ok(
    challenge.includes(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`),
    `WWW-Authenticate: ${challenge}`,
  );
});

await test('i metadati della risorsa indicano esattamente l’URL del connettore', async () => {
  for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
    const response = await fetch(`${BASE}${path}`);
    assert.equal(response.status, 200, path);
    const metadata = await response.json();
    assert.equal(metadata.resource, `${BASE}/mcp`);
    assert.deepEqual(metadata.authorization_servers, [BASE]);
    assert.deepEqual(metadata.scopes_supported, ['lalal']);
  }
});

await test('i metadati del server di autorizzazione offrono ciò che Claude richiede', async () => {
  const metadata = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  assert.equal(metadata.issuer, BASE);
  assert.equal(metadata.authorization_endpoint, `${BASE}/authorize`);
  assert.equal(metadata.token_endpoint, `${BASE}/oauth/token`);
  assert.equal(metadata.registration_endpoint, `${BASE}/oauth/register`);
  assert.ok(metadata.code_challenge_methods_supported.includes('S256'));
  assert.ok(metadata.token_endpoint_auth_methods_supported.includes('none'));
  assert.ok(metadata.grant_types_supported.includes('refresh_token'));
  assert.ok(metadata.scopes_supported.includes('offline_access'));
  assert.equal(metadata.client_id_metadata_document_supported, true);
});

console.log('\nCollegamento');

await test('Claude può registrarsi come client pubblico', async () => {
  clientId = await register();
  assert.ok(clientId);
});

await test('la pagina di collegamento mostra a chi va l’accesso e non è incorniciabile', async () => {
  const { response, html, cookie, fields } = await openConsent(clientId, pkce().challenge);
  assert.equal(response.status, 200, html);
  assert.match(html, /Collega LALAL\.AI/);
  assert.match(html, /<strong>claude\.ai<\/strong>/);
  assert.ok(fields.handle && cookie, 'handle e cookie di legame presenti');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
});

await test('una chiave sbagliata non collega nulla e si può riprovare', async () => {
  const { verifier, challenge } = pkce();
  const consent = await openConsent(clientId, challenge);
  const wrong = await submitConsent(consent, { decision: 'approve', license_key: 'chiave-sbagliata' });
  assert.equal(wrong.status, 422);
  assert.equal(wrong.headers.get('location'), null);
  const html = await wrong.text();
  assert.match(html, /non riconosce questa chiave/);
  assert.match(html, /<strong>claude\.ai<\/strong>/);

  const empty = await submitConsent(consent, { decision: 'approve', license_key: '  ' });
  assert.equal(empty.status, 422);

  // Stessa pagina, chiave giusta: il collegamento va a buon fine.
  const right = await submitConsent(consent, { decision: 'approve', license_key: ` ${VALID_KEY} ` });
  assert.equal(right.status, 302, await right.text());
  const location = new URL(right.headers.get('location'));
  assert.equal(location.origin + location.pathname, CLAUDE_CALLBACK);
  assert.equal(location.searchParams.get('state'), 'state-123');
  assert.equal(location.searchParams.get('iss'), BASE);

  const exchanged = await token({
    grant_type: 'authorization_code',
    code: location.searchParams.get('code'),
    client_id: clientId,
    redirect_uri: CLAUDE_CALLBACK,
    code_verifier: verifier,
    resource: `${BASE}/mcp`,
  });
  assert.equal(exchanged.status, 200, await exchanged.clone().text());
  tokens = await exchanged.json();
  assert.ok(tokens.access_token && tokens.refresh_token);
  assert.equal(tokens.token_type.toLowerCase(), 'bearer');
  assert.ok(tokens.expires_in > 0);
});

await test('lo scambio del codice fallisce senza il verificatore PKCE corretto', async () => {
  const consent = await openConsent(clientId, pkce().challenge);
  const approved = await submitConsent(consent, { decision: 'approve', license_key: VALID_KEY });
  const code = new URL(approved.headers.get('location')).searchParams.get('code');
  const response = await token({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    redirect_uri: CLAUDE_CALLBACK,
    code_verifier: pkce().verifier,
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'invalid_grant');
});

await test('«Annulla» riporta a Claude con access_denied', async () => {
  const consent = await openConsent(clientId, pkce().challenge);
  const response = await submitConsent(consent, { decision: 'deny' });
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get('location'));
  assert.equal(location.searchParams.get('error'), 'access_denied');
  assert.equal(location.searchParams.get('state'), 'state-123');
});

await test('una pagina aperta in un altro browser non può essere completata', async () => {
  const consent = await openConsent(clientId, pkce().challenge);
  const response = await submitConsent({ ...consent, cookie: '' }, { decision: 'approve', license_key: VALID_KEY });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /Pagina scaduta/);
});

await test('un client con redirect estraneo a Claude viene respinto', async () => {
  const foreign = await register('https://evil.example/callback');
  const response = await fetch(authorizeUrl(foreign, pkce().challenge, 'https://evil.example/callback'), { redirect: 'manual' });
  assert.equal(response.status, 403);
  assert.match(await response.text(), /Collegamento non consentito/);
});

await test('un redirect locale (Claude Code) è accettato con avviso', async () => {
  const local = await register('http://localhost:3118/callback');
  const response = await fetch(authorizeUrl(local, pkce().challenge, 'http://localhost:51234/callback'), { redirect: 'manual' });
  const html = await response.text();
  assert.equal(response.status, 200, html);
  assert.match(html, /programma su questo computer/);
});

// ── Strumenti MCP ───────────────────────────────────────────────────────────────────────

console.log('\nStrumenti MCP');
if (!tokens) {
  console.log('  (saltati: collegamento non riuscito)');
} else {
  const client = await connect(tokens.access_token);
  let uploadedId;
  let uploadUrl;

  await test('il server si presenta e dichiara 13 strumenti ben formati', async () => {
    assert.equal(client.getServerVersion().name, 'lalal-ai');
    assert.match(client.getInstructions(), /LALAL\.AI/);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 13);
    for (const tool of tools) {
      assert.match(tool.name, /^lalal_[a-z_]+$/);
      assert.ok(tool.title && tool.description.length > 20, tool.name);
      assert.equal(tool.inputSchema.type, 'object', tool.name);
      assert.equal(typeof tool.annotations.readOnlyHint, 'boolean', tool.name);
    }
  });

  await test('minuti residui', async () => {
    assert.deepEqual(await call(client, 'lalal_minutes_left'), { minutes_left: 123.5 });
  });

  await test('link di caricamento: pagina, invio del file e stato', async () => {
    const link = await call(client, 'lalal_create_upload_link');
    uploadUrl = link.upload_url;
    assert.match(uploadUrl, new RegExp(`^${BASE}/u/[A-Za-z0-9_-]{43}$`));
    assert.ok(link.curl.includes(`${uploadUrl}/`));

    const pageResponse = await fetch(uploadUrl);
    assert.equal(pageResponse.status, 200);
    assert.match(await pageResponse.text(), /Carica un file su LALAL\.AI/);
    assert.match(pageResponse.headers.get('content-security-policy'), /script-src 'nonce-/);

    assert.deepEqual((await call(client, 'lalal_upload_status', { upload_url: uploadUrl })).uploads, []);

    const put = await fetch(`${uploadUrl}/${encodeURIComponent('mio brano.mp3')}`, { method: 'PUT', body: SONG_BYTES });
    assert.equal(put.status, 200, await put.clone().text());
    const file = await put.json();
    uploadedId = file.source_id;
    assert.equal(file.name, 'mio brano.mp3');
    assert.equal(file.size_bytes, SONG_BYTES.length);

    const received = (await mockState()).uploads.at(-1);
    assert.equal(received.contentLength, String(SONG_BYTES.length), 'il file arriva a LALAL.AI con Content-Length');
    assert.equal(received.firstByte, 7);

    // La lettura da KV può restare indietro di qualche istante.
    let uploads = [];
    for (let attempt = 0; attempt < 40 && uploads.length === 0; attempt++) {
      uploads = (await call(client, 'lalal_upload_status', { upload_url: uploadUrl })).uploads;
      if (uploads.length === 0) await sleep(1000);
    }
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].source_id, uploadedId);
  });

  await test('link di caricamento: anche con POST e con corpo a blocchi senza lunghezza', async () => {
    const post = await fetch(`${uploadUrl}/secondo.wav`, { method: 'POST', body: SONG_BYTES });
    assert.equal(post.status, 200);
    assert.equal((await post.json()).name, 'secondo.wav');

    const chunks = new ReadableStream({
      start(controller) {
        controller.enqueue(SONG_BYTES.subarray(0, 1000));
        controller.enqueue(SONG_BYTES.subarray(1000));
        controller.close();
      },
    });
    const streamed = await fetch(uploadUrl, { method: 'PUT', body: chunks, duplex: 'half', headers: { 'X-Filename': 'terzo.flac' } });
    assert.equal(streamed.status, 200, await streamed.clone().text());
    const file = await streamed.json();
    assert.equal(file.name, 'terzo.flac');
    assert.equal(file.size_bytes, SONG_BYTES.length);
  });

  await test('un link di caricamento inesistente o malformato viene rifiutato', async () => {
    const fake = `${BASE}/u/${randomBytes(32).toString('base64url')}`;
    assert.equal((await fetch(`${fake}/x.mp3`, { method: 'PUT', body: 'x' })).status, 404);
    assert.equal((await fetch(fake)).status, 404);
    assert.equal((await fetch(`${BASE}/u/corto/x.mp3`, { method: 'PUT', body: 'x' })).status, 404);
    const status = await call(client, 'lalal_upload_status', { upload_url: fake });
    assert.ok(status.isError);
    assert.equal((await fetch(`${uploadUrl}/x.mp3`, { method: 'DELETE' })).status, 405);
  });

  await test('separazione voce da un file già caricato', async () => {
    const result = await call(client, 'lalal_separate_stem', { source_id: uploadedId, stem: 'vocals', wait_seconds: 30 });
    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.deepEqual(result.tracks.map((track) => track.label), ['vocals', 'no_vocals']);
    assert.match(result.tracks[1].what, /karaoke/);
    assert.match(result.tracks[1].url, /^https:\/\/d\.lalal\.ai\//);
    assert.equal(result.source_id, uploadedId);
    const task = (await mockState()).tasks.at(-1);
    assert.deepEqual(task.presets, { stem: 'vocals' });
  });

  await test('separazione partendo da un URL: il file viene caricato in streaming', async () => {
    const result = await call(client, 'lalal_separate_stem', {
      url: `${MOCK}/files/song.mp3`,
      stem: 'drum',
      splitter: 'perseus',
      extraction_level: 'clear_cut',
      output_format: 'wav',
    });
    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.equal(result.uploaded_file.name, 'song.mp3');
    assert.equal(result.uploaded_file.size_bytes, SONG_BYTES.length);
    const state = await mockState();
    assert.equal(state.uploads.at(-1).contentLength, String(SONG_BYTES.length));
    assert.deepEqual(state.tasks.at(-1).presets, { stem: 'drum', splitter: 'perseus', extraction_level: 'clear_cut', encoder_format: 'wav' });
  });

  await test('caricamento da URL: nome non ASCII, redirect, lunghezza ignota', async () => {
    const named = await call(client, 'lalal_upload_from_url', { url: `${MOCK}/files/named` });
    assert.equal(named.name, 'canzone è mia.wav');

    const redirected = await call(client, 'lalal_upload_from_url', { url: `${MOCK}/files/redirect`, filename: 'scelto.mp3' });
    assert.equal(redirected.name, 'scelto.mp3');
    assert.equal(redirected.size_bytes, SONG_BYTES.length);

    const chunked = await call(client, 'lalal_upload_from_url', { url: `${MOCK}/files/chunked` });
    assert.equal(chunked.size_bytes, SONG_BYTES.length);
    assert.equal(chunked.name, 'chunked.flac');
  });

  await test('caricamento da URL: errori spiegati', async () => {
    const page = await call(client, 'lalal_upload_from_url', { url: `${MOCK}/files/page` });
    assert.ok(page.isError);
    assert.match(page.text, /web page/);
    const missing = await call(client, 'lalal_upload_from_url', { url: `${MOCK}/files/missing` });
    assert.match(missing.text, /HTTP 404/);
    const mega = await call(client, 'lalal_upload_from_url', { url: 'https://mega.nz/file/abc#def' });
    assert.match(mega.text, /MEGA/);
    const scheme = await call(client, 'lalal_upload_from_url', { url: 'ftp://example.com/a.mp3' });
    assert.match(scheme.text, /http\(s\)/);
  });

  await test('voce solista e cori separati', async () => {
    const result = await call(client, 'lalal_separate_stem', {
      source_id: uploadedId,
      stem: 'vocals',
      lead_and_backing_vocals: true,
      dereverb: true,
    });
    assert.deepEqual(result.tracks.map((track) => track.label), ['vocals@0', 'vocals@1', 'no_vocals', 'mix_no_lead']);
    assert.deepEqual((await mockState()).tasks.at(-1).presets, { stem: 'vocals', dereverb_enabled: true, multivocal: 'lead_back' });

    const wrong = await call(client, 'lalal_separate_stem', { source_id: uploadedId, stem: 'bass', lead_and_backing_vocals: true });
    assert.ok(wrong.isError);
  });

  await test('più stem, pulizia voce, rimozione musica, cambio voce', async () => {
    const multi = await call(client, 'lalal_separate_multistem', { source_id: uploadedId, stems: ['vocals', 'drum', 'vocals'] });
    assert.deepEqual(multi.tracks.map((track) => track.label), ['vocals', 'drum', 'no_multistem']);

    const clean = await call(client, 'lalal_clean_voice', { source_id: uploadedId, noise_cancelling_level: 2, splitter: 'cepheus' });
    assert.deepEqual(clean.tracks.map((track) => track.label), ['voice', 'no_voice']);
    assert.deepEqual((await mockState()).tasks.at(-1).presets, { stem: 'voice', noise_cancelling_level: 2, splitter: 'cepheus' });

    const demuser = await call(client, 'lalal_remove_music', { source_id: uploadedId });
    assert.deepEqual(demuser.tracks.map((track) => track.label), ['music', 'no_music']);

    const voice = await call(client, 'lalal_change_voice', { source_id: uploadedId, voice_pack_id: 'ALEX_KAYE', accent: 0.3 });
    assert.deepEqual(voice.tracks.map((track) => track.label), ['converted_mix']);
    assert.deepEqual((await mockState()).tasks.at(-1).presets, { voice_pack_id: 'ALEX_KAYE', accent: 0.3 });

    const packs = await call(client, 'lalal_list_voice_packs');
    assert.equal(packs.voice_packs[0].name, 'La mia voce');
    assert.ok(packs.ready_made_pack_ids.includes('VETRANA'));
  });

  await test('task lento: si riceve il task_id, lo si controlla e lo si annulla', async () => {
    const started = await call(client, 'lalal_separate_stem', { source_id: uploadedId, stem: 'wind', wait_seconds: 4 });
    assert.equal(started.status, 'progress', JSON.stringify(started));
    assert.equal(started.progress_percent, 42);

    const noWait = await call(client, 'lalal_separate_stem', { source_id: uploadedId, stem: 'wind', wait_seconds: 0 });
    assert.equal(noWait.status, 'progress');
    assert.equal(noWait.progress_percent, undefined);

    const checked = await call(client, 'lalal_check_tasks', { task_ids: [started.task_id, noWait.task_id] });
    assert.deepEqual(checked.tasks.map((task) => task.status), ['progress', 'progress']);

    const cancelled = await call(client, 'lalal_cancel_tasks', { task_ids: [started.task_id] });
    assert.equal(cancelled.result[started.task_id].status, 'success');
    const after = await call(client, 'lalal_check_tasks', { task_ids: [started.task_id] });
    assert.equal(after.tasks[0].status, 'cancelled');

    assert.ok((await call(client, 'lalal_cancel_tasks', {})).isError);
    const all = await call(client, 'lalal_cancel_tasks', { all: true });
    assert.equal(all.result[noWait.task_id].status, 'success');
  });

  await test('task fallito e task sconosciuto riportano l’errore di LALAL.AI', async () => {
    const failed = await call(client, 'lalal_separate_stem', { source_id: uploadedId, stem: 'strings' });
    assert.equal(failed.status, 'error');
    assert.match(failed.error, /Unable to detect strings/);

    const unknown = await call(client, 'lalal_check_tasks', { task_ids: ['3f2b8a3e-5a1c-4c0e-9d57-2f1f0a6f7b11'] });
    assert.equal(unknown.tasks[0].status, 'error');

    const noSource = await call(client, 'lalal_separate_stem', { source_id: '3f2b8a3e-5a1c-4c0e-9d57-2f1f0a6f7b11', stem: 'vocals' });
    assert.ok(noSource.isError);
    assert.match(noSource.text, /Source file not found/);
  });

  await test('parametri mancanti o non validi vengono rifiutati con una spiegazione', async () => {
    const noSource = await call(client, 'lalal_separate_stem', { stem: 'vocals' });
    assert.ok(noSource.isError);
    assert.match(noSource.text, /lalal_create_upload_link/);

    const badStem = await client.callTool({ name: 'lalal_separate_stem', arguments: { source_id: uploadedId, stem: 'kazoo' } }).catch((error) => ({ isError: true, content: [{ text: String(error) }] }));
    assert.ok(badStem.isError);
    assert.equal((await mockState()).tasks.some((task) => task.presets?.stem === 'kazoo'), false);
  });

  await test('eliminazione di file e risultati', async () => {
    const result = await call(client, 'lalal_delete_source', { source_id: uploadedId });
    assert.deepEqual(result, { deleted: true, source_id: uploadedId });
    assert.ok((await mockState()).deleted.includes(uploadedId));
  });

  await client.close();

  console.log('\nProtocollo JSON-RPC');
  const rpc = (body, headers = {}) =>
    fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  await test('versione del protocollo: quella chiesta se supportata, altrimenti la più recente', async () => {
    const init = (protocolVersion) => ({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion, capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    const older = await (await rpc(init('2025-03-26'))).json();
    assert.equal(older.result.protocolVersion, '2025-03-26');
    const unknown = await (await rpc(init('2099-01-01'))).json();
    assert.equal(unknown.result.protocolVersion, '2025-11-25');
    assert.deepEqual(unknown.result.capabilities, { tools: {} });
  });

  await test('notifiche 202, ping, metodo sconosciuto, JSON non valido, batch', async () => {
    const notification = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(notification.status, 202);
    assert.equal(await notification.text(), '');

    assert.deepEqual(await (await rpc({ jsonrpc: '2.0', id: 'p', method: 'ping' })).json(), { jsonrpc: '2.0', id: 'p', result: {} });

    const missing = await (await rpc({ jsonrpc: '2.0', id: 2, method: 'resources/list' })).json();
    assert.equal(missing.error.code, -32601);

    const broken = await rpc('{non json');
    assert.equal(broken.status, 400);
    assert.equal((await broken.json()).error.code, -32700);

    const invalid = await (await rpc({ id: 3, method: 'ping' })).json();
    assert.equal(invalid.error.code, -32600);

    const batch = await (await rpc([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }])).json();
    assert.deepEqual(batch.map((reply) => reply.id), [1, 2]);
    assert.equal(batch[1].result.tools.length, 13);
  });

  await test('chiamata a uno strumento: SSE per chi lo accetta, JSON altrimenti; null = parametro assente', async () => {
    const callBody = { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'lalal_cancel_tasks', arguments: { task_ids: null, all: null } } };
    const stream = await rpc(callBody);
    assert.match(stream.headers.get('content-type'), /^text\/event-stream/);
    const event = await stream.text();
    assert.match(event, /^event: message\ndata: \{.*\}\n\n$/s);
    const viaStream = JSON.parse(event.split('data: ')[1]);
    assert.equal(viaStream.id, 7);
    assert.equal(viaStream.result.isError, true);
    assert.match(viaStream.result.content[0].text, /Provide task_ids/);

    const plain = await rpc(callBody, { Accept: 'application/json' });
    assert.match(plain.headers.get('content-type'), /^application\/json/);
    assert.deepEqual(await plain.json(), viaStream);

    const unknownTool = await (await rpc({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'nope' } }, { Accept: 'application/json' })).json();
    assert.equal(unknownTool.error.code, -32602);

    const badArgs = await (await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'lalal_check_tasks', arguments: { task_ids: ['x'], wait_seconds: 999 } } }, { Accept: 'application/json' })).json();
    assert.equal(badArgs.result.isError, true);
    assert.match(badArgs.result.content[0].text, /task_ids\/0: .*pattern.*wait_seconds: 999 is greater than 180/s);
  });

  console.log('\nToken');

  await test('GET su /mcp non apre flussi: 405', async () => {
    const response = await fetch(`${BASE}/mcp`, { headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'text/event-stream' } });
    assert.equal(response.status, 405);
  });

  await test('un token inventato viene respinto con 401', async () => {
    const response = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer inventato' }, body: '{}' });
    assert.equal(response.status, 401);
  });

  await test('il refresh token rinnova l’accesso e ruota', async () => {
    const response = await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId });
    assert.equal(response.status, 200, await response.clone().text());
    const renewed = await response.json();
    assert.ok(renewed.access_token && renewed.access_token !== tokens.access_token);
    assert.ok(renewed.refresh_token && renewed.refresh_token !== tokens.refresh_token);
    const renewedClient = await connect(renewed.access_token);
    assert.deepEqual(await call(renewedClient, 'lalal_minutes_left'), { minutes_left: 123.5 });
    await renewedClient.close();

    const invalid = await token({ grant_type: 'refresh_token', refresh_token: 'inventato', client_id: clientId });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error, 'invalid_grant');
  });
}

console.log('\nPagine');

await test('pagina iniziale con l’indirizzo del connettore, 404 per il resto', async () => {
  const home = await fetch(`${BASE}/`);
  assert.equal(home.status, 200);
  assert.ok((await home.text()).includes(`value="${BASE}/mcp"`));
  assert.equal((await fetch(`${BASE}/qualcosa`)).status, 404);
  assert.match(await (await fetch(`${BASE}/robots.txt`)).text(), /Disallow: \//);
});

console.log(`\n${passed} test superati, ${failures.length} falliti`);
if (failures.length) console.log(`\n--- log del Worker ---\n${workerLog.slice(-4000)}`);
await shutdown(failures.length ? 1 : 0);
