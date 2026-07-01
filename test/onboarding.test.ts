import { describe, it, expect } from 'vitest';
import { nextOnboardingStep } from '../src/gateway/onboarding.js';

describe('nextOnboardingStep', () => {
  it('first run walks the full wizard: auth → domain → telemetry → finalize', () => {
    // auth+domain missing → auth first
    expect(nextOnboardingStep({ missing: ['auth', 'domain'], reconfig: false, telemetryAsked: false })).toBe('auth');
    // auth done, domain missing → domain
    expect(nextOnboardingStep({ missing: ['domain'], reconfig: false, telemetryAsked: false })).toBe('domain');
    // nothing missing, telemetry not yet asked → telemetry
    expect(nextOnboardingStep({ missing: [], reconfig: false, telemetryAsked: false })).toBe('telemetry');
    // telemetry asked → finalize
    expect(nextOnboardingStep({ missing: [], reconfig: false, telemetryAsked: true })).toBe('finalize');
  });

  it('a /setup reconfig only asks the changed field, then finalizes (no telemetry re-ask)', () => {
    // reconfig of auth only → ask auth, then finalize (NOT telemetry)
    expect(nextOnboardingStep({ missing: ['auth'], reconfig: true, telemetryAsked: false })).toBe('auth');
    expect(nextOnboardingStep({ missing: [], reconfig: true, telemetryAsked: false })).toBe('finalize');
    // reconfig of domain only → ask domain, then finalize
    expect(nextOnboardingStep({ missing: ['domain'], reconfig: true, telemetryAsked: false })).toBe('domain');
    // reconfig of BOTH (e.g. tapped auth then domain) → auth first, then domain, then finalize
    expect(nextOnboardingStep({ missing: ['auth', 'domain'], reconfig: true, telemetryAsked: false })).toBe('auth');
    expect(nextOnboardingStep({ missing: ['domain'], reconfig: true, telemetryAsked: false })).toBe('domain');
  });

  it('reconfig never shows the telemetry step regardless of telemetryAsked', () => {
    expect(nextOnboardingStep({ missing: [], reconfig: true, telemetryAsked: false })).toBe('finalize');
    expect(nextOnboardingStep({ missing: [], reconfig: true, telemetryAsked: true })).toBe('finalize');
  });
});
