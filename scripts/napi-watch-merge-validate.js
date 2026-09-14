#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');

/**
 * Deep equality check for objects, arrays, and primitives.
 * Handles null specially (null !== undefined, null !== {}).
 * For numbers, rejects NaN and non-finite values.
 */
function deepEqual(a, b) {
  // Explicit null checks
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;

  // Type check
  const typeA = typeof a;
  const typeB = typeof b;
  if (typeA !== typeB) return false;

  // Primitive types (string, number, boolean, etc.)
  if (typeA !== 'object') {
    // For numbers, ensure they are finite (reject NaN, Infinity)
    if (typeA === 'number') {
      return Number.isFinite(a) && Number.isFinite(b) && a === b;
    }
    return a === b;
  }

  // Array check
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((val, idx) => deepEqual(val, b[idx]));
  }

  // Both must be objects (non-array)
  if (Array.isArray(a) || Array.isArray(b)) return false;

  // Object key check
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length) return false;
  if (!deepEqual(keysA, keysB)) return false;

  // Recursively compare values
  return keysA.every(key => deepEqual(a[key], b[key]));
}

/**
 * Validate the PR manifest changes against safe-merge criteria.
 *
 * @param {Object} options
 * @param {string} options.prHeadSha - The HEAD SHA of the PR branch
 * @param {string} options.newVersion - Expected new version string
 * @param {string} options.expectedLastUpdated - Expected last_updated ISO date (YYYY-MM-DD)
 * @param {Function} options.execGitShow - (ref, path) => string, throws on error
 * @param {Function} options.execGitDiffNameStatus - () => Array<{status, path}>, throws on error
 * @param {Function} options.fetchIntegrity - (version) => string, throws on error
 * @returns {Object} {safeMerge: boolean, reason: string}
 * @throws {Error} If git or npm commands fail
 */
function validateSafeMerge({ prHeadSha, newVersion, expectedLastUpdated, execGitShow, execGitDiffNameStatus, fetchIntegrity }) {
  const allowlist = [
    'packages/copilot-termux/config/copilot-termux-release-manifest.json',
    'packages/copilot-termux/config/manifest.json',
    'packages/copilot-termux/package.json',
    'packages/copilot-termux/lib/platform-patch.js',
    'config/napi-known-exports.json'
  ];

  // Get the diff
  let diffFiles;
  try {
    diffFiles = execGitDiffNameStatus();
  } catch (e) {
    throw new Error(`Failed to get git diff: ${e.message}`);
  }

  // Check all diff files are in allowlist
  const diffPaths = diffFiles.map(f => f.path);
  const allowedPaths = new Set(allowlist);
  for (const path of diffPaths) {
    if (!allowedPaths.has(path)) {
      return { safeMerge: false, reason: 'disallowed_file_change' };
    }
  }

  // Check if code or audit data files changed
  const forbiddenPaths = [
    'packages/copilot-termux/lib/platform-patch.js',
    'config/napi-known-exports.json'
  ];
  for (const path of diffPaths) {
    if (forbiddenPaths.includes(path)) {
      return { safeMerge: false, reason: 'code_or_audit_data_changed' };
    }
  }

  // Now validate the manifest files
  const manifestFiles = [
    { path: 'packages/copilot-termux/config/copilot-termux-release-manifest.json', reason: 'unexpected_change_in_release_manifest' },
    { path: 'packages/copilot-termux/package.json', reason: 'unexpected_change_in_package_json' },
    { path: 'packages/copilot-termux/config/manifest.json', reason: 'unexpected_change_in_config_manifest' }
  ];

  for (const { path, reason } of manifestFiles) {
    let baseContent, headContent;
    try {
      baseContent = execGitShow('origin/main', path);
      headContent = execGitShow(prHeadSha, path);
    } catch (e) {
      throw new Error(`Failed to get file content for ${path}: ${e.message}`);
    }

    let base, head;
    try {
      base = JSON.parse(baseContent);
      head = JSON.parse(headContent);
    } catch (e) {
      throw new Error(`Failed to parse JSON for ${path}: ${e.message}`);
    }

    // Build expected object based on file type
    const expected = JSON.parse(JSON.stringify(base)); // deep clone

    if (path === 'packages/copilot-termux/config/copilot-termux-release-manifest.json') {
      expected.copilot_version = newVersion;
      expected.last_updated = expectedLastUpdated;
      expected.candidate_state = 'none';
      expected.canonical_package_status = 'not_published';
      expected.latest_candidate_version = null;
    } else if (path === 'packages/copilot-termux/package.json') {
      expected.version = newVersion;
    } else if (path === 'packages/copilot-termux/config/manifest.json') {
      expected.copilot = expected.copilot || {};
      expected.copilot.version = newVersion;
      // Fetch integrity for this file only
      let integrity;
      try {
        integrity = fetchIntegrity(newVersion);
      } catch (e) {
        throw new Error(`Failed to fetch integrity for ${newVersion}: ${e.message}`);
      }
      expected.copilot.integrity = integrity;
    }

    // Compare
    if (!deepEqual(expected, head)) {
      return { safeMerge: false, reason };
    }
  }

  return { safeMerge: true, reason: 'matches_expected' };
}

// CLI entry point
if (require.main === module) {
  const prHeadSha = process.env.PR_HEAD_SHA;
  const newVersion = process.env.NEW_VERSION;
  const expectedLastUpdated = process.env.EXPECTED_LAST_UPDATED;

  if (!prHeadSha || !newVersion || !expectedLastUpdated) {
    console.error('Missing required environment variables: PR_HEAD_SHA, NEW_VERSION, EXPECTED_LAST_UPDATED');
    process.exit(1);
  }

  // Define dependency functions
  const execGitShow = (ref, path) => {
    return execFileSync('git', ['show', `${ref}:${path}`], { encoding: 'utf8' });
  };

  const execGitDiffNameStatus = () => {
    const output = execFileSync('git', ['diff', '--name-status', '-z', '--no-renames', 'origin/main', prHeadSha], { encoding: 'utf8' });
    const result = [];
    const parts = output.split('\0').filter(p => p.length > 0);
    for (let i = 0; i < parts.length; i += 2) {
      if (i + 1 < parts.length) {
        result.push({ status: parts[i], path: parts[i + 1] });
      }
    }
    return result;
  };

  const fetchIntegrity = (version) => {
    const integrity = execFileSync('npm', ['view', `@github/copilot-linuxmusl-arm64@${version}`, 'dist.integrity'], { encoding: 'utf8' }).trim();
    if (!integrity || integrity.includes('\n')) {
      throw new Error(`Invalid integrity value from npm view: "${integrity}"`);
    }
    return integrity;
  };

  try {
    const result = validateSafeMerge({
      prHeadSha,
      newVersion,
      expectedLastUpdated,
      execGitShow,
      execGitDiffNameStatus,
      fetchIntegrity
    });
    console.log(JSON.stringify(result));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

module.exports = { validateSafeMerge, deepEqual };
