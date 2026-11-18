/**
 * Gli strumenti LALAL.AI offerti a Claude: descrizione, parametri (JSON Schema) ed esecuzione.
 * Gli schemi sono scritti a mano: sono esattamente ciò che il modello legge.
 */
import { type Lalal, LalalApiError, type TaskState, type Upload } from './lalal';
import { UserError, uploadFromUrl } from './sources';
import type { Env } from './types';
import { MAX_UPLOAD_MB, createUploadLink, listUploads } from './uploads';

/** Claude interrompe una chiamata dopo 240 secondi: si resta sotto con margine. */
const TOOL_BUDGET_MS = 200_000;
const DEFAULT_WAIT_SECONDS = 120;
const MAX_WAIT_SECONDS = 180;
const POLL_INTERVAL_MS = 5_000;
/** Il piano gratuito di Workers concede 50 richieste in uscita per chiamata. */
const MAX_POLLS = 36;

const READY_MADE_VOICE_PACKS = ['ALEX_KAYE', 'STASIA_FAYE', 'NICOLAAS_HAAS', 'NIK_ZEL', 'OLIA_CHEBO', 'YVAR_DE_GROOT', 'VETRANA'];

export interface Session {
  env: Env;
  origin: string;
  licenseKey: string;
  lalal: Lalal;
  startedAt: number;
}

type JsonSchema = Record<string, unknown>;

export interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint: boolean };
  /**
   * Restituisce i dati da mostrare al modello; gli errori previsti si segnalano lanciando.
   * `args` arriva già validato contro `inputSchema`, per questo qui è `any`.
   */
  // biome-ignore lint/suspicious/noExplicitAny: validato a runtime con lo schema
  run(session: Session, args: any): Promise<unknown>;
}

// ── Parametri ricorrenti ────────────────────────────────────────────────────────────────

const UUID_PATTERN = '^[0-9a-fA-F-]{32,36}$';

const SOURCE = {
  source_id: {
    type: 'string',
    pattern: UUID_PATTERN,
    description: 'ID of a file already on LALAL.AI (returned by an upload or by a previous task). Preferred when available.',
  },
  url: {
    type: 'string',
    description:
      'Direct http(s) link to the audio or video file; it is uploaded first. Google Drive and Dropbox share links work when the file is public. Ignored if source_id is given.',
  },
};

const OUTPUT = {
  output_format: {
    type: 'string',
    enum: ['mp3', 'wav', 'flac', 'aac', 'ogg'],
    description: 'Format of the result files. Default: same as the source file.',
  },
  wait_seconds: {
    type: 'integer',
    minimum: 0,
    maximum: MAX_WAIT_SECONDS,
    description: `Seconds to wait for the result before returning (default ${DEFAULT_WAIT_SECONDS}). If the task is still running you get its task_id to poll with lalal_check_tasks.`,
  },
};

const DEREVERB = { type: 'boolean', description: 'Also remove echo/reverb from the voice. Default false.' };

const EXTRACTION_LEVEL = {
  type: 'string',
  enum: ['deep_extraction', 'clear_cut'],
  description:
    'deep_extraction (default) keeps more detail with more bleed between stems; clear_cut is cleaner but can lose detail. Ignored by andromeda.',
};

const splitter = (models: string[], note: string) => ({
  type: 'string',
  enum: models,
  description: `Model. Leave unset ("auto" picks the newest suitable one) unless the user asks. ${note}`,
});

const params = (properties: JsonSchema = {}, required: string[] = []): JsonSchema => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
});

// ── Risultati ───────────────────────────────────────────────────────────────────────────

const TRACK_MEANING: Record<string, string> = {
  vocals: 'isolated vocals',
  no_vocals: 'instrumental: the song without vocals (karaoke base)',
  'vocals@0': 'lead vocals',
  'vocals@1': 'backing vocals',
  mix_no_lead: 'instrumental with backing vocals, without the lead vocal',
  no_multistem: 'rest of the song without the extracted stems',
  music: 'background music',
  no_music: 'the recording without music (usually the voice)',
  voice: 'clean voice',
  no_voice: 'the removed background noise',
  converted_mix: 'the recording with the new voice',
};

function trackMeaning(label: string): string {
  return TRACK_MEANING[label] ?? (label.startsWith('no_') ? `the song without ${label.slice(3)}` : `isolated ${label}`);
}

