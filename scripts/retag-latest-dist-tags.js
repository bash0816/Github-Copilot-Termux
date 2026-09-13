#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');

const packageName = '@bash0816/copilot-termux';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function runNpm(args, options = {}) {
  return execFileSync('npm', args, {
    encoding: 'utf8',
    stdio: options.stdio,
  });
}

function loadCurrentTags() {
  const raw = runNpm(['view', packageName, 'dist-tags', '--json']);
  return JSON.parse(raw);
}

function loadManifest() {
  return readJson('packages/copilot-termux/config/copilot-termux-release-manifest.json');
}

function addDistTag(version, tag) {
  runNpm(['dist-tag', 'add', `${packageName}@${version}`, tag], { stdio: 'inherit' });
}

function removeDistTag(tag) {
  runNpm(['dist-tag', 'rm', packageName, tag], { stdio: 'inherit' });
}

function listDistTags() {
  runNpm(['dist-tag', 'ls', packageName], { stdio: 'inherit' });
}

function restoreTags(previousLatest, previousCandidate, deps = { addDistTag, removeDistTag }) {
  const failures = [];
  if (previousLatest) {
    try {
      deps.addDistTag(previousLatest, 'latest');
    } catch (error) {
      failures.push({ tag: 'latest', target: previousLatest, error: error && error.stack ? error.stack : String(error) });
    }
  }
  if (previousCandidate) {
    try {
      deps.addDistTag(previousCandidate, 'candidate');
    } catch (error) {
      failures.push({ tag: 'candidate', target: previousCandidate, error: error && error.stack ? error.stack : String(error) });
    }
  } else {
    try {
      deps.removeDistTag('candidate');
    } catch (error) {
      failures.push({ tag: 'candidate', target: '(remove)', error: error && error.stack ? error.stack : String(error) });
    }
  }
  return { ok: failures.length === 0, failures };
}

function main() {
  const manifest = loadManifest();
  const currentTags = loadCurrentTags();
  const previousLatest = currentTags.latest || '';
  const previousCandidate = currentTags.candidate || '';
  const expectedLatest = process.env.COPILOT_TERMUX_EXPECTED_PREVIOUS_AUDITED_VERSION || '';
  const expectedCandidate = manifest.latest_candidate_version;

  if (!expectedLatest) {
    throw new Error('missing COPILOT_TERMUX_EXPECTED_PREVIOUS_AUDITED_VERSION');
  }
  if (previousLatest !== expectedLatest) {
    throw new Error(`registry latest ${previousLatest} does not match expected previous audited ${expectedLatest}`);
  }
  if (previousCandidate !== expectedCandidate) {
    throw new Error(`registry candidate ${previousCandidate} does not match expected manifest ${expectedCandidate}`);
  }

  try {
    addDistTag(expectedCandidate, 'latest');
    if (previousLatest && previousLatest !== expectedCandidate) {
      addDistTag(previousLatest, 'candidate');
    }
  } catch (error) {
    const restoreResult = restoreTags(previousLatest, previousCandidate);
    if (!restoreResult.ok) {
      const details = restoreResult.failures.map(f => `  - ${f.tag} -> ${f.target}: ${f.error}`).join('\n');
      throw new Error(
        `promote failed (${error.message}) AND rollback failed; registry is in an inconsistent state and requires manual recovery:\n${details}`
      );
    }
    throw error;
  }

  try {
    listDistTags();
  } catch (error) {
    console.error(error && error.stack ? error.stack : String(error));
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  }
}

module.exports = {
  addDistTag,
  loadCurrentTags,
  listDistTags,
  main,
  restoreTags,
  removeDistTag,
  runNpm,
};
