'use strict';

const fs = require('fs');
const path = require('path');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

function uniqueSorted(values) {
  return Array.from(new Set(values)).sort();
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function loadKnownSet(config) {
  const known = new Set();
  for (const value of config.tokio_noop_prefixes || []) known.add(value);
  for (const value of config.behavioral_stubs || []) known.add(value);
  for (const value of config.git_async_stubs || []) known.add(value);
  for (const value of config.stream_pipeline_risk || []) known.add(value);
  return known;
}

function loadPendingSet(config) {
  const pending = new Set();
  for (const value of config.pending_git_async_stubs || []) pending.add(value);
  return pending;
}

function classifyCandidates(candidates, config) {
  const known = loadKnownSet(config);
  const pending = loadPendingSet(config);
  const tokioPrefixes = Array.isArray(config.tokio_noop_prefixes) ? config.tokio_noop_prefixes : [];
  const newTokio = [];
  const newPendingGitAsync = [];
  const newStreamRisk = [];
  const newUnknown = [];

  for (const candidate of candidates) {
    if (known.has(candidate)) continue;
    if (pending.has(candidate)) continue;
    if (/Stream/.test(candidate)) {
      newStreamRisk.push(candidate);
      continue;
    }
    if (tokioPrefixes.some((prefix) => candidate.startsWith(prefix))) {
      newTokio.push(candidate);
      continue;
    }
    if (/^git[A-Z].*Async$/.test(candidate)) {
      newPendingGitAsync.push(candidate);
      continue;
    }
    if (/^[a-z]/.test(candidate) && candidate.length >= 15) {
      newUnknown.push(candidate);
    }
  }

  return {
    newTokio: uniqueSorted(newTokio),
    newPendingGitAsync: uniqueSorted(newPendingGitAsync),
    newStreamRisk: uniqueSorted(newStreamRisk),
    newUnknown: uniqueSorted(newUnknown),
  };
}

function extractCandidates(runtimePath) {
  // Implement strings -n 8 behavior: extract runs of printable ASCII chars (0x20-0x7E)
  // that are at least 8 bytes long, then apply identifier regex filter
  const buffer = fs.readFileSync(runtimePath);
  const seen = new Set();

  let i = 0;
  while (i < buffer.length) {
    // Scan for start of run of printable ASCII (0x20-0x7E)
    if (buffer[i] >= 0x20 && buffer[i] <= 0x7E) {
      const runStart = i;
      // Continue while bytes are printable ASCII
      while (i < buffer.length && buffer[i] >= 0x20 && buffer[i] <= 0x7E) {
        i++;
      }
      const runLength = i - runStart;
      // Keep only runs >= 8 bytes
      if (runLength >= 8) {
        // Decode as latin1 (1 byte = 1 character, handles 0x00-0xFF)
        const candidate = buffer.toString('latin1', runStart, i).trim();
        // Apply identifier regex filter
        if (/^[a-zA-Z_$][a-zA-Z0-9_$]{6,}$/.test(candidate)) {
          seen.add(candidate);
        }
      }
    } else {
      i++;
    }
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
  const escapedAdditions = additions.map(escapeRegExp);
  const merged = uniqueSorted([...currentPrefixes, ...escapedAdditions]);
  const updatedLine = `${lineMatch[1]}${merged.join('|')}${lineMatch[3]}`;
  const updated = original.replace(lineMatch[0], updatedLine);
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
  // behavioral_stubs(newUnknownの生データ)はランタイムで未使用の監査状態管理フィールドであり、
  // public repoにコミットされるこのconfigへは永続化しない
  // (2026-07-19、内部監査の未分類関数名をpublicに残さない方針のため)

  if (changed) writeJson(configPath, config);
  return changed;
}

function maybeAutoPatch(rootDir, updates) {
  const platformPatchPath = path.join(rootDir, 'packages', 'copilot-termux', 'lib', 'platform-patch.js');
  const configPath = path.join(rootDir, 'config', 'napi-known-exports.json');

  const tokioPatched = patchTokioPattern(platformPatchPath, updates.newTokio);
  // pending_git_async_stubs(newPendingGitAsyncの生データ)も同じ理由でpublicへ永続化しない。
  // 該当項目はprivate repoのissueで都度レビューする運用に統一する(2026-07-19)。

  // platform-patch.js への反映に成功した分のみ config に記録する
  // 失敗した場合に config へ記録すると次回監査で「既知」と誤判定されるため
  const configUpdates = {
    newTokio: tokioPatched ? updates.newTokio : [],
  };
  const configPatched = updateKnownExportsConfig(configPath, configUpdates);

  const tokioPatchOk = updates.newTokio.length === 0 || tokioPatched;

  return { patchApplied: tokioPatched || configPatched, tokioPatchOk };
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
  const patchResult = autoPatch ? maybeAutoPatch(rootDir, updates) : { patchApplied: false, tokioPatchOk: updates.newTokio.length === 0 };
  const patchApplied = patchResult.patchApplied;
  const tokioPatchOk = patchResult.tokioPatchOk;

  const summary = {
    candidateCount: candidates.length,
    knownCount: candidates.length - updates.newTokio.length - updates.newPendingGitAsync.length - updates.newStreamRisk.length - updates.newUnknown.length,
    newTokioCount: updates.newTokio.length,
    newPendingGitAsyncCount: updates.newPendingGitAsync.length,
    newStreamRiskCount: updates.newStreamRisk.length,
    newUnknownCount: updates.newUnknown.length,
  };

  const output = {
    newTokio: updates.newTokio,
    newPendingGitAsync: updates.newPendingGitAsync,
    newStreamRisk: updates.newStreamRisk,
    newUnknown: updates.newUnknown,
    patchApplied,
    tokioPatchOk,
    version,
    summary,
  };

  process.stdout.write(JSON.stringify(output));
}

// Export functions for testing
module.exports = {
  extractCandidates,
  classifyCandidates,
  readJson,
  writeJson,
  uniqueSorted,
  escapeRegExp,
  loadKnownSet,
  loadPendingSet,
  patchTokioPattern,
  updateKnownExportsConfig,
  maybeAutoPatch,
};

// Only run main if this file is executed directly
if (require.main === module) {
  main();
}