function describeUpload(upload: Upload) {
  return {
    source_id: upload.id,
    name: upload.name,
    size_bytes: upload.size,
    duration_seconds: upload.duration,
    expires_at: new Date(upload.expires * 1000).toISOString(),
  };
}

function describeTask(taskId: string, state: TaskState | undefined) {
  if (!state || state.status === 'progress') {
    return {
      task_id: taskId,
      status: 'progress',
      ...(state?.progress !== undefined ? { progress_percent: state.progress } : {}),
      ...(state?.source_id ? { source_id: state.source_id } : {}),
      next_step: 'Still processing. Call lalal_check_tasks with this task_id (use wait_seconds to wait for it).',
    };
  }
  if (state.status === 'success' && state.result) {
    return {
      task_id: taskId,
      status: 'success',
      source_id: state.source_id,
      duration_seconds: state.result.duration,
      tracks: state.result.tracks.map((track) => ({
        label: track.label,
        what: trackMeaning(track.label),
        url: track.url,
        ...(track.name ? { file_name: track.name } : {}),
        ...(track.size ? { size_bytes: track.size } : {}),
      })),
      note: 'The URLs are direct download links. LALAL.AI deletes them together with the source file when it expires, so save them soon.',
    };
  }
  if (state.status === 'cancelled') {
    return { task_id: taskId, status: 'cancelled', source_id: state.source_id };
  }
  const error = typeof state.error === 'string' ? state.error : (state.error?.detail ?? 'Unknown error');
  return { task_id: taskId, status: 'error', error, ...(state.source_id ? { source_id: state.source_id } : {}) };
}

// ── Esecuzione dei task ─────────────────────────────────────────────────────────────────

interface Source {
  sourceId: string;
  uploaded?: ReturnType<typeof describeUpload>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function resolveSource(session: Session, args: { source_id?: string; url?: string }): Promise<Source> {
  if (args.source_id) return { sourceId: args.source_id };
  if (args.url) {
    const upload = await uploadFromUrl(session.lalal, args.url);
    return { sourceId: upload.id, uploaded: describeUpload(upload) };
  }
  throw new UserError(
    'Provide source_id or url. For a file that has no public URL (chat attachment, file on the user device), call lalal_create_upload_link first.',
  );
}

/** Interroga LALAL.AI finché i task non terminano o finisce il tempo a disposizione. */
async function waitForTasks(
  session: Session,
  taskIds: string[],
  waitSeconds: number,
  checkFirst: boolean,
): Promise<Record<string, TaskState>> {
  const deadline = Math.min(Date.now() + waitSeconds * 1000, session.startedAt + TOOL_BUDGET_MS);
  let states: Record<string, TaskState> = {};
  let delay = checkFirst ? 0 : 3_000;

  for (let polls = 0; polls < MAX_POLLS; polls++) {
    if (delay > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(delay, remaining));
    }
    delay = POLL_INTERVAL_MS;
    try {
      states = await session.lalal.check(taskIds);
    } catch (error) {
      // Limite di LALAL.AI: 30 controlli al minuto. Si rallenta e si riprova.
      if (error instanceof LalalApiError && error.status === 429) {
        delay = 10_000;
        continue;
      }
      throw error;
    }
    if (taskIds.every((taskId) => states[taskId] && states[taskId].status !== 'progress')) break;
    if (Date.now() >= deadline) break;
  }
  return states;
}

async function finishTask(session: Session, source: Source, taskId: string, waitSeconds: number | undefined) {
  const wait = waitSeconds ?? DEFAULT_WAIT_SECONDS;
  const states = wait > 0 ? await waitForTasks(session, [taskId], wait, false) : {};
  return {
    ...describeTask(taskId, states[taskId]),
    source_id: source.sourceId,
    ...(source.uploaded ? { uploaded_file: source.uploaded } : {}),
  };
}

/** Copia in `presets` solo le opzioni effettivamente indicate: il resto lo decide LALAL.AI. */
function presets(base: Record<string, unknown>, args: Record<string, unknown>, map: Record<string, string>) {
  const result = { ...base };
  for (const [argument, preset] of Object.entries(map)) {
    const value = args[argument];
    if (value !== undefined && value !== false) result[preset] = value;
  }
  return result;
}

// ── Strumenti ───────────────────────────────────────────────────────────────────────────

