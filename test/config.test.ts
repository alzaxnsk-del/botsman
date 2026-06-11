import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateConfig, missingSetup, saveConfig, loadConfig, updateConfigFile, ConfigError } from '../src/config.js';

const valid = {
  telegramBotToken: '123456789:AAFakeTokenForTestsOnly_1234567890abc',
  ownerIds: [42],
  anthropicApiKey: 'sk-ant-test-key-for-validation-only',
  baseDomain: 'apps.example.com',
};

describe('updateConfigFile agent.model merge', () => {
  afterEach(() => { delete process.env.BOTSMAN_HOME; });

  it('sets agent.model without dropping other agent fields (the /setup + onboarding pattern)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'botsman-cfg-'));
    process.env.BOTSMAN_HOME = home;
    try {
      saveConfig(validateConfig({ ...valid, agent: { maxTurns: 42 } }));
      const cfg = loadConfig();
      const updated = updateConfigFile({ agent: { ...cfg.agent, model: 'opus' } });
      expect(updated.agent?.model).toBe('opus');
      expect(updated.agent?.maxTurns).toBe(42); // preserved
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

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

  it('accepts a bootstrap config (token + owner only) — onboarding fills the rest', () => {
    const c = validateConfig({
      telegramBotToken: valid.telegramBotToken,
      ownerIds: valid.ownerIds,
    });
    expect(missingSetup(c)).toEqual(['auth', 'domain']);
  });

  it('missingSetup is empty for a complete config', () => {
    expect(missingSetup(validateConfig(valid))).toEqual([]);
  });

  it('missingSetup reports only the absent piece', () => {
    const { anthropicApiKey, ...noAuth } = valid;
    expect(missingSetup(validateConfig(noAuth))).toEqual(['auth']);
    const { baseDomain, ...noDomain } = valid;
    expect(missingSetup(validateConfig(noDomain))).toEqual(['domain']);
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
