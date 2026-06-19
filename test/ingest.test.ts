import { describe, it, expect } from 'vitest';
import {
  isImage, extractDocText, buildDocInstruction, buildImageInstruction, imageFileName,
  MAX_DOC_BYTES, docTooBigMsg, docBinaryMsg, docAcceptedMsg,
} from '../src/gateway/ingest.js';

describe('isImage', () => {
  it('matches by extension and by MIME, not text specs', () => {
    expect(isImage('mockup.png')).toBe(true);
    expect(isImage('shot.JPEG')).toBe(true);
    expect(isImage('file', 'image/webp')).toBe(true);
    expect(isImage('spec.md')).toBe(false);
    expect(isImage('data.json', 'application/json')).toBe(false);
  });

  it('treats SVG as text, not a raster image', () => {
    expect(isImage('logo.svg')).toBe(false);
    expect(isImage('logo', 'image/svg+xml')).toBe(false);
    const r = extractDocText(Buffer.from('<svg xmlns="...">…</svg>', 'utf8'), 'logo.svg', 'image/svg+xml');
    expect(r.ok).toBe(true);
  });
});

describe('extractDocText', () => {
  it('reads an allowlisted text doc', () => {
    const r = extractDocText(Buffer.from('# Spec\nBuild a todo app.', 'utf8'), 'TECH_SPEC.md', 'text/markdown');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toContain('Build a todo app.');
  });

  it('reads plain UTF-8 even with no known extension', () => {
    const r = extractDocText(Buffer.from('just some notes about the service', 'utf8'), 'NOTES');
    expect(r.ok).toBe(true);
  });

  it('rejects oversize documents', () => {
    const big = Buffer.alloc(MAX_DOC_BYTES + 1, 0x61); // 'a' — passes content, fails size
    const r = extractDocText(big, 'huge.md');
    expect(r).toEqual({ ok: false, reason: 'too_big' });
  });

  it('rejects a NUL-bearing binary blob', () => {
    const r = extractDocText(Buffer.from([0x68, 0x69, 0x00, 0x68]), 'thing.bin');
    expect(r).toEqual({ ok: false, reason: 'binary' });
  });

  it('rejects control-char binary with no known extension', () => {
    const r = extractDocText(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 1, 2, 3, 4]), 'thing.dat');
    expect(r).toEqual({ ok: false, reason: 'binary' });
  });
});

describe('buildDocInstruction', () => {
  it('leads with the caption and fences the body as untrusted data', () => {
    const out = buildDocInstruction({ caption: 'build this', body: 'BODY', name: 'spec.md' });
    expect(out.startsWith('build this')).toBe(true);
    expect(out).toContain('<<<BEGIN spec.md>>>');
    expect(out).toContain('<<<END spec.md>>>');
    expect(out).toContain('BODY');
    expect(out).toMatch(/DATA/); // explicit "treat as data" framing (injection guard)
  });

  it('falls back to a default lead naming the file when there is no caption', () => {
    const out = buildDocInstruction({ body: 'BODY', name: 'spec.md' });
    expect(out).toContain('spec.md');
    expect(out).toContain('BODY');
  });
});

describe('buildImageInstruction', () => {
  it('references the file path and tells the agent to Read it', () => {
    const out = buildImageInstruction({ caption: 'make it like this', fileRef: 'reference.png', mode: 'edit' });
    expect(out.startsWith('make it like this')).toBe(true);
    expect(out).toContain('./reference.png');
    expect(out).toContain('Read');
  });

  it('uses a create-vs-edit default lead with no caption', () => {
    expect(buildImageInstruction({ fileRef: 'reference.png', mode: 'create' })).toMatch(/[Bb]uild/);
    expect(buildImageInstruction({ fileRef: 'reference.png', mode: 'edit' })).toMatch(/change/i);
  });
});

describe('imageFileName', () => {
  it('derives a fixed safe name from extension or MIME', () => {
    expect(imageFileName('photo.jpg', 'image/jpeg')).toBe('reference.jpg');
    expect(imageFileName(undefined, 'image/png')).toBe('reference.png');
    expect(imageFileName('mock.WEBP')).toBe('reference.webp');
    expect(imageFileName()).toBe('reference.png'); // sane default
  });
});

describe('copy is English and informative', () => {
  it('states the size cap and names the file', () => {
    expect(docTooBigMsg('big.md', 300 * 1024)).toContain('256');
    expect(docBinaryMsg('x.pdf')).toContain('x.pdf');
    expect(docAcceptedMsg('spec.md', 16 * 1024)).toContain('spec.md');
  });
});
