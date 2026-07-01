import { describe, it, expect } from 'vitest';
import {
  isImage, extractDocText, buildDocInstruction, buildImageInstruction, imageFileName,
  MAX_DOC_BYTES, docTooBigMsg, docBinaryMsg, docAcceptedMsg, imageAcceptedMsg, someImagesTooBigMsg,
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
    const out = buildImageInstruction({ caption: 'make it like this', fileRefs: ['reference.png'], mode: 'edit' });
    expect(out.startsWith('make it like this')).toBe(true);
    expect(out).toContain('./reference.png');
    expect(out).toContain('Read');
  });

  it('uses a create-vs-edit default lead with no caption (singular for one image)', () => {
    const create = buildImageInstruction({ fileRefs: ['reference.png'], mode: 'create' });
    const edit = buildImageInstruction({ fileRefs: ['reference.png'], mode: 'edit' });
    expect(create).toMatch(/[Bb]uild/);
    expect(edit).toMatch(/change/i);
    // Pin the SINGULAR lead so a plural-wording regression is caught.
    expect(create).toMatch(/shown in the attached image\b/);
    expect(create).not.toMatch(/attached images/);
  });

  it('lists every reference of an album and pluralises BOTH the lead and the body', () => {
    const out = buildImageInstruction({ fileRefs: ['reference1.png', 'reference2.jpg', 'reference3.png'], mode: 'create' });
    expect(out).toContain('./reference1.png');
    expect(out).toContain('./reference2.jpg');
    expect(out).toContain('./reference3.png');
    expect(out).toMatch(/3 reference images/);          // body pluralised + counted
    expect(out).toMatch(/shown in the attached images/); // LEAD pluralised (the actual branch)
    expect(out).not.toMatch(/the attached image\b/);     // never the singular lead
  });

  it('survives an empty list with a sane single-image fallback', () => {
    const out = buildImageInstruction({ fileRefs: [], mode: 'create' });
    expect(out).toContain('./reference.png');
  });
});

describe('imageFileName', () => {
  it('derives a fixed safe name from extension or MIME', () => {
    expect(imageFileName('photo.jpg', 'image/jpeg')).toBe('reference.jpg');
    expect(imageFileName(undefined, 'image/png')).toBe('reference.png');
    expect(imageFileName('mock.WEBP')).toBe('reference.webp');
    expect(imageFileName()).toBe('reference.png'); // sane default
  });

  it('suffixes album members with their 1-based index so names never collide', () => {
    expect(imageFileName('photo.jpg', 'image/jpeg', 1)).toBe('reference1.jpg');
    expect(imageFileName(undefined, 'image/png', 2)).toBe('reference2.png');
    expect(imageFileName('a.png', 'image/png', 0)).toBe('reference.png'); // 0 ⇒ no suffix (single)
  });
});

describe('copy is English and informative', () => {
  it('states the size cap and names the file', () => {
    expect(docTooBigMsg('big.md', 300 * 1024)).toContain('256');
    expect(docBinaryMsg('x.pdf')).toContain('x.pdf');
    expect(docAcceptedMsg('spec.md', 16 * 1024)).toContain('spec.md');
  });
});

describe('imageAcceptedMsg', () => {
  // With a caption, the user's text is the instruction — the ack must reflect
  // "applying your change", NOT the misleading "using it as a reference" (which
  // read as the wrong semantics for a concrete edit request).
  it('reflects the user instruction when a caption is present', () => {
    const msg = imageAcceptedMsg('botsman-landing', true);
    expect(msg).toContain('botsman-landing');
    expect(msg).toMatch(/applying your change/i);
    expect(msg).not.toMatch(/using it as a reference for/i);
  });

  it('frames the image as the reference only when there is no caption', () => {
    const msg = imageAcceptedMsg('botsman-landing', false);
    expect(msg).toMatch(/reference/i);
    expect(msg).toContain('botsman-landing');
  });

  it('pluralises and counts when an album of several images arrives', () => {
    const msg = imageAcceptedMsg('botsman-landing', false, 3);
    expect(msg).toContain('3 images');
    expect(msg).toMatch(/them/);
    expect(msg).toContain('botsman-landing');
  });
});

describe('someImagesTooBigMsg', () => {
  it('reports how many oversized images were skipped, with correct plural', () => {
    expect(someImagesTooBigMsg(1)).toMatch(/Skipped 1 image\b/);
    expect(someImagesTooBigMsg(2)).toMatch(/Skipped 2 images/);
  });
});
