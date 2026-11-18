/**
 * Finto LALAL.AI per i test: stessi percorsi e stesse forme di risposta dell'API v1
 * (https://www.lalal.ai/api/v1/openapi.json). Serve anche qualche file di prova.
 */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

export const VALID_KEY = 'TEST-ACTIVATION-KEY';
export const SONG_BYTES = Buffer.alloc(300_000, 7);

export function startMockLalal(port) {
  const uploads = [];
  const tasks = new Map();
  const deleted = [];

  const send = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const readBody = async (req) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks);
  };

  const tracksFor = (task) => {
    const track = (type, label) => ({ type, label, url: `https://d.lalal.ai/${task.id}/abcd/${label}` });
    if (task.kind === 'change_voice') return [track('back', 'converted_mix')];
    if (task.kind === 'demuser') return [track('stem', 'music'), track('back', 'no_music')];
    if (task.kind === 'voice_clean') return [track('stem', 'voice'), track('back', 'no_voice')];
    if (task.kind === 'multistem') {
      return [...task.presets.stem_list.map((stem) => track('stem', stem)), track('back', 'no_multistem')];
    }
    if (task.presets.multivocal === 'lead_back') {
      return [track('stem', 'vocals@0'), track('stem', 'vocals@1'), track('back', 'no_vocals'), track('back', 'mix_no_lead')];
    }
    return [track('stem', task.presets.stem), track('back', `no_${task.presets.stem}`)];
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    // File di prova per i caricamenti da URL.
    if (url.pathname === '/files/song.mp3') {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': SONG_BYTES.length });
      return res.end(SONG_BYTES);
    }
    if (url.pathname === '/files/named') {
      res.writeHead(200, {
        'Content-Type': 'audio/wav',
        'Content-Length': SONG_BYTES.length,
        'Content-Disposition': `attachment; filename*=UTF-8''canzone%20%C3%A8%20mia.wav`,
      });
      return res.end(SONG_BYTES);
    }
    if (url.pathname === '/files/chunked') {
      res.writeHead(200, { 'Content-Type': 'audio/flac' });
      res.write(SONG_BYTES.subarray(0, 100_000));
      return res.end(SONG_BYTES.subarray(100_000));
    }
    if (url.pathname === '/files/redirect') {
      res.writeHead(302, { Location: '/files/song.mp3' });
      return res.end();
    }
    if (url.pathname === '/files/page') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<html><body>Sign in</body></html>');
    }
    if (url.pathname === '/__state') {
      return send(res, 200, { uploads, deleted, tasks: [...tasks.values()] });
    }

    if (!url.pathname.startsWith('/api/v1/') || req.method !== 'POST') return send(res, 404, { detail: 'Not found' });
    const path = url.pathname.slice('/api/v1'.length);

    const key = req.headers['x-license-key'];
    if (!key) {
      await readBody(req);
      return send(res, 401, { detail: 'Authentication is required.', code: 'authentication_required' });
    }
    if (key !== VALID_KEY) {
      await readBody(req);
      return send(res, 401, {
        detail: 'The provided credentials are invalid or no longer active.',
        code: 'invalid_credentials',
      });
    }

    if (path === '/upload/') {
      const body = await readBody(req);
      const disposition = req.headers['content-disposition'] ?? '';
      const extended = disposition.match(/filename\*=utf-8''(.+)$/i);
      const plain = disposition.match(/filename="?([^";]+)"?/i);
      if (!extended && !plain) return send(res, 400, { detail: 'Content-Disposition is required.', code: 'bad_request' });
      const upload = {
        id: randomUUID(),
        name: extended ? decodeURIComponent(extended[1]) : plain[1],
        size: body.length,
        duration: 180,
        expires: Math.floor(Date.now() / 1000) + 86_400,
      };
      uploads.push({
        ...upload,
        contentLength: req.headers['content-length'] ?? null,
        transferEncoding: req.headers['transfer-encoding'] ?? null,
        firstByte: body[0],
      });
      return send(res, 200, upload);
    }

    const raw = await readBody(req);
    let body = {};
    try {
      body = raw.length ? JSON.parse(raw.toString()) : {};
    } catch {
      return send(res, 422, { detail: 'Invalid JSON' });
    }

    if (path === '/limits/minutes_left/') return send(res, 200, { minutes_left: 123.5 });
    if (path === '/voice_packs/list/') {
      return send(res, 200, { packs: [{ name: 'La mia voce', pack_id: randomUUID(), created: 1_760_000_000 }] });
    }

    const split = path.match(/^\/split\/(stem_separator|multistem|voice_clean|demuser)\/$/);
    if (split || path === '/change_voice/') {
      if (!uploads.some((upload) => upload.id === body.source_id)) {
        return send(res, 400, { detail: 'Source file not found.', code: 'source_not_found' });
      }
      const id = randomUUID();
      // Convenzioni del finto server: lo stem "wind" non finisce mai, "strings" fallisce.
      const slow = body.presets?.stem === 'wind';
      tasks.set(id, { id, kind: split ? split[1] : 'change_voice', source_id: body.source_id, presets: body.presets, polls: 0, slow, cancelled: false });
      return send(res, 200, { task_id: id });
    }

    if (path === '/check/') {
      const result = {};
      for (const id of body.task_ids ?? []) {
        const task = tasks.get(id);
        if (!task) {
          result[id] = { status: 'server_error', error: 'Failed to extract information about task' };
          continue;
        }
        task.polls++;
        const base = { source_id: task.source_id, presets: task.presets };
        if (task.cancelled) result[id] = { ...base, status: 'cancelled' };
        else if (task.presets?.stem === 'strings') {
          result[id] = { ...base, status: 'error', error: { detail: 'Unable to detect strings in the uploaded file', code: 'inference_error', id: 'e1' } };
        } else if (task.slow || task.polls < 2) result[id] = { ...base, status: 'progress', progress: 42 };
        else result[id] = { ...base, status: 'success', result: { duration: 180, tracks: tracksFor(task) } };
      }
      return send(res, 200, { result });
    }

    if (path === '/cancel/' || path === '/cancel/all/') {
      const ids = path === '/cancel/' ? (body.task_ids ?? []) : [...tasks.keys()];
      const result = {};
      for (const id of ids) {
        const task = tasks.get(id);
        if (task && !task.cancelled) {
          task.cancelled = true;
          result[id] = { status: 'success' };
        } else result[id] = { status: 'server_error', error: 'Task is not in progress state' };
      }
      return send(res, 200, { result });
    }

    if (path === '/delete/') {
      deleted.push(body.source_id);
      return send(res, 200, {});
    }

    return send(res, 404, { detail: 'Not found' });
  });

  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
