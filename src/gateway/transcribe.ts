/**
 * Speech-to-text for voice notes the owner sends to the bot. Telegram delivers a
 * voice message as an OGG/Opus file; Anthropic (the only auth Botsman otherwise
 * needs) can't read audio, so transcription goes through a separate, OPTIONAL
 * OpenAI-compatible Whisper endpoint — Groq's free `whisper-large-v3` by default,
 * but any OpenAI-style `/audio/transcriptions` server works (OpenAI itself, a
 * self-hosted whisper). When no key is configured, voice is politely refused.
 *
 * Same split as ingest.ts/format.ts: the decidable, pure logic (config
 * resolution, response parsing, user-facing copy) lives here and is unit-tested
 * without a live bot; the gateway is a thin shell that does the download + reply.
 * All user-facing copy is ENGLISH only (Variant A — the bot understands Russian
 * input but replies in English).
 */

import { logger } from '../logger.js';

/** Whisper's hard ceiling on most hosted endpoints (Groq/OpenAI) is 25 MB; a
 *  Telegram voice note is a tiny fraction of that, so this only guards forwarded
 *  audio files. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

const DEFAULT_ENDPOINT = 'https://api.groq.com/openai/v1';
const DEFAULT_MODEL = 'whisper-large-v3';

/** Resolved, ready-to-use transcription settings (a key is mandatory). */
export interface TranscriptionSettings {
  apiKey: string;
  /** Base URL WITHOUT the trailing `/audio/transcriptions` (that's appended). */
  endpoint: string;
  model: string;
  /** Optional ISO-639-1 hint; omitted ⇒ the model auto-detects the language. */
  language?: string;
}

/** Config shape as stored under `transcription` in config.json. */
export interface TranscriptionConfig {
  apiKey?: string;
  endpoint?: string;
  model?: string;
  language?: string;
}

/**
 * Merge config + environment into usable settings, or null when transcription
 * isn't enabled (no key anywhere). The key may come from config.json
 * (`transcription.apiKey`) or, as a convenience for VPS owners, the
 * `GROQ_API_KEY` / `OPENAI_API_KEY` environment variables. Endpoint/model fall
 * back to Groq's free Whisper.
 */
export function resolveTranscriptionSettings(
  cfg?: TranscriptionConfig,
  env: Record<string, string | undefined> = {},
): TranscriptionSettings | null {
  const apiKey =
    cfg?.apiKey?.trim() || env.GROQ_API_KEY?.trim() || env.OPENAI_API_KEY?.trim() || '';
  if (!apiKey) return null;
  const endpoint = (cfg?.endpoint?.trim() || env.TRANSCRIPTION_ENDPOINT?.trim() || DEFAULT_ENDPOINT)
    .replace(/\/+$/, ''); // tolerate a trailing slash in config
  return {
    apiKey,
    endpoint,
    model: cfg?.model?.trim() || env.TRANSCRIPTION_MODEL?.trim() || DEFAULT_MODEL,
    language: cfg?.language?.trim() || undefined,
  };
}

export type TranscriptionResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'too_big' | 'empty' | 'failed' };

/** Pull the transcript out of an OpenAI-compatible JSON response, or signal that
 *  it was empty (silence / nothing recognised). Pure, so it's unit-testable. */
export function parseTranscriptionResponse(raw: unknown): { ok: true; text: string } | { ok: false; reason: 'empty' } {
  const text = (raw as { text?: unknown })?.text;
  const trimmed = typeof text === 'string' ? text.trim() : '';
  return trimmed ? { ok: true, text: trimmed } : { ok: false, reason: 'empty' };
}

/**
 * Transcribe audio bytes via the configured OpenAI-compatible Whisper endpoint.
 * Never throws — any network/HTTP/parse failure resolves to `{ ok: false }` so
 * the caller can show a friendly message. `fetchFn` is injectable for tests.
 */
export async function transcribeAudio(opts: {
  bytes: Uint8Array;
  fileName: string;
  mime?: string;
  settings: TranscriptionSettings;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}): Promise<TranscriptionResult> {
  if (opts.bytes.length > MAX_AUDIO_BYTES) return { ok: false, reason: 'too_big' };
  const fetchFn = opts.fetchFn ?? fetch;
  const { settings } = opts;
  try {
    const form = new FormData();
    // Copy into a fresh ArrayBuffer-backed view: Buffer/Uint8Array's backing type
    // (ArrayBufferLike) doesn't satisfy the DOM BlobPart typing directly.
    const blob = new Blob([new Uint8Array(opts.bytes)], { type: opts.mime || 'audio/ogg' });
    form.append('file', blob, opts.fileName);
    form.append('model', settings.model);
    form.append('response_format', 'json');
    if (settings.language) form.append('language', settings.language);
    const res = await fetchFn(`${settings.endpoint}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${settings.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    });
    if (!res.ok) {
      // The body can carry the provider's reason (bad key, unsupported format);
      // log it (never the audio or key) so a misconfig is diagnosable.
      const detail = await res.text().catch(() => '');
      logger.warn('transcription request failed', { status: res.status, detail: detail.slice(0, 200) });
      return { ok: false, reason: 'failed' };
    }
    const data = await res.json().catch(() => null);
    return parseTranscriptionResponse(data);
  } catch (e) {
    logger.warn('transcription error', { error: String((e as Error).message) });
    return { ok: false, reason: 'failed' };
  }
}

/** A safe, Whisper-friendly file name for the uploaded audio, by its kind. */
export function audioFileName(kind: 'voice' | 'audio' | 'video_note', name?: string): string {
  if (kind === 'audio' && name && /\.[a-z0-9]{2,4}$/i.test(name)) return name;
  if (kind === 'video_note') return 'note.mp4';
  if (kind === 'audio') return 'audio.mp3';
  return 'voice.ogg';
}

// --- reply copy (English only — Variant A) ------------------------------------
export const voiceTranscribingMsg = '🎤 Listening…';
/** What we heard, echoed before acting on it (so a misheard word is visible). */
export const voiceHeardMsg = (text: string): string => {
  const t = text.length > 600 ? text.slice(0, 599) + '…' : text;
  return `🎤 Heard: “${t}”`;
};
export const voiceEmptyMsg =
  "🎤 I couldn't make out any words in that — try recording again, a bit closer to the mic, or type it out.";
export const voiceFailedMsg =
  "🎤 I couldn't transcribe that voice note just now. Try again, or type your request.";
export const voiceTooBigMsg = `🎤 That audio is too long to transcribe (max ${MAX_AUDIO_BYTES / (1024 * 1024)} MB). Send a shorter clip, or type it out.`;
/** Shown when no STT key is configured — voice is off until one is added. */
export const voiceNotConfiguredMsg =
  "🎤 Voice transcription isn't switched on yet. Enable it in /setup → 🎤 Voice (a free Groq key), then I'll understand voice notes. For now, type it out.";
