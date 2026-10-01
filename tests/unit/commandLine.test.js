'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');

const electronPath = require.resolve('electron');
const commandLinePath = require.resolve('../../app/startup/commandLine');

const originalElectron = require.cache[electronPath];
const originalPlatform = process.platform;
const originalArch = process.arch;
const originalFlatpakId = process.env.FLATPAK_ID;
const FLATPAK_ID = 'com.github.IsmaelMartinez.teams_for_linux';

function restoreProcessStubs() {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  Object.defineProperty(process, 'arch', { value: originalArch, configurable: true });
  if (originalFlatpakId === undefined) {
    delete process.env.FLATPAK_ID;
  } else {
    process.env.FLATPAK_ID = originalFlatpakId;
  }
  if (originalElectron) {
    require.cache[electronPath] = originalElectron;
  } else {
    delete require.cache[electronPath];
  }
  delete require.cache[commandLinePath];
}

afterEach(() => {
  restoreProcessStubs();
});

// Stateful stand-in for Electron's command-line map: appendSwitch replaces the
// value of a switch, and hasSwitch/getSwitchValue read that map back.
function installCommandLine({ platform = 'darwin', arch = 'x64', switches = {} } = {}) {
  const values = new Map(Object.entries(switches));
  const appended = [];
  const app = {
    commandLine: {
      appendSwitch: (name, value) => {
        appended.push([name, value]);
        values.set(name, value === undefined ? '' : String(value));
      },
      hasSwitch: (name) => values.has(name),
      getSwitchValue: (name) => (values.has(name) ? values.get(name) : ''),
    },
    setName: () => {},
    setDesktopName: () => {},
    disableHardwareAcceleration: () => {},
  };

  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: { app },
  };
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  Object.defineProperty(process, 'arch', { value: arch, configurable: true });
  delete require.cache[commandLinePath];

  const CommandLineManager = require(commandLinePath);
  return { CommandLineManager, appended, values };
}

// Run CommandLineManager.addSwitchesAfterConfigLoad under a mocked Electron
// `app.commandLine`, forced platform and arch, returning the list of switches
// the manager appended as [name, value] pairs.
function appendedSwitches(config, platform = 'darwin', arch = 'arm64') {
  const { CommandLineManager, appended } = installCommandLine({ platform, arch });
  CommandLineManager.addSwitchesAfterConfigLoad(config);
  return appended;
}

function hasSwitch(switches, name) {
  return switches.some(([n]) => n === name);
}

function switchValue(switches, name) {
  const found = switches.find(([n]) => n === name);
  return found ? found[1] : undefined;
}

function featureTokens(values) {
  return (values.get('disable-features') || '')
    .split(',')
    .filter((feature) => feature.trim() !== '');
}

function countFeature(values, name) {
  return featureTokens(values).filter((feature) => feature.trim() === name).length;
}

function applyFlatpakId(flatpakId) {
  if (flatpakId === undefined) {
    delete process.env.FLATPAK_ID;
  } else {
    process.env.FLATPAK_ID = flatpakId;
  }
}

// Production order: switches that must exist before config load, then the
// post-config pass that applies electronCLIFlags and the Flatpak workaround.
function runProductionStartup({
  platform,
  arch = 'x64',
  config = { authServerWhitelist: '*' },
  switches,
  flatpakId,
} = {}) {
  applyFlatpakId(flatpakId);
  const ctx = installCommandLine({ platform, arch, switches });
  ctx.CommandLineManager.addSwitchesBeforeConfigLoad();
  ctx.CommandLineManager.addSwitchesAfterConfigLoad(config);
  return ctx;
}

function captureWarn(fn) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    return { warnings, result: fn() };
  } finally {
    console.warn = originalWarn;
  }
}

