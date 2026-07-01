import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateConfig, missingSetup, saveConfig, loadConfig, updateConfigFile, mergeSetupBackup, restoreSetupBackupPatch, updateCheckEnabled, ConfigError } from '../src/config.js';

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

  it('persists the transcription key through save/load and a later updateConfigFile', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'botsman-cfg-'));
    process.env.BOTSMAN_HOME = home;
    try {
      // /setup → 🎤 Voice writes the key; it must survive the field-by-field
      // validateConfig rebuild on every subsequent rewrite.
      updateConfigFile({ ...valid, transcription: { apiKey: 'gsk_secret' } });
      expect(loadConfig().transcription?.apiKey).toBe('gsk_secret');
      // An UNRELATED later change (e.g. model) must not drop the key.
      const after = updateConfigFile({ agent: { model: 'opus' } });
      expect(after.transcription?.apiKey).toBe('gsk_secret');
      expect(loadConfig().transcription?.apiKey).toBe('gsk_secret');
      // setup:voiceoff clears it.
      const off = updateConfigFile({ transcription: undefined });
      expect(off.transcription).toBeUndefined();
      expect(loadConfig().transcription).toBeUndefined();
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

describe('mergeSetupBackup', () => {
  it('starts a fresh backup from nothing', () => {
    expect(JSON.parse(mergeSetupBackup(null, { baseDomain: 'apps.example.com' })))
      .toEqual({ baseDomain: 'apps.example.com' });
    expect(JSON.parse(mergeSetupBackup('', { anthropicApiKey: 'sk-ant-x' })))
      .toEqual({ anthropicApiKey: 'sk-ant-x' });
  });

  it('accumulates a second field (tap auth then domain — both are preserved)', () => {
    const afterAuth = mergeSetupBackup(null, { claudeCodeOauthToken: 'sk-ant-oat-x', anthropicApiKey: undefined });
    const afterBoth = mergeSetupBackup(afterAuth, { baseDomain: 'apps.example.com' });
    expect(JSON.parse(afterBoth)).toEqual({ claudeCodeOauthToken: 'sk-ant-oat-x', baseDomain: 'apps.example.com' });
  });

  it('first capture wins — re-tapping the same item cannot overwrite the real value with undefined', () => {
    const first = mergeSetupBackup(null, { anthropicApiKey: 'sk-ant-real' });
    // second tap sees auth already cleared in config → would pass undefined
    const second = mergeSetupBackup(first, { anthropicApiKey: undefined, claudeCodeOauthToken: undefined });
    expect(JSON.parse(second)).toEqual({ anthropicApiKey: 'sk-ant-real' });
  });

  it('treats a corrupt existing backup as empty rather than throwing', () => {
    expect(JSON.parse(mergeSetupBackup('{not json', { baseDomain: 'x.com' }))).toEqual({ baseDomain: 'x.com' });
  });
});

describe('restoreSetupBackupPatch', () => {
  it('re-adds the missing half of the auth pair as an explicit undefined', () => {
    const fromApi = restoreSetupBackupPatch(JSON.stringify({ anthropicApiKey: 'k' }))!;
    expect(fromApi.anthropicApiKey).toBe('k');
    expect('claudeCodeOauthToken' in fromApi).toBe(true); // present so updateConfigFile deletes it
    expect(fromApi.claudeCodeOauthToken).toBeUndefined();

    const fromOauth = restoreSetupBackupPatch(JSON.stringify({ claudeCodeOauthToken: 't' }))!;
    expect(fromOauth.claudeCodeOauthToken).toBe('t');
    expect('anthropicApiKey' in fromOauth).toBe(true);
    expect(fromOauth.anthropicApiKey).toBeUndefined();
  });

  it('leaves a domain-only backup untouched (no auth keys injected)', () => {
    const p = restoreSetupBackupPatch(JSON.stringify({ baseDomain: 'apps.example.com' }))!;
    expect(p).toEqual({ baseDomain: 'apps.example.com' });
    expect('anthropicApiKey' in p).toBe(false);
    expect('claudeCodeOauthToken' in p).toBe(false);
  });

  it('returns null for a missing or corrupt blob', () => {
    expect(restoreSetupBackupPatch(null)).toBeNull();
    expect(restoreSetupBackupPatch('')).toBeNull();
    expect(restoreSetupBackupPatch('{bad json')).toBeNull();
  });

  it('cancel restores previous auth even after the user switched method — never leaves BOTH set', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'botsman-cfg-'));
    process.env.BOTSMAN_HOME = home;
    try {
      // Start: API key + domain (a server already in use).
      updateConfigFile({ ...valid });
      // /setup → auth backs up the CURRENT auth (API key; oauth is undefined → dropped by JSON).
      const backup = mergeSetupBackup(null, {
        anthropicApiKey: loadConfig().anthropicApiKey,
        claudeCodeOauthToken: loadConfig().claudeCodeOauthToken,
      });
      updateConfigFile({ anthropicApiKey: undefined, claudeCodeOauthToken: undefined });
      // User SWITCHES to a new subscription token…
      updateConfigFile({ claudeCodeOauthToken: 'sk-ant-oat01-switched-in-token', anthropicApiKey: undefined });
      // …then taps /cancel (reachable on the domain step of a combined reconfig).
      updateConfigFile(restoreSetupBackupPatch(backup)!);
      const restored = loadConfig();
      expect(restored.anthropicApiKey).toBe(valid.anthropicApiKey); // previous key is back
      expect(restored.claudeCodeOauthToken).toBeUndefined();        // switched-in token is gone (not both set)
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('updateCheck (auto update-check config)', () => {
  afterEach(() => { delete process.env.BOTSMAN_HOME; });

  it('defaults ON, and OFF only when explicitly disabled', () => {
    expect(updateCheckEnabled(validateConfig(valid))).toBe(true);              // absent → ON
    expect(updateCheckEnabled(validateConfig({ ...valid, updateCheck: {} }))).toBe(true); // {} → ON
    expect(updateCheckEnabled(validateConfig({ ...valid, updateCheck: { enabled: false } }))).toBe(false);
    expect(updateCheckEnabled(validateConfig({ ...valid, updateCheck: { enabled: true } }))).toBe(true);
  });

  it('validateConfig keeps updateCheck in its rebuilt object (not dropped)', () => {
    expect(validateConfig({ ...valid, updateCheck: { enabled: false } }).updateCheck).toEqual({ enabled: false });
  });

  it('the OFF toggle survives an unrelated later updateConfigFile write', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'botsman-cfg-'));
    process.env.BOTSMAN_HOME = home;
    try {
      // /setup → 🔔 turns alerts OFF…
      updateConfigFile({ ...valid, updateCheck: { enabled: false } });
      expect(updateCheckEnabled(loadConfig())).toBe(false);
      // …an UNRELATED change (e.g. model) must not silently re-enable it.
      updateConfigFile({ agent: { model: 'opus' } });
      expect(loadConfig().updateCheck).toEqual({ enabled: false });
      expect(updateCheckEnabled(loadConfig())).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
