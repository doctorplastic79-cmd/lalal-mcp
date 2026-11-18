/**
 * Link temporanei per caricare su LALAL.AI un file che non è raggiungibile da un URL
 * (allegato in chat, file sul telefono). Il link vale un'ora e permette solo di caricare:
 * la license key è salvata cifrata con una chiave derivata dal link stesso, quindi né
 * l'archivio KV né chi vede il link possono leggerla.
 */
import { page } from './html';
import { Lalal, LalalApiError, errorText } from './lalal';
import type { Env } from './types';

const KV_PREFIX = 'lalal-upload:';
const TTL_SECONDS = 3600;
const TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** Limite di Cloudflare sul corpo di una richiesta nei piani Free e Pro. */
export const MAX_UPLOAD_MB = 100;
const MAX_REMEMBERED_UPLOADS = 50;

export interface UploadedFile {
  source_id: string;
  name: string;
  size_bytes: number;
  duration_seconds: number;
  expires_at: string;
  uploaded_at: string;
}

interface UploadRecord {
  iv: string;
  ciphertext: string;
  created: number;
  uploads: UploadedFile[];
}

export async function createUploadLink(
  env: Env,
  origin: string,
  licenseKey: string,
): Promise<{ url: string; expiresInSeconds: number }> {
  const ticket = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await encryptionKey(ticket),
    new TextEncoder().encode(licenseKey),
  );
  const record: UploadRecord = {
    iv: toBase64Url(iv),
    ciphertext: toBase64Url(new Uint8Array(ciphertext)),
    created: Date.now(),
    uploads: [],
  };
  await env.OAUTH_KV.put(await storageKey(ticket), JSON.stringify(record), { expirationTtl: TTL_SECONDS });
  return { url: `${origin}/u/${ticket}`, expiresInSeconds: TTL_SECONDS };
}

/** File caricati finora tramite un link; `null` se il link non esiste più. */
export async function listUploads(env: Env, uploadUrl: string): Promise<UploadedFile[] | null> {
  const ticket = ticketFromUrl(uploadUrl);
  if (!ticket) return null;
  const record = await readRecord(env, ticket);
  return record ? record.uploads : null;
}

/** Gestisce `/u/<ticket>` (pagina) e `/u/<ticket>/<nome-file>` (caricamento). */
export async function handleUploadRoute(request: Request, env: Env): Promise<Response> {
  const [, , ticket, ...rest] = new URL(request.url).pathname.split('/');
  if (!ticket || !TICKET_PATTERN.test(ticket)) {
    return json({ error: 'Invalid upload link.' }, 404);
  }

  if (request.method === 'GET' || request.method === 'HEAD') {
    return uploadPage((await readRecord(env, ticket)) !== null);
  }
  if (request.method !== 'PUT' && request.method !== 'POST') {
    return json({ error: 'Use PUT or POST with the file as the request body.' }, 405, { Allow: 'GET, PUT, POST' });
  }

  const record = await readRecord(env, ticket);
  if (!record) {
    return json({ error: 'This upload link has expired or is not valid. Create a new one.' }, 404);
  }
  if (!request.body) {
    return json({ error: 'The request has no body: send the file as the raw request body.' }, 400);
  }

  const declared = request.headers.get('content-length');
  const length = declared && /^\d+$/.test(declared) ? Number(declared) : undefined;
  const filename = decodeSegment(rest.join('/')) || request.headers.get('x-filename') || 'audio';

  let licenseKey: string;
  try {
    licenseKey = await decryptLicenseKey(ticket, record);
  } catch {
    return json({ error: 'This upload link is not valid. Create a new one.' }, 404);
  }

  try {
    const upload = await new Lalal(licenseKey, env.LALAL_API_BASE).upload(request.body, filename, length);
    const file: UploadedFile = {
      source_id: upload.id,
      name: upload.name,
      size_bytes: upload.size,
      duration_seconds: upload.duration,
      expires_at: new Date(upload.expires * 1000).toISOString(),
      uploaded_at: new Date().toISOString(),
    };
    record.uploads = [...record.uploads, file].slice(-MAX_REMEMBERED_UPLOADS);
    const remaining = TTL_SECONDS - Math.floor((Date.now() - record.created) / 1000);
    // KV non accetta scadenze sotto i 60 secondi.
    await env.OAUTH_KV.put(await storageKey(ticket), JSON.stringify(record), {
      expirationTtl: Math.max(60, remaining),
    });
    return json(file, 200);
  } catch (error) {
    if (error instanceof LalalApiError) {
      const status = error.status >= 400 && error.status < 500 ? error.status : 502;
      return json({ error: error.message }, status);
    }
    return json({ error: `Upload failed: ${errorText(error)}` }, 502);
  }
}