describe('CommandLineManager macOS performance gate', () => {
  it('applies the Metal/GPU switches on macOS by default', () => {
    const switches = appendedSwitches({ authServerWhitelist: '*' });
    assert.deepStrictEqual(
      switches.find(([n]) => n === 'use-angle'),
      ['use-angle', 'metal'],
      'forces ANGLE Metal by default',
    );
    assert.ok(hasSwitch(switches, 'enable-gpu-rasterization'));
    assert.ok(hasSwitch(switches, 'enable-webrtc-hw-encoding'));
  });

  it('applies the larger V8 heap only on arm64', () => {
    const arm = switchValue(appendedSwitches({ authServerWhitelist: '*' }, 'darwin', 'arm64'), 'js-flags');
    assert.match(arm, /--max-old-space-size=4096/, 'arm64 gets the larger heap');
    assert.match(arm, /--concurrent-marking/, 'arm64 still gets the concurrency flags');

    const intel = switchValue(appendedSwitches({ authServerWhitelist: '*' }, 'darwin', 'x64'), 'js-flags');
    assert.doesNotMatch(intel, /--max-old-space-size/, 'Intel does not get the larger heap');
    assert.doesNotMatch(intel, /--max-semi-space-size/, 'Intel does not get the semi-space bump');
    assert.match(intel, /--concurrent-marking/, 'Intel still gets the concurrency flags');
  });

  it('skips the switches when media.macPerformanceMode is false', () => {
    const switches = appendedSwitches({
      authServerWhitelist: '*',
      media: { macPerformanceMode: false },
    });
    assert.ok(!hasSwitch(switches, 'use-angle'), 'no ANGLE Metal switch');
    assert.ok(!hasSwitch(switches, 'enable-gpu-rasterization'), 'no rasterization switch');
    assert.ok(!hasSwitch(switches, 'enable-webrtc-hw-encoding'), 'no HW WebRTC switch');
  });

  it('still applies the switches when media.macPerformanceMode is explicitly true', () => {
    const switches = appendedSwitches({
      authServerWhitelist: '*',
      media: { macPerformanceMode: true },
    });
    assert.ok(hasSwitch(switches, 'use-angle'));
  });

  it('disableGpu short-circuits the perf switches even with the flag on', () => {
    const switches = appendedSwitches({
      authServerWhitelist: '*',
      disableGpu: true,
      media: { macPerformanceMode: true },
    });
    assert.ok(!hasSwitch(switches, 'use-angle'), 'perf switches suppressed when GPU is disabled');
    assert.ok(hasSwitch(switches, 'disable-gpu'), 'disable-gpu still applied');
  });

  it('does not apply the macOS switches on non-darwin platforms', () => {
    const switches = appendedSwitches({ authServerWhitelist: '*' }, 'linux');
    assert.ok(!hasSwitch(switches, 'use-angle'), 'mac perf path not taken off macOS');
  });
});

