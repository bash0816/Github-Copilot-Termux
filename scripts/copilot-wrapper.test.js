'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const WRAPPER_SRC = path.resolve(__dirname, '..', 'packages', 'copilot-termux', 'bin', 'copilot');
const SH = execFileSync('sh', ['-c', 'command -v sh'], { encoding: 'utf8' }).trim();

// Writes an executable #!/bin/sh dummy that records its environment and args.
function writeDummy(file, marker, ranFile, argsFile) {
  const lines = ['#!/bin/sh'];
  if (argsFile) {
    lines.push(`printf '%s\\n' "$@" > '${argsFile}'`);
  }
  lines.push(`echo "${marker} COPILOT_AUTO_UPDATE=$COPILOT_AUTO_UPDATE ARGS=$*" >> '${ranFile}'`);
  lines.push('echo DUMMY-RAN', 'exit 0', '');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n'));
  fs.chmodSync(file, 0o755);
}

function makeFixture(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-wrapper-'));
  const pkg = path.join(root, 'pkg');
  const home = path.join(root, 'home');
  const prefix = path.join(root, 'prefix');
  const ranFile = path.join(root, 'ran.txt');
  const argsFile = path.join(root, 'args.txt');
  const version = opts.version ?? '9.9.9';

  const wrapper = path.join(pkg, 'bin', 'copilot');
  fs.mkdirSync(path.dirname(wrapper), { recursive: true });
  fs.copyFileSync(WRAPPER_SRC, wrapper);
  fs.chmodSync(wrapper, 0o755);

  fs.mkdirSync(path.join(pkg, 'config'), { recursive: true });
  const manifest = opts.manifest ?? JSON.stringify({ copilot: { version: '9.9.9' } }, null, 2);
  fs.writeFileSync(path.join(pkg, 'config', 'manifest.json'), manifest);

  fs.mkdirSync(path.join(pkg, 'lib'), { recursive: true });
  fs.writeFileSync(
    path.join(pkg, 'lib', 'check-updates.js'),
    "process.stdout.write('UPDATE-BRANCH ' + process.argv.slice(2).join(' ') + '\\n');\n",
  );

  const verDir = path.join(home, '.copilot-termux', version);
  if (opts.dirOnly) {
    fs.mkdirSync(verDir, { recursive: true });
  } else if (!opts.noBinary) {
    writeDummy(path.join(verDir, 'copilot'), 'RAN', ranFile, opts.argsDump ? argsFile : null);
  }

  const loader = path.join(prefix, 'glibc', 'lib', 'ld-linux-aarch64.so.1');
  fs.mkdirSync(path.dirname(loader), { recursive: true });
  fs.writeFileSync(loader, '#!/bin/sh\nshift 2\nexec "$@"\n');
  fs.chmodSync(loader, 0o755);

  fs.mkdirSync(path.join(prefix, 'etc', 'tls'), { recursive: true });
  fs.writeFileSync(path.join(prefix, 'etc', 'tls', 'cert.pem'), 'dummy-ca\n');

  return {
    root,
    pkg,
    wrapper,
    home,
    prefix,
    ranFile,
    argsFile,
    loader,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function runWrapper(fx, args, extraEnv = {}) {
  const env = { ...process.env, HOME: fx.home, PREFIX: fx.prefix };
  delete env.COPILOT_AUTO_UPDATE;
  Object.assign(env, extraEnv);
  return spawnSync(SH, [fx.wrapper, ...args], { encoding: 'utf8', env });
}

function readRan(fx) {
  return fs.existsSync(fx.ranFile) ? fs.readFileSync(fx.ranFile, 'utf8') : null;
}

test('normal run executes the manifest-pinned binary', () => {
  const fx = makeFixture();
  try {
    const r = runWrapper(fx, ['--version']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /DUMMY-RAN/);
    assert.match(readRan(fx), /ARGS=--version/);
  } finally {
    fx.cleanup();
  }
});

test('arguments are passed through unchanged', () => {
  const fx = makeFixture({ argsDump: true });
  try {
    let r = runWrapper(fx, ['a', 'b']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(fx.argsFile, 'utf8'), 'a\nb\n');

    r = runWrapper(fx, ['a b', '--x=1']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(fx.argsFile, 'utf8'), 'a b\n--x=1\n');
  } finally {
    fx.cleanup();
  }
});

test('COPILOT_AUTO_UPDATE=false reaches the child', () => {
  const cases = [
    ['caller sets true', { COPILOT_AUTO_UPDATE: 'true' }],
    ['caller leaves it unset', {}],
  ];
  for (const [label, extraEnv] of cases) {
    const fx = makeFixture();
    try {
      const r = runWrapper(fx, ['--version'], extraEnv);
      assert.equal(r.status, 0, `${label}: ${r.stderr}`);
      assert.match(readRan(fx), /COPILOT_AUTO_UPDATE=false/, label);
    } finally {
      fx.cleanup();
    }
  }
});

test('prerelease version is resolved from the manifest', () => {
  const fx = makeFixture({
    version: '1.0.108-1',
    manifest: JSON.stringify({ copilot: { version: '1.0.108-1' } }),
  });
  try {
    const r = runWrapper(fx, ['--version']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(readRan(fx), /ARGS=--version/);
  } finally {
    fx.cleanup();
  }
});

test('current symlink does not affect the chosen version', () => {
  const fx = makeFixture();
  try {
    const oldDir = path.join(fx.home, '.copilot-termux', '1.0.1');
    writeDummy(path.join(oldDir, 'copilot'), 'OLD-RAN', fx.ranFile, null);
    fs.symlinkSync('1.0.1', path.join(fx.home, '.copilot-termux', 'current'));

    const r = runWrapper(fx, ['--version']);
    assert.equal(r.status, 0, r.stderr);
    const ran = readRan(fx);
    assert.match(ran, /^RAN /m);
    assert.doesNotMatch(ran, /OLD-RAN/);
  } finally {
    fx.cleanup();
  }
});

test('update subcommand is forwarded to check-updates as "update <args>" and does not run copilot', () => {
  const fx = makeFixture();
  try {
    const r = runWrapper(fx, ['update', '--dry-run']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'UPDATE-BRANCH update --dry-run\n');
    assert.equal(readRan(fx), null);
  } finally {
    fx.cleanup();
  }
});

test('invalid manifests are rejected as a broken package', async (t) => {
  const cases = [
    { name: '{', manifest: '{' },
    { name: '{"x":1}', manifest: '{"x":1}' },
    { name: '{"version":"1.0.105"}', manifest: '{"version":"1.0.105"}' },
    { name: '{"copilot":{"version":123}}', manifest: '{"copilot":{"version":123}}' },
    { name: 'empty string', manifest: '' },
    ...['1..2', '../x', '1.2.3-..', '1.2.3-', '1.2.3-a..b', '1.2'].map((v) => ({
      name: `version ${JSON.stringify(v)}`,
      manifest: JSON.stringify({ copilot: { version: v } }),
    })),
  ];

  for (const c of cases) {
    await t.test(c.name, () => {
      const fx = makeFixture({ manifest: c.manifest });
      try {
        // Decoy binary that must never run for a broken manifest.
        writeDummy(path.join(fx.home, '.copilot-termux', '1.0.105', 'copilot'), 'RAN', fx.ranFile, null);
        const r = runWrapper(fx, ['--version']);
        assert.equal(r.status, 1, r.stderr);
        assert.ok(r.stderr.includes('Broken package'), r.stderr);
        assert.equal(readRan(fx), null);
      } finally {
        fx.cleanup();
      }
    });
  }
});

test('missing version directory is reported as not set up', async (t) => {
  await t.test('directory and binary absent', () => {
    const fx = makeFixture({ noBinary: true });
    try {
      const r = runWrapper(fx, ['--version']);
      assert.equal(r.status, 1, r.stderr);
      assert.ok(
        r.stderr.includes('copilot 9.9.9 is not set up. Run: copilot-termux setup'),
        r.stderr,
      );
      assert.equal(readRan(fx), null);
    } finally {
      fx.cleanup();
    }
  });

  await t.test('only the directory exists', () => {
    const fx = makeFixture({ dirOnly: true });
    try {
      const r = runWrapper(fx, ['--version']);
      assert.equal(r.status, 1, r.stderr);
      assert.ok(
        r.stderr.includes('copilot 9.9.9 is not set up. Run: copilot-termux setup'),
        r.stderr,
      );
      assert.equal(readRan(fx), null);
    } finally {
      fx.cleanup();
    }
  });
});

test('missing node is reported', () => {
  const fx = makeFixture();
  const bin = path.join(fx.root, 'bin');
  try {
    // Expose only the external commands the wrapper uses before its node check.
    fs.mkdirSync(bin);
    for (const cmd of ['dirname', 'readlink', 'env']) {
      const found = execFileSync(SH, ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).trim();
      fs.symlinkSync(found, path.join(bin, cmd));
    }
    assert.equal(fs.existsSync(path.join(bin, 'node')), false);

    const r = runWrapper(fx, ['--version'], { PATH: bin });
    assert.equal(r.status, 1, r.stderr);
    assert.ok(r.stderr.includes('node not found'), r.stderr);
    assert.equal(readRan(fx), null);
  } finally {
    fx.cleanup();
  }
});

test('missing glibc loader is reported', () => {
  const fx = makeFixture();
  try {
    fs.rmSync(fx.loader);
    const r = runWrapper(fx, ['--version']);
    assert.equal(r.status, 1, r.stderr);
    assert.ok(r.stderr.includes('glibc not found'), r.stderr);
    assert.equal(readRan(fx), null);
  } finally {
    fx.cleanup();
  }
});
