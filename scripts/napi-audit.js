'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

function uniqueSorted(values) {
  return Array.from(new Set(values)).sort();
}

function loadKnownSet(config) {
  const known = new Set();
  for (const value of config.tokio_noop_prefixes || []) known.add(value);
  for (const value of config.behavioral_stubs || []) known.add(value);
  for (const value of config.git_async_stubs || []) known.add(value);
  for (const value of config.stream_pipeline_risk || []) known.add(value);
  return known;
}

function classifyCandidates(candidates, config) {
  const known = loadKnownSet(config);
  const tokioPrefixes = Array.isArray(config.tokio_noop_prefixes) ? config.tokio_noop_prefixes : [];
  const newTokio = [];
  const newGitAsync = [];
  const newUnknown = [];

  for (const candidate of candidates) {
    if (known.has(candidate)) continue;
    if (tokioPrefixes.some((prefix) => candidate.startsWith(prefix))) {
      newTokio.push(candidate);
      continue;
    }
    if (/^git[A-Z].*Async$/.test(candidate)) {
      newGitAsync.push(candidate);
      continue;
    }
    if (candidate.length >= 15) {
      newUnknown.push(candidate);
    }
  }

  return {
    newTokio: uniqueSorted(newTokio),
    newGitAsync: uniqueSorted(newGitAsync),
    newUnknown: uniqueSorted(newUnknown),
  };
}

function extractCandidates(runtimePath) {
  const cmd = `strings -n 8 ${shellQuote(runtimePath)}`;
  const output = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const seen = new Set();
  for (const line of output.split(/\r?\n/)) {
    const candidate = line.trim();
    if (/^[a-z][a-zA-Z0-9]{7,}$/.test(candidate)) seen.add(candidate);
  }
  return Array.from(seen).sort();
}

function patchTokioPattern(platformPatchPath, additions) {
  if (!additions.length) return false;
  const original = fs.readFileSync(platformPatchPath, 'utf8');
  const lineMatch = original.match(/^(\s*const TOKIO_PATTERN = \/\^\()([^)]*)(\)\/;)\s*$/m);
  if (!lineMatch) {
    console.warn('[napi-audit] WARN: TOKIO_PATTERN line not found or not single-line; skipping platform patch update.');
    return false;
  }
  const currentPrefixes = lineMatch[2].split('|').filter(Boolean);
  const merged = uniqueSorted([...currentPrefixes, ...additions]);
  const updatedLine = `${lineMatch[1]}${merged.join('|')}${lineMatch[3]}`;
  const updated = original.replace(lineMatch[0], updatedLine);
  if (updated !== original) fs.writeFileSync(platformPatchPath, updated);
  return updated !== original;
}

function patchGitAsyncStubs(platformPatchPath, additions) {
  if (!additions.length) return false;
  const original = fs.readFileSync(platformPatchPath, 'utf8');
  const objectMatch = original.match(/const GIT_ASYNC_STUBS = \{[\s\S]*?\n\s*\};/m);
  if (!objectMatch) {
    console.warn('[napi-audit] WARN: GIT_ASYNC_STUBS object not found; skipping platform patch update.');
    return false;
  }
  const objectText = objectMatch[0];
  const insertion = additions.map((name) => `      ${name}: async () => null,`).join('\n') + '\n';
  const updatedObject = objectText.replace(/\n\s*\};$/, `\n${insertion}    };`);
  const updated = original.replace(objectText, updatedObject);
  if (updated !== original) fs.writeFileSync(platformPatchPath, updated);
  return updated !== original;
}

function updateKnownExportsConfig(configPath, updates) {
  const config = readJson(configPath);
  let changed = false;

  const appendUnique = (key, values) => {
    if (!values.length) return;
    const current = Array.isArray(config[key]) ? config[key] : [];
    const merged = uniqueSorted([...current, ...values]);
    if (merged.length !== current.length || merged.some((value, index) => value !== current[index])) {
      config[key] = merged;
      changed = true;
    }
  };

  appendUnique('tokio_noop_prefixes', updates.newTokio);
  appendUnique('git_async_stubs', updates.newGitAsync);
  appendUnique('behavioral_stubs', updates.newUnknown);

  if (changed) writeJson(configPath, config);
  return changed;
}

function maybeAutoPatch(rootDir, updates) {
  const platformPatchPath = path.join(rootDir, 'packages', 'copilot-termux', 'lib', 'platform-patch.js');
  const configPath = path.join(rootDir, 'config', 'napi-known-exports.json');

  const tokioPatched = patchTokioPattern(platformPatchPath, updates.newTokio);
  const gitPatched = patchGitAsyncStubs(platformPatchPath, updates.newGitAsync);

  // platform-patch.js への反映に成功した分のみ config に記録する
  // 失敗した場合に config へ記録すると次回監査で「既知」と誤判定されるため
  const configUpdates = {
    newTokio: tokioPatched ? updates.newTokio : [],
    newGitAsync: gitPatched ? updates.newGitAsync : [],
    newUnknown: updates.newUnknown,
  };
  const configPatched = updateKnownExportsConfig(configPath, configUpdates);

  return tokioPatched || gitPatched || configPatched;
}

function main() {
  const args = process.argv.slice(2);
  const autoPatch = args.includes('--auto-patch');
  const positional = args.filter((arg) => arg !== '--auto-patch');

  if (positional.length < 2) {
    console.error('Usage: node scripts/napi-audit.js <runtime.node-path> <version> [--auto-patch]');
    process.exit(1);
  }

  const [runtimePath, version] = positional;
  const rootDir = path.resolve(__dirname, '..');
  const configPath = path.join(rootDir, 'config', 'napi-known-exports.json');
  const config = readJson(configPath);
  const candidates = extractCandidates(runtimePath);
  const updates = classifyCandidates(candidates, config);
  const patchApplied = autoPatch ? maybeAutoPatch(rootDir, updates) : false;

  const summary = {
    candidateCount: candidates.length,
    knownCount: candidates.length - updates.newTokio.length - updates.newGitAsync.length - updates.newUnknown.length,
    newTokioCount: updates.newTokio.length,
    newGitAsyncCount: updates.newGitAsync.length,
    newUnknownCount: updates.newUnknown.length,
  };

  const output = {
    newTokio: updates.newTokio,
    newGitAsync: updates.newGitAsync,
    newUnknown: updates.newUnknown,
    patchApplied,
    version,
    summary,
  };

  process.stdout.write(JSON.stringify(output));
}

main();