export const TOOLS: Tool[] = [
  {
    name: 'lalal_minutes_left',
    title: 'Minutes left',
    description:
      "Processing minutes left on the user's LALAL.AI account. Every task costs minutes: file duration x number of stems extracted.",
    inputSchema: params(),
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: async ({ lalal }) => ({ minutes_left: await lalal.minutesLeft() }),
  },
  {
    name: 'lalal_upload_from_url',
    title: 'Upload a file from a URL',
    description:
      'Upload an audio or video file to LALAL.AI from a direct http(s) link and get its source_id, to run one or more tasks on it. Uploading is free. Not needed when you pass "url" straight to a processing tool.',
    inputSchema: params(
      {
        url: {
          type: 'string',
          description: 'Direct link to the file. Google Drive and Dropbox share links work when the file is public.',
        },
        filename: { type: 'string', maxLength: 180, description: 'File name with extension, if the link does not reveal it.' },
      },
      ['url'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: async ({ lalal }, args: { url: string; filename?: string }) =>
      describeUpload(await uploadFromUrl(lalal, args.url, args.filename)),
  },
  {
    name: 'lalal_create_upload_link',
    title: 'Create an upload link',
    description: `Create a temporary link (valid 1 hour, up to ${MAX_UPLOAD_MB} MB per file) to upload a file that has no public URL: a chat attachment or a file on the user's device. Two ways to use it. (1) If you have a shell with the file, send it yourself with the returned curl command: the JSON reply contains source_id. (2) Otherwise give upload_url to the user to open in a browser and pick the file, then call lalal_upload_status when they say it is done.`,
    inputSchema: params(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: async (session) => {
      const link = await createUploadLink(session.env, session.origin, session.licenseKey);
      return {
        upload_url: link.url,
        expires_in_seconds: link.expiresInSeconds,
        max_size_mb: MAX_UPLOAD_MB,
        curl: `curl -sS -T "<path-to-file>" "${link.url}/"`,
        note: 'The link only allows uploading to the user LALAL.AI account. It can be reused for several files until it expires.',
      };
    },
  },
  {
    name: 'lalal_upload_status',
    title: 'Files uploaded through a link',
    description:
      'List the files uploaded through a link from lalal_create_upload_link, with their source_id. A file can take up to a minute to appear after the upload.',
    inputSchema: params(
      { upload_url: { type: 'string', description: 'The upload_url returned by lalal_create_upload_link.' } },
      ['upload_url'],
    ),
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (session, args: { upload_url: string }) => {
      const uploads = await listUploads(session.env, args.upload_url);
      if (uploads === null) {
        throw new UserError('This upload link has expired or is not valid. Create a new one with lalal_create_upload_link.');
      }
      return {
        uploads,
        ...(uploads.length === 0
          ? { note: 'No file yet. If the user just uploaded one, wait about 30 seconds and call this tool again.' }
          : {}),
      };
    },
  },
  {
    name: 'lalal_separate_stem',
    title: 'Separate one stem from a song',
    description:
      'Extract ONE stem from a song. You get two files: the stem and the rest of the song without it. With stem "vocals": track "no_vocals" is the instrumental (karaoke base) and "vocals" is the a cappella. For music only: for speech use lalal_clean_voice (noise) or lalal_remove_music (music in the background). Costs minutes equal to the file duration.',
    inputSchema: params(
      {
        ...SOURCE,
        stem: {
          type: 'string',
          enum: ['vocals', 'drum', 'bass', 'piano', 'guitar', 'electric_guitar', 'acoustic_guitar', 'synthesizer', 'strings', 'wind'],
          description: '"guitar" = all guitars in one track; "electric_guitar"/"acoustic_guitar" = only that kind.',
        },
        lead_and_backing_vocals: {
          type: 'boolean',
          description:
            'Only with stem "vocals": also split lead and backing vocals. Returns lead (vocals@0), backing (vocals@1), instrumental (no_vocals) and instrumental with backing vocals (mix_no_lead).',
        },
        splitter: splitter(
          ['auto', 'andromeda', 'perseus', 'orion', 'phoenix'],
          'Newest to oldest: andromeda, perseus, orion, phoenix. An older model can do better on noisy vintage recordings.',
        ),
        extraction_level: EXTRACTION_LEVEL,
        dereverb: DEREVERB,
        ...OUTPUT,
      },
      ['stem'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: async (session, args) => {
      if (args.lead_and_backing_vocals && args.stem !== 'vocals') {
        throw new UserError('lead_and_backing_vocals works only with stem "vocals".');
      }
      const source = await resolveSource(session, args);
      const taskId = await session.lalal.startSplit(
        'stem_separator',
        source.sourceId,
        presets(
          { stem: args.stem, ...(args.lead_and_backing_vocals ? { multivocal: 'lead_back' } : {}) },
          args,
          { splitter: 'splitter', extraction_level: 'extraction_level', dereverb: 'dereverb_enabled', output_format: 'encoder_format' },
        ),
      );
      return finishTask(session, source, taskId, args.wait_seconds);
    },
  },
  {
    name: 'lalal_separate_multistem',
    title: 'Separate several stems from a song',
    description:
      'Extract several stems from a song in one task: one file per stem plus the rest of the song. Each stem is charged separately (file duration x number of stems) and processing time grows with the number of stems. For the best quality on a single stem use lalal_separate_stem, which runs a newer model.',
    inputSchema: params(
      {
        ...SOURCE,
        stems: {
          type: 'array',
          minItems: 1,
          maxItems: 6,
          items: { type: 'string', enum: ['vocals', 'drum', 'bass', 'piano', 'electric_guitar', 'acoustic_guitar'] },
          description: 'Stems to extract.',
        },
        splitter: splitter(['auto', 'andromeda', 'perseus', 'orion', 'phoenix'], 'With two or more stems "auto" uses perseus.'),
        extraction_level: EXTRACTION_LEVEL,
        ...OUTPUT,
      },
      ['stems'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: async (session, args) => {
      const source = await resolveSource(session, args);
      const taskId = await session.lalal.startSplit(
        'multistem',
        source.sourceId,
        presets({ stem_list: [...new Set<string>(args.stems)] }, args, {
          splitter: 'splitter',
          extraction_level: 'extraction_level',
          output_format: 'encoder_format',
        }),
      );
      return finishTask(session, source, taskId, args.wait_seconds);
    },
  },
  {
    name: 'lalal_clean_voice',
    title: 'Remove noise from speech',
    description:
      'Remove background noise (crowd, traffic, room, wind) from a SPEECH recording. Returns the clean voice ("voice") and the removed noise ("no_voice"). For singing in a song use lalal_separate_stem; for speech over music use lalal_remove_music. Costs minutes equal to the file duration.',
    inputSchema: params({
      ...SOURCE,
      noise_cancelling_level: {
        type: 'integer',
        minimum: 0,
        maximum: 2,
        description: '0 mild (default), 1 normal, 2 aggressive: also compresses and normalizes the voice so quiet parts get louder.',
      },
      splitter: splitter(
        ['auto', 'lynx', 'cepheus', 'andromeda', 'perseus', 'orion', 'phoenix'],
        '"auto" uses lynx; cepheus is a newer voice model whose results can differ noticeably.',
      ),
      dereverb: DEREVERB,
      ...OUTPUT,
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: async (session, args) => {
      const source = await resolveSource(session, args);
      const taskId = await session.lalal.startSplit(
        'voice_clean',
        source.sourceId,
        presets({ stem: 'voice' }, args, {
          noise_cancelling_level: 'noise_cancelling_level',
          splitter: 'splitter',
          dereverb: 'dereverb_enabled',
          output_format: 'encoder_format',
        }),
      );
      return finishTask(session, source, taskId, args.wait_seconds);
    },
  },
  {
    name: 'lalal_remove_music',
    title: 'Separate speech from background music',
    description:
      'Separate a voice from background music, for example in a video or a podcast. Returns the music ("music") and the recording without it, usually the voice ("no_music"). For non-musical noise use lalal_clean_voice; for vocals in a song use lalal_separate_stem. Costs minutes equal to the file duration.',
    inputSchema: params({ ...SOURCE, dereverb: DEREVERB, ...OUTPUT }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: async (session, args) => {
      const source = await resolveSource(session, args);
      const taskId = await session.lalal.startSplit(
        'demuser',
        source.sourceId,
        presets({ stem: 'music' }, args, { dereverb: 'dereverb_enabled', output_format: 'encoder_format' }),
      );
      return finishTask(session, source, taskId, args.wait_seconds);
    },
  },
  {
    name: 'lalal_change_voice',
    title: 'Change the voice in a recording',
    description: `Replace the voice in a recording with the voice of a voice pack. Returns one file ("converted_mix"). Use a pack_id from lalal_list_voice_packs (the user's own cloned voices) or a ready-made pack: ${READY_MADE_VOICE_PACKS.join(', ')}.`,
    inputSchema: params(
      {
        ...SOURCE,
        voice_pack_id: { type: 'string', minLength: 1, description: 'ID of the voice pack.' },
        accent: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: '0 keeps the accent of the source recording, 1 (default) applies the accent of the voice pack.',
        },
        tonality_reference: {
          type: 'string',
          enum: ['source_file', 'voice_pack'],
          description: 'Whose pitch to follow: the source recording (default) or the voice pack.',
        },
        dereverb: DEREVERB,
        ...OUTPUT,
      },
      ['voice_pack_id'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: async (session, args) => {
      const source = await resolveSource(session, args);
      const taskId = await session.lalal.startVoiceChange(
        source.sourceId,
        presets({ voice_pack_id: args.voice_pack_id }, args, {
          accent: 'accent',
          tonality_reference: 'tonality_reference',
          dereverb: 'dereverb_enabled',
          output_format: 'encoder_format',
        }),
      );
      return finishTask(session, source, taskId, args.wait_seconds);
    },
  },
  {
    name: 'lalal_list_voice_packs',
    title: 'List voice packs',
    description: "The user's own voice packs (cloned voices) for lalal_change_voice. Ready-made packs are not listed here.",
    inputSchema: params(),
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: async ({ lalal }) => ({
      voice_packs: (await lalal.voicePacks()).map((pack) => ({
        pack_id: pack.pack_id,
        name: pack.name,
        created_at: new Date(pack.created * 1000).toISOString(),
      })),
      ready_made_pack_ids: READY_MADE_VOICE_PACKS,
    }),
  },
  {
    name: 'lalal_check_tasks',
    title: 'Check tasks',
    description:
      'Status of one or more tasks: progress, or the result tracks with their download URLs. A task stays available for 24 hours after it finishes.',
    inputSchema: params(
      {
        task_ids: {
          type: 'array',
          minItems: 1,
          maxItems: 200,
          items: { type: 'string', pattern: UUID_PATTERN },
          description: 'Task IDs to check.',
        },
        wait_seconds: {
          type: 'integer',
          minimum: 0,
          maximum: MAX_WAIT_SECONDS,
          description: 'Seconds to wait for tasks still in progress before returning. Default 0: answer immediately.',
        },
      },
      ['task_ids'],
    ),
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: async (session, args: { task_ids: string[]; wait_seconds?: number }) => {
      const states = await waitForTasks(session, args.task_ids, args.wait_seconds ?? 0, true);
      return { tasks: args.task_ids.map((taskId) => describeTask(taskId, states[taskId])) };
    },
  },
  {
    name: 'lalal_cancel_tasks',
    title: 'Cancel tasks',
    description: 'Cancel tasks that are still in progress: the given task_ids, or every running task with all=true.',
    inputSchema: params({
      task_ids: { type: 'array', maxItems: 200, items: { type: 'string', pattern: UUID_PATTERN }, description: 'Tasks to cancel.' },
      all: { type: 'boolean', description: 'Cancel every task in progress on the account.' },
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    run: async ({ lalal }, args: { task_ids?: string[]; all?: boolean }) => {
      if (args.all) return { result: await lalal.cancelAll() };
      if (!args.task_ids?.length) throw new UserError('Provide task_ids, or all=true to cancel every running task.');
      return { result: await lalal.cancel(args.task_ids) };
    },
  },
  {
    name: 'lalal_delete_source',
    title: 'Delete a file and its results',
    description:
      'Delete a source file and all its result files from LALAL.AI servers. Running tasks on that file are cancelled, and download links stop working within an hour. Use it only when the user has saved what they need or asks for deletion.',
    inputSchema: params({ source_id: { type: 'string', pattern: UUID_PATTERN, description: 'ID of the source file to delete.' } }, ['source_id']),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    run: async ({ lalal }, args: { source_id: string }) => {
      await lalal.deleteSource(args.source_id);
      return { deleted: true, source_id: args.source_id };
    },
  },
];
