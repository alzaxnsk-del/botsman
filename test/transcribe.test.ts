import { describe, it, expect } from 'vitest';
import {
  resolveTranscriptionSettings, parseTranscriptionResponse, transcribeAudio, audioFileName,
  MAX_AUDIO_BYTES, voiceHeardMsg, voiceNotConfiguredMsg,
} from '../src/gateway/transcribe.js';

describe('resolveTranscriptionSettings', () => {
  it('returns null when no key is configured anywhere', () => {
    expect(resolveTranscriptionSettings(undefined, {})).toBeNull();
    expect(resolveTranscriptionSettings({ endpoint: 'x' }, {})).toBeNull();
  });

  it('uses a config key with Groq defaults for endpoint/model', () => {
    const s = resolveTranscriptionSettings({ apiKey: 'gsk_abc' }, {});
    expect(s).not.toBeNull();
    expect(s!.apiKey).toBe('gsk_abc');
    expect(s!.endpoint).toBe('https://api.groq.com/openai/v1');
    expect(s!.model).toBe('whisper-large-v3');
    expect(s!.language).toBeUndefined();
  });

  it('falls back to GROQ_API_KEY / OPENAI_API_KEY from the environment', () => {
    expect(resolveTranscriptionSettings(undefined, { GROQ_API_KEY: 'gsk_env' })!.apiKey).toBe('gsk_env');
    expect(resolveTranscriptionSettings(undefined, { OPENAI_API_KEY: 'sk-env' })!.apiKey).toBe('sk-env');
  });

  it('config key wins over env; explicit endpoint/model/language pass through', () => {
    const s = resolveTranscriptionSettings(
      { apiKey: 'gsk_cfg', endpoint: 'https://api.openai.com/v1/', model: 'whisper-1', language: 'ru' },
      { GROQ_API_KEY: 'gsk_env' },
    );
    expect(s!.apiKey).toBe('gsk_cfg');
    expect(s!.endpoint).toBe('https://api.openai.com/v1'); // trailing slash trimmed
    expect(s!.model).toBe('whisper-1');
    expect(s!.language).toBe('ru');
  });
});

describe('parseTranscriptionResponse', () => {
  it('extracts and trims the transcript', () => {
    expect(parseTranscriptionResponse({ text: '  hello world  ' })).toEqual({ ok: true, text: 'hello world' });
  });
  it('treats empty / whitespace / non-string as empty', () => {
    expect(parseTranscriptionResponse({ text: '   ' })).toEqual({ ok: false, reason: 'empty' });
    expect(parseTranscriptionResponse({})).toEqual({ ok: false, reason: 'empty' });
    expect(parseTranscriptionResponse(null)).toEqual({ ok: false, reason: 'empty' });
    expect(parseTranscriptionResponse({ text: 42 })).toEqual({ ok: false, reason: 'empty' });
  });
});

const settings = { apiKey: 'gsk_test', endpoint: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3' };

describe('transcribeAudio', () => {
  it('posts to the OpenAI-compatible endpoint with a bearer token and returns the transcript', async () => {
    let calledUrl = '';
    let auth = '';
    const fetchFn = (async (url: string, init: RequestInit) => {
      calledUrl = url;
      auth = (init.headers as Record<string, string>).Authorization;
      return { ok: true, json: async () => ({ text: 'привет мир' }), text: async () => '' };
    }) as unknown as typeof fetch;
    const r = await transcribeAudio({ bytes: Buffer.from([1, 2, 3]), fileName: 'voice.ogg', settings, fetchFn });
    expect(r).toEqual({ ok: true, text: 'привет мир' });
    expect(calledUrl).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect(auth).toBe('Bearer gsk_test');
  });

  it('sends the model, response_format and (when set) language form fields', async () => {
    let body: FormData | undefined;
    const fetchFn = (async (_url: string, init: RequestInit) => {
      body = init.body as FormData;
      return { ok: true, json: async () => ({ text: 'x' }), text: async () => '' };
    }) as unknown as typeof fetch;
    await transcribeAudio({ bytes: Buffer.from([1]), fileName: 'voice.ogg', settings: { ...settings, language: 'ru' }, fetchFn });
    expect(body?.get('model')).toBe('whisper-large-v3');
    expect(body?.get('response_format')).toBe('json');
    expect(body?.get('language')).toBe('ru');
  });

  it('omits the language field when no language is configured', async () => {
    let body: FormData | undefined;
    const fetchFn = (async (_url: string, init: RequestInit) => {
      body = init.body as FormData;
      return { ok: true, json: async () => ({ text: 'x' }), text: async () => '' };
    }) as unknown as typeof fetch;
    await transcribeAudio({ bytes: Buffer.from([1]), fileName: 'voice.ogg', settings, fetchFn });
    expect(body?.get('language')).toBeNull();
  });

  it('rejects oversized audio without calling the network', async () => {
    let called = false;
    const fetchFn = (async () => { called = true; return { ok: true, json: async () => ({ text: 'x' }) }; }) as unknown as typeof fetch;
    const r = await transcribeAudio({ bytes: new Uint8Array(MAX_AUDIO_BYTES + 1), fileName: 'voice.ogg', settings, fetchFn });
    expect(r).toEqual({ ok: false, reason: 'too_big' });
    expect(called).toBe(false);
  });

  it('maps an HTTP error to a failed result', async () => {
    const fetchFn = (async () => ({ ok: false, status: 401, text: async () => 'invalid key' })) as unknown as typeof fetch;
    const r = await transcribeAudio({ bytes: Buffer.from([1]), fileName: 'voice.ogg', settings, fetchFn });
    expect(r).toEqual({ ok: false, reason: 'failed' });
  });

  it('maps an empty transcript to an empty result', async () => {
    const fetchFn = (async () => ({ ok: true, json: async () => ({ text: '   ' }), text: async () => '' })) as unknown as typeof fetch;
    const r = await transcribeAudio({ bytes: Buffer.from([1]), fileName: 'voice.ogg', settings, fetchFn });
    expect(r).toEqual({ ok: false, reason: 'empty' });
  });

  it('never throws on a network failure — resolves to failed', async () => {
    const fetchFn = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    const r = await transcribeAudio({ bytes: Buffer.from([1]), fileName: 'voice.ogg', settings, fetchFn });
    expect(r).toEqual({ ok: false, reason: 'failed' });
  });
});

describe('audioFileName', () => {
  it('names by kind, preserving an audio file name when present', () => {
    expect(audioFileName('voice')).toBe('voice.ogg');
    expect(audioFileName('video_note')).toBe('note.mp4');
    expect(audioFileName('audio')).toBe('audio.mp3');
    expect(audioFileName('audio', 'song.m4a')).toBe('song.m4a');
    expect(audioFileName('audio', 'no-extension')).toBe('audio.mp3');
  });
});

describe('voice copy', () => {
  it('echoes what was heard and truncates very long transcripts', () => {
    expect(voiceHeardMsg('build a todo app')).toContain('build a todo app');
    expect(voiceHeardMsg('a'.repeat(1000)).length).toBeLessThan(650);
  });
  it('points the owner at /setup when transcription is off', () => {
    expect(voiceNotConfiguredMsg).toMatch(/setup/i);
  });
});