async function readRecord(env: Env, ticket: string): Promise<UploadRecord | null> {
  // cacheTtl al minimo: lo stato letto dopo un caricamento deve aggiornarsi in fretta.
  return env.OAUTH_KV.get<UploadRecord>(await storageKey(ticket), { type: 'json', cacheTtl: 30 });
}

async function decryptLicenseKey(ticket: string, record: UploadRecord): Promise<string> {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64Url(record.iv) },
    await encryptionKey(ticket),
    fromBase64Url(record.ciphertext),
  );
  return new TextDecoder().decode(plain);
}

// Chiave di archiviazione e chiave di cifratura derivano entrambe dal ticket, ma con
// prefissi diversi: conoscere la prima non aiuta a ricavare la seconda.
async function storageKey(ticket: string): Promise<string> {
  const digest = await sha256(`lalal-mcp upload id v1:${ticket}`);
  return KV_PREFIX + [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function encryptionKey(ticket: string): Promise<CryptoKey> {
  const digest = await sha256(`lalal-mcp upload key v1:${ticket}`);
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

function ticketFromUrl(uploadUrl: string): string | null {
  try {
    const [, prefix, ticket] = new URL(uploadUrl.trim()).pathname.split('/');
    return prefix === 'u' && ticket && TICKET_PATTERN.test(ticket) ? ticket : null;
  } catch {
    return null;
  }
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function json(body: unknown, status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders },
  });
}

function uploadPage(valid: boolean): Response {
  if (!valid) {
    return page({
      title: 'Link scaduto',
      status: 404,
      body: `<h1>Link scaduto</h1><p>Questo link di caricamento non è più valido. Chiedi a Claude di crearne uno nuovo.</p>`,
    });
  }
  return page({
    title: 'Carica un file su LALAL.AI',
    body: `<h1>Carica un file su LALAL.AI</h1>
<p>Scegli il file audio o video da elaborare. Finito il caricamento, torna alla chat con Claude.</p>
<label for="file">File (massimo ${MAX_UPLOAD_MB} MB)</label>
<input id="file" type="file" accept="audio/*,video/*,.mp3,.wav,.flac,.m4a,.aac,.ogg,.aiff,.mp4,.mov,.mkv,.webm">
<progress id="bar" max="100" value="0" hidden></progress>
<p id="error" class="alert" role="alert" hidden></p>
<div id="done" class="ok" role="status" hidden></div>`,
    script: UPLOAD_SCRIPT,
  });
}

const UPLOAD_SCRIPT = `
(() => {
  const input = document.getElementById('file');
  const bar = document.getElementById('bar');
  const errorBox = document.getElementById('error');
  const done = document.getElementById('done');
  const fail = (text) => { bar.hidden = true; input.disabled = false; errorBox.textContent = text; errorBox.hidden = false; };
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    if (!file) return;
    errorBox.hidden = true; done.hidden = true;
    if (file.size > ${MAX_UPLOAD_MB} * 1024 * 1024) { fail('Il file supera i ${MAX_UPLOAD_MB} MB. Usa un file più piccolo o passa a Claude un link diretto al file.'); return; }
    input.disabled = true; bar.hidden = false; bar.value = 0;
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', location.pathname.replace(/\\/+$/, '') + '/' + encodeURIComponent(file.name));
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) bar.value = (event.loaded / event.total) * 100; };
    xhr.onerror = () => fail('Connessione interrotta. Riprova.');
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch (_) {}
      if (xhr.status !== 200) { fail(data.error || 'Caricamento non riuscito (errore ' + xhr.status + ').'); return; }
      bar.hidden = true; input.disabled = false; input.value = '';
      done.textContent = 'Caricato: ' + data.name + '. Torna alla chat e scrivi «fatto». Codice del file: ' + data.source_id;
      done.hidden = false;
    };
    xhr.send(file);
  });
})();
`;
