import { type Lalal, type Upload, sanitizeFilename } from './lalal';

/** Errore da mostrare tale e quale al modello: dice cosa non va e come rimediare. */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

const EXTENSION_BY_TYPE: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aiff': 'aiff',
  'audio/x-aiff': 'aiff',
  'audio/webm': 'webm',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'video/x-msvideo': 'avi',
};

/**
 * Trasforma i link di condivisione più comuni nel loro download diretto e rifiuta
 * quelli che non possono funzionare, con un messaggio che spiega l'alternativa.
 */
export function normalizeSourceUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UserError('"url" is not a valid URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new UserError('Only http(s) URLs are supported.');
  }

  const host = url.hostname.toLowerCase();
  if (host === 'mega.nz' || host.endsWith('.mega.nz')) {
    throw new UserError(
      'MEGA links are end-to-end encrypted and cannot be fetched directly. Download the file first, then upload it with lalal_create_upload_link.',
    );
  }
  if (host === 'drive.google.com' || host === 'docs.google.com') {
    const id = url.pathname.match(/\/file\/d\/([^/]+)/)?.[1] ?? url.searchParams.get('id');
    if (id) {
      return new URL(
        `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`,
      );
    }
  }
  if (host === 'www.dropbox.com' || host === 'dropbox.com') {
    url.searchParams.set('dl', '1');
  }
  return url;
}

/** Scarica il file dall'URL e lo passa a LALAL.AI in streaming, senza tenerlo in memoria. */
export async function uploadFromUrl(lalal: Lalal, rawUrl: string, filename?: string): Promise<Upload> {
  const url = normalizeSourceUrl(rawUrl);

  let source: Response;
  try {
    source = await fetch(url, { redirect: 'follow', headers: { 'Accept-Encoding': 'identity' } });
  } catch (error) {
    throw new UserError(`Could not download the file from the URL (${error instanceof Error ? error.message : error}).`);
  }
  if (!source.ok || !source.body) {
    await source.body?.cancel();
    throw new UserError(
      `Could not download the file from the URL: the server answered HTTP ${source.status}. The link must be direct and public.`,
    );
  }

  const contentType = (source.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (contentType === 'text/html' || contentType === 'application/xhtml+xml') {
    await source.body.cancel();
    throw new UserError(
      'The URL returned a web page, not a media file. Use a direct download link to a file that is publicly shared (for Google Drive: "anyone with the link"), or upload the file with lalal_create_upload_link.',
    );
  }

  // Con una codifica di trasporto la lunghezza dichiarata non corrisponde ai byte che riceviamo.
  const declared = source.headers.get('content-encoding') ? null : source.headers.get('content-length');
  const length = declared && /^\d+$/.test(declared) ? Number(declared) : undefined;

  const name = filename?.trim() || guessFilename(source, contentType);
  return lalal.upload(source.body, name, length);
}

function guessFilename(source: Response, contentType: string): string {
  const fromHeader = filenameFromDisposition(source.headers.get('content-disposition'));
  let name = fromHeader ?? lastPathSegment(source.url) ?? 'audio';
  name = sanitizeFilename(name);
  if (!/\.[a-z0-9]{2,5}$/i.test(name)) {
    const extension = EXTENSION_BY_TYPE[contentType];
    if (extension) name = `${name}.${extension}`;
  }
  return name;
}

function filenameFromDisposition(header: string | null): string | undefined {
  if (!header) return undefined;
  const extended = header.match(/filename\*\s*=\s*([\w-]+)'[^']*'([^;]+)/i);
  if (extended) {
    try {
      return decodeURIComponent(extended[2].trim());
    } catch {
      // Valore malformato: si passa alla forma semplice.
    }
  }
  const plain = header.match(/filename\s*=\s*("([^"]*)"|[^;]+)/i);
  const value = plain ? (plain[2] ?? plain[1]).trim() : undefined;
  return value || undefined;
}

function lastPathSegment(href: string): string | undefined {
  try {
    const segment = new URL(href).pathname.split('/').filter(Boolean).pop();
    return segment ? decodeURIComponent(segment) : undefined;
  } catch {
    return undefined;
  }
}
