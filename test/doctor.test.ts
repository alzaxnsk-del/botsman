import { describe, it, expect } from 'vitest';
import { isCloudflareIp, classifyPublicError } from '../src/doctor.js';

describe('isCloudflareIp', () => {
  it('detects addresses in Cloudflare ranges', () => {
    expect(isCloudflareIp('104.21.32.1')).toBe(true);   // 104.16.0.0/13
    expect(isCloudflareIp('172.67.10.2')).toBe(true);   // 172.64.0.0/13
    expect(isCloudflareIp('188.114.96.7')).toBe(true);  // 188.114.96.0/20
    expect(isCloudflareIp('162.159.1.1')).toBe(true);   // 162.158.0.0/15
  });

  it('passes ordinary VPS addresses through', () => {
    expect(isCloudflareIp('13.140.167.93')).toBe(false);
    expect(isCloudflareIp('95.217.1.1')).toBe(false);
    expect(isCloudflareIp('203.0.113.10')).toBe(false);
  });

  it('rejects garbage', () => {
    expect(isCloudflareIp('not-an-ip')).toBe(false);
    expect(isCloudflareIp('::1')).toBe(false);
  });
});

describe('classifyPublicError', () => {
  it('classifies TLS problems', () => {
    expect(classifyPublicError('tlsv1 alert internal error')).toBe('tls');
    expect(classifyPublicError('unable to verify the first certificate')).toBe('tls');
    expect(classifyPublicError('SSL routines:ST_CONNECT failed')).toBe('tls');
  });

  it('classifies connectivity problems', () => {
    expect(classifyPublicError('connect ECONNREFUSED 1.2.3.4:443')).toBe('unreachable');
    expect(classifyPublicError('The operation timed out')).toBe('unreachable');
    expect(classifyPublicError('getaddrinfo ENOTFOUND x.example.com')).toBe('unreachable');
  });

  it('falls back to other', () => {
    expect(classifyPublicError('weird thing happened')).toBe('other');
  });
});
