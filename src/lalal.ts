/**
 * Client minimale per l'API v1 di LALAL.AI (https://www.lalal.ai/api/v1/docs/).
 * Autenticazione: header `X-License-Key` con la activation key dell'utente.
 */

const DEFAULT_BASE = 'https://www.lalal.ai/api/v1';
const JSON_TIMEOUT_MS = 30_000;

export type SplitKind = 'stem_separator' | 'multistem' | 'voice_clean' | 'demuser';

export interface Upload {
  id: string;
  name: string;
  size: number;
  duration: number;
  /** Unix time: a questa data LALAL.AI elimina il file e i suoi risultati. */
  expires: number;
}

export interface Track {
  type: 'stem' | 'back';
  label: string;
  url: string;
  name?: string | null;
  size?: number | null;
}

export interface TaskState {
  status: 'progress' | 'success' | 'error' | 'cancelled' | 'server_error';
  source_id?: string;
  progress?: number;
  result?: { tracks: Track[]; duration: number };
  error?: string | { detail: string; code?: string | null };
}

export interface VoicePack {
  name: string;
  pack_id: string;
  created: number;
}

export class LalalApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    readonly detail: unknown,
  ) {
    const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
    super(`LALAL.AI error ${status}${code ? ` (${code})` : ''}: ${text}`);
    this.name = 'LalalApiError';
  }

  /** La chiave è assente, sbagliata o non più attiva. */
  get invalidKey(): boolean {
    return this.status === 401;
  }
}

export class Lalal {
  private readonly base: string;

  constructor(
    private readonly licenseKey: string,
    base?: string,
  ) {
    this.base = (base || DEFAULT_BASE).replace(/\/+$/, '');
  }

  async minutesLeft(): Promise<number> {
    const data = await this.post<{ minutes_left: number }>('/limits/minutes_left/');
    return data.minutes_left;
  }

  async voicePacks(): Promise<VoicePack[]> {
    const data = await this.post<{ packs: VoicePack[] }>('/voice_packs/list/');
    return data.packs;
  }

  /**
   * Carica un file passando il flusso così com'è, senza tenerlo in memoria.
   * Con `length` nota la richiesta parte con Content-Length; altrimenti a blocchi (chunked).
   */
  async upload(body: ReadableStream<Uint8Array>, filename: string, length?: number): Promise<Upload> {
    let payload = body;
    if (length !== undefined && Number.isSafeInteger(length) && length > 0) {
      const fixed = new FixedLengthStream(length);
      // Un errore di lettura fa fallire la fetch qui sotto, che lo riporta: niente rejection orfana.
      body.pipeTo(fixed.writable).catch(() => {});
      payload = fixed.readable;
    }
    return this.request<Upload>('/upload/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': contentDisposition(filename),
      },
      body: payload,
    });
  }

  async startSplit(kind: SplitKind, sourceId: string, presets: Record<string, unknown>): Promise<string> {
    const data = await this.post<{ task_id: string }>(`/split/${kind}/`, { source_id: sourceId, presets });
    return data.task_id;
  }

  async startVoiceChange(sourceId: string, presets: Record<string, unknown>): Promise<string> {
    const data = await this.post<{ task_id: string }>('/change_voice/', { source_id: sourceId, presets });
    return data.task_id;
  }

  async check(taskIds: string[]): Promise<Record<string, TaskState>> {
    const data = await this.post<{ result: Record<string, TaskState> }>('/check/', { task_ids: taskIds });
    return data.result;
  }

  async cancel(taskIds: string[]): Promise<Record<string, { status: string; error?: string }>> {
    const data = await this.post<{ result: Record<string, { status: string; error?: string }> }>('/cancel/', {
      task_ids: taskIds,
    });
    return data.result;
  }

  async cancelAll(): Promise<Record<string, { status: string; error?: string }>> {
    const data = await this.post<{ result: Record<string, { status: string; error?: string }> }>('/cancel/all/');
    return data.result;
  }

  async deleteSource(sourceId: string): Promise<void> {
    await this.post('/delete/', { source_id: sourceId });
  }

  private post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'POST',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('X-License-Key', this.licenseKey);

    let response: Response;
    try {
      response = await fetch(this.base + path, { ...init, headers });
    } catch (error) {
      throw new LalalApiError(0, 'network_error', `could not reach LALAL.AI (${errorText(error)})`);
    }

    const text = await response.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { detail: text.slice(0, 300) };
    }

    if (!response.ok) {
      const body = (data ?? {}) as { detail?: unknown; code?: unknown };
      throw new LalalApiError(
        response.status,
        typeof body.code === 'string' ? body.code : undefined,
        body.detail ?? text.slice(0, 300),
      );
    }
    return data as T;
  }
}

/** Header Content-Disposition come negli esempi ufficiali: ASCII tra virgolette, altrimenti RFC 5987. */
export function contentDisposition(filename: string): string {
  const clean = sanitizeFilename(filename);
  if (/^[\x20-\x7e]+$/.test(clean)) {
    return `attachment; filename="${clean}"`;
  }
  const encoded = encodeURIComponent(clean).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename*=utf-8''${encoded}`;
}

export function sanitizeFilename(filename: string): string {
  const clean = filename
    .replace(/[\u0000-\u001f\u007f"\\/]/g, '_')
    .trim()
    .slice(0, 180);
  return clean || 'audio';
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