describe('CommandLineManager Flatpak system theme workaround', () => {
  it('adds HardwareMediaKeyHandling and one UsePortalAccentColor on Linux Flatpak', () => {
    const { warnings, result } = captureWarn(() => runProductionStartup({
      platform: 'linux',
      flatpakId: FLATPAK_ID,
    }));
    assert.deepStrictEqual(featureTokens(result.values), [
      'HardwareMediaKeyHandling',
      'UsePortalAccentColor',
    ]);
    assert.strictEqual(countFeature(result.values, 'UsePortalAccentColor'), 1);
    assert.deepStrictEqual(warnings, []);
  });

  it('preserves an explicit disable-features list that omits HardwareMediaKeyHandling', () => {
    const { warnings, result } = captureWarn(() => runProductionStartup({
      platform: 'linux',
      flatpakId: FLATPAK_ID,
      switches: { 'disable-features': 'CustomFeature,AnotherFeature' },
    }));
    assert.strictEqual(
      result.values.get('disable-features'),
      'CustomFeature,AnotherFeature,UsePortalAccentColor',
    );
    assert.strictEqual(countFeature(result.values, 'HardwareMediaKeyHandling'), 0);
    assert.strictEqual(countFeature(result.values, 'UsePortalAccentColor'), 1);
    assert.ok(warnings.some((warning) => warning.includes('HardwareMediaKeyHandling')));
  });

  it('merges electronCLIFlags disable-features without losing the workaround or unrelated switches', () => {
    const config = {
      authServerWhitelist: 'contoso.com',
      electronCLIFlags: [
        ['disable-features', 'EarlierFlag'],
        ['proxy-bypass-list', 'localhost'],
        'ignore-certificate-errors',
        ['disable-features', 'FromConfig,AnotherFeature'],
      ],
    };
    const { result } = captureWarn(() => runProductionStartup({
      platform: 'linux',
      flatpakId: FLATPAK_ID,
      config,
    }));
    assert.strictEqual(
      result.values.get('disable-features'),
      'FromConfig,AnotherFeature,UsePortalAccentColor',
    );
    assert.strictEqual(countFeature(result.values, 'UsePortalAccentColor'), 1);
    assert.strictEqual(countFeature(result.values, 'HardwareMediaKeyHandling'), 0);
    assert.strictEqual(result.values.get('proxy-bypass-list'), 'localhost');
    assert.strictEqual(result.values.get('ignore-certificate-errors'), '');
    assert.strictEqual(result.values.get('auth-server-whitelist'), 'contoso.com');
  });

  it('does not duplicate UsePortalAccentColor already present in electronCLIFlags', () => {
    const config = {
      authServerWhitelist: '*',
      electronCLIFlags: [['disable-features', 'FromConfig,UsePortalAccentColor,Tail']],
    };
    const ctx = runProductionStartup({
      platform: 'linux',
      flatpakId: FLATPAK_ID,
      config,
    });
    ctx.CommandLineManager.addSwitchesAfterConfigLoad(config);
    assert.strictEqual(
      ctx.values.get('disable-features'),
      'FromConfig,UsePortalAccentColor,Tail',
    );
    assert.strictEqual(countFeature(ctx.values, 'UsePortalAccentColor'), 1);
  });

  it('keeps a single pre-existing UsePortalAccentColor token', () => {
    const { result } = captureWarn(() => runProductionStartup({
      platform: 'linux',
      flatpakId: FLATPAK_ID,
      switches: { 'disable-features': 'Foo, UsePortalAccentColor ,Bar' },
    }));
    assert.strictEqual(
      result.values.get('disable-features'),
      'Foo, UsePortalAccentColor ,Bar',
    );
    assert.strictEqual(countFeature(result.values, 'UsePortalAccentColor'), 1);
  });

  it('turns an empty disable-features value into UsePortalAccentColor without a leading comma', () => {
    const { warnings, result } = captureWarn(() => runProductionStartup({
      platform: 'linux',
      flatpakId: FLATPAK_ID,
      switches: { 'disable-features': '' },
    }));
    assert.strictEqual(result.values.get('disable-features'), 'UsePortalAccentColor');
    assert.ok(!String(result.values.get('disable-features')).startsWith(','));
    assert.strictEqual(countFeature(result.values, 'UsePortalAccentColor'), 1);
    assert.ok(warnings.some((warning) => warning.includes('HardwareMediaKeyHandling')));
  });

  it('drops empty comma slots when appending the workaround', () => {
    const { result } = captureWarn(() => runProductionStartup({
      platform: 'linux',
      flatpakId: FLATPAK_ID,
      switches: { 'disable-features': ',Foo,,' },
    }));
    assert.strictEqual(result.values.get('disable-features'), 'Foo,UsePortalAccentColor');
    assert.strictEqual(countFeature(result.values, 'UsePortalAccentColor'), 1);
  });

  it('appends the workaround when electronCLIFlags clears disable-features', () => {
    const ctx = runProductionStartup({
      platform: 'linux',
      flatpakId: FLATPAK_ID,
      config: {
        authServerWhitelist: '*',
        electronCLIFlags: [['disable-features', '']],
      },
    });
    assert.strictEqual(ctx.values.get('disable-features'), 'UsePortalAccentColor');
    assert.ok(!ctx.values.get('disable-features').startsWith(','));
  });

  it('stays idempotent when both startup phases run more than once', () => {
    const config = { authServerWhitelist: '*' };
    const ctx = runProductionStartup({
      platform: 'linux',
      flatpakId: FLATPAK_ID,
      config,
    });
    ctx.CommandLineManager.addSwitchesBeforeConfigLoad();
    ctx.CommandLineManager.addSwitchesAfterConfigLoad(config);
    ctx.CommandLineManager.addSwitchesAfterConfigLoad(config);
    assert.deepStrictEqual(featureTokens(ctx.values), [
      'HardwareMediaKeyHandling',
      'UsePortalAccentColor',
    ]);
  });

  it('leaves Linux startup unchanged when FLATPAK_ID is unset', () => {
    const ctx = runProductionStartup({
      platform: 'linux',
      config: {
        authServerWhitelist: '*',
        electronCLIFlags: [['disable-features', 'OnlyThis']],
      },
    });
    assert.strictEqual(ctx.values.get('disable-features'), 'OnlyThis');
    assert.strictEqual(countFeature(ctx.values, 'UsePortalAccentColor'), 0);
  });

  it('leaves Linux startup unchanged when FLATPAK_ID is empty', () => {
    const ctx = runProductionStartup({
      platform: 'linux',
      flatpakId: '',
    });
    assert.strictEqual(ctx.values.get('disable-features'), 'HardwareMediaKeyHandling');
    assert.strictEqual(countFeature(ctx.values, 'UsePortalAccentColor'), 0);
  });

  it('does not add UsePortalAccentColor on macOS even with FLATPAK_ID set', () => {
    const ctx = runProductionStartup({
      platform: 'darwin',
      arch: 'arm64',
      flatpakId: FLATPAK_ID,
    });
    assert.strictEqual(ctx.values.get('disable-features'), 'HardwareMediaKeyHandling');
    assert.strictEqual(countFeature(ctx.values, 'UsePortalAccentColor'), 0);
    assert.strictEqual(ctx.values.get('use-angle'), 'metal');
  });

  it('does not add UsePortalAccentColor on Windows even with FLATPAK_ID set', () => {
    const ctx = runProductionStartup({
      platform: 'win32',
      flatpakId: FLATPAK_ID,
    });
    assert.strictEqual(ctx.values.get('disable-features'), 'HardwareMediaKeyHandling');
    assert.strictEqual(countFeature(ctx.values, 'UsePortalAccentColor'), 0);
  });
});
