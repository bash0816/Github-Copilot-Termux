#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const stubs = require('./platform-patch.js');

const tests = [];
let passCount = 0;
let failCount = 0;

function assert(condition, message) {
  if (!condition) {
    tests.push({ name: message, passed: false });
    failCount++;
    console.error(`  FAIL: ${message}`);
  } else {
    tests.push({ name: message, passed: true });
    passCount++;
    console.log(`  PASS: ${message}`);
  }
}

function git(cwd, args) {
  execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function mkTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-async-stub-test-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'test\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'initial']);
  return dir;
}

async function main() {
  console.log('[copilot-termux git-async-stubs.hook-verify]');

  {
    const dir = mkTempRepo();
    const remotes = await stubs.listGitRemotes(dir);
    assert(Array.isArray(remotes) && remotes.length === 0, 'listGitRemotes: no remotes -> []');
    fs.rmSync(dir, { recursive: true, force: true });
  }
  {
    const dir = mkTempRepo();
    git(dir, ['remote', 'add', 'origin', 'https://github.com/owner/repo.git']);
    git(dir, ['remote', 'add', 'upstream', 'git@github.com:upstream-owner/repo.git']);
    const remotes = await stubs.listGitRemotes(dir);
    assert(remotes.length === 2, 'listGitRemotes: two remotes -> length 2');
    assert(remotes.some((r) => r.Name === 'origin' && r.FetchURL === 'https://github.com/owner/repo.git'),
      'listGitRemotes: origin FetchURL preserved');
    assert(remotes.some((r) => r.Name === 'upstream'), 'listGitRemotes: upstream present');
    fs.rmSync(dir, { recursive: true, force: true });
  }
  {
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'git-async-stub-nogit-'));
    const remotes = await stubs.listGitRemotes(nonGit);
    assert(Array.isArray(remotes) && remotes.length === 0, 'listGitRemotes: non-git dir -> []');
    fs.rmSync(nonGit, { recursive: true, force: true });
  }

  assert(JSON.stringify(stubs.parseGitRemoteUrl('https://github.com/owner/repo.git')) ===
    JSON.stringify({ host: 'github.com', owner: 'owner', name: 'repo' }),
    'parseGitRemoteUrl: https form');
  assert(JSON.stringify(stubs.parseGitRemoteUrl('git@github.com:owner/repo.git')) ===
    JSON.stringify({ host: 'github.com', owner: 'owner', name: 'repo' }),
    'parseGitRemoteUrl: scp-like ssh form');
  assert(JSON.stringify(stubs.parseGitRemoteUrl('ssh://git@github.com/owner/repo.git')) ===
    JSON.stringify({ host: 'github.com', owner: 'owner', name: 'repo' }),
    'parseGitRemoteUrl: ssh:// form');
  assert(JSON.stringify(stubs.parseGitRemoteUrl('https://foo.ghe.com/owner/repo.git')) ===
    JSON.stringify({ host: 'foo.ghe.com', owner: 'owner', name: 'repo' }),
    'parseGitRemoteUrl: GHE Cloud host');
  assert(stubs.parseGitRemoteUrl('not a url') === null, 'parseGitRemoteUrl: unparseable -> null');

  {
    const dir = mkTempRepo();
    git(dir, ['remote', 'add', 'origin', 'https://github.com/owner/repo.git']);
    const id = await stubs.resolveRepoIdentifier(dir);
    assert(id && id.identifier === 'owner/repo' && id.hostType === 'github' && id.host === 'github.com',
      'resolveRepoIdentifier: github.com origin');
    fs.rmSync(dir, { recursive: true, force: true });
  }
  {
    const dir = mkTempRepo();
    git(dir, ['remote', 'add', 'origin', 'https://gitlab.com/owner/repo.git']);
    const id = await stubs.resolveRepoIdentifier(dir);
    assert(id && id.hostType === 'other', 'resolveRepoIdentifier: non-github host -> hostType other');
    fs.rmSync(dir, { recursive: true, force: true });
  }
  {
    const dir = mkTempRepo();
    const id = await stubs.resolveRepoIdentifier(dir);
    assert(id === null, 'resolveRepoIdentifier: no remotes -> null');
    fs.rmSync(dir, { recursive: true, force: true });
  }
  {
    const dir = mkTempRepo();
    git(dir, ['remote', 'add', 'upstream', 'https://github.com/other/repo.git']);
    const id = await stubs.resolveRepoIdentifier(dir);
    assert(id && id.identifier === 'other/repo', 'resolveRepoIdentifier: falls back to first remote when no origin');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  {
    const dir = mkTempRepo();
    git(dir, ['remote', 'add', 'origin', 'https://github.com/owner/repo.git']);
    const ctx = await stubs.buildWorkingDirectoryContext(dir);
    assert(ctx.cwd === dir, 'buildWorkingDirectoryContext: cwd echoed');
    assert(ctx.gitRoot === dir, 'buildWorkingDirectoryContext: gitRoot resolved');
    assert(ctx.branch === 'main', 'buildWorkingDirectoryContext: branch resolved');
    assert(ctx.repository === 'owner/repo', 'buildWorkingDirectoryContext: repository resolved');
    assert(ctx.hostType === 'github', 'buildWorkingDirectoryContext: hostType resolved');
    assert(ctx.repositoryHost === 'github.com', 'buildWorkingDirectoryContext: repositoryHost resolved');
    fs.rmSync(dir, { recursive: true, force: true });
  }
  {
    const dir = mkTempRepo();
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    git(dir, ['checkout', '-q', sha]);
    const ctx = await stubs.buildWorkingDirectoryContext(dir);
    assert(ctx.gitRoot === dir, 'buildWorkingDirectoryContext (detached): gitRoot still resolved');
    assert(ctx.branch === undefined, 'buildWorkingDirectoryContext (detached): branch omitted');
    fs.rmSync(dir, { recursive: true, force: true });
  }
  {
    const dir = mkTempRepo();
    const ctx = await stubs.buildWorkingDirectoryContext(dir);
    assert(ctx.gitRoot === dir, 'buildWorkingDirectoryContext (no origin): gitRoot resolved');
    assert(ctx.branch === 'main', 'buildWorkingDirectoryContext (no origin): branch resolved');
    assert(ctx.repository === undefined, 'buildWorkingDirectoryContext (no origin): repository omitted');
    fs.rmSync(dir, { recursive: true, force: true });
  }
  {
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'git-async-stub-nogit2-'));
    const ctx = await stubs.buildWorkingDirectoryContext(nonGit);
    assert(ctx.cwd === nonGit, 'buildWorkingDirectoryContext (non-git): cwd echoed');
    assert(ctx.gitRoot === undefined, 'buildWorkingDirectoryContext (non-git): gitRoot omitted');
    assert(Object.keys(ctx).length === 1, 'buildWorkingDirectoryContext (non-git): only cwd field present');
    fs.rmSync(nonGit, { recursive: true, force: true });
  }

  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('[Fatal]', e);
  process.exit(1);
});
