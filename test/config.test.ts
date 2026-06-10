import { describe, it, expect } from 'vitest';
import { validateConfig, ConfigError } from '../src/config.js';

const valid = {
  telegramBotToken: '123456789:AAFakeTokenForTestsOnly_1234567890abc',
  ownerIds: [42],
  anthropicApiKey: 'sk-ant-test-key-for-validation-only',
  baseDomain: 'apps.example.com',
};

describe('validateConfig', () => {
  it('accepts a valid config and defaults telemetry to OFF', () => {
    const c = validateConfig(valid);
    expect(c.baseDomain).toBe('apps.example.com');
    expect(c.telemetry.enabled).toBe(false);
  });

  it('telemetry is strictly opt-in', () => {
    expect(validateConfig({ ...valid, telemetry: {} }).telemetry.enabled).toBe(false);
    expect(validateConfig({ ...valid, telemetry: { enabled: 'yes' } }).telemetry.enabled).toBe(false);
    expect(validateConfig({ ...valid, telemetry: { enabled: true } }).telemetry.enabled).toBe(true);
  });

  it('rejects bad telegram token', () => {
    expect(() => validateConfig({ ...valid, telegramBotToken: 'nope' })).toThrow(ConfigError);
  });

  it('accepts a subscription token instead of an API key', () => {
    const { anthropicApiKey, ...rest } = valid;
    const c = validateConfig({ ...rest, claudeCodeOauthToken: 'sk-ant-oat01-test-token-value' });
    expect(c.claudeCodeOauthToken).toBe('sk-ant-oat01-test-token-value');
    expect(c.anthropicApiKey).toBeUndefined();
  });

  it('requires at least one auth method', () => {
    const { anthropicApiKey, ...rest } = valid;
    expect(() => validateConfig(rest)).toThrow(/agent auth/);
  });

  it('rejects a malformed subscription token', () => {
    const { anthropicApiKey, ...rest } = valid;
    expect(() => validateConfig({ ...rest, claudeCodeOauthToken: 'sk-ant-api03-not-oauth' }))
      .toThrow(/claudeCodeOauthToken/);
  });

  it('rejects empty ownerIds', () => {
    expect(() => validateConfig({ ...valid, ownerIds: [] })).toThrow(/ownerIds/);
  });

  it('rejects bad domain', () => {
    expect(() => validateConfig({ ...valid, baseDomain: 'not a domain' })).toThrow(/baseDomain/);
  });

  it('lowercases the domain', () => {
    expect(validateConfig({ ...valid, baseDomain: 'APPS.Example.COM' }).baseDomain).toBe('apps.example.com');
  });
});
