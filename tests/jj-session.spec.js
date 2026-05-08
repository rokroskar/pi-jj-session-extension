#!/usr/bin/env node
/*
 * Comprehensive dependency-free tests for extensions/jj-session.ts.
 *
 * These tests cover two layers:
 *   1. Source-contract tests: the real extension source contains the expected
 *      commands, event hooks, cwd behavior, and initialization commands.
 *   2. Behavioral model tests: a small executable model of the extension's core
 *      logic verifies initialization, checkpointing, branching restore, and
 *      checkpoint lookup behavior with fake pi/session/jj state.
 *
 * Run with:
 *   node tests/jj-session.spec.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const sourcePath = path.join(root, 'extensions', 'jj-session.ts');
const source = fs.readFileSync(sourcePath, 'utf8');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function includes(text) { assert(source.includes(text), `missing source fragment: ${text}`); }
function excludes(text) { assert(!source.includes(text), `unexpected source fragment: ${text}`); }

class FakeSessionManager {
  constructor(entries = []) {
    this.entries = entries;
    this.leafId = entries.at(-1)?.id;
  }
  getEntries() { return this.entries; }
  getEntry(id) { return this.entries.find((entry) => entry.id === id); }
  getLeafEntry() { return this.getEntry(this.leafId); }
  getPath() {
    const out = [];
    let cur = this.getLeafEntry();
    const seen = new Set();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      out.push(cur);
      cur = cur.parentId ? this.getEntry(cur.parentId) : undefined;
    }
    return out.reverse();
  }
}

class FakePi {
  constructor({ cwd = '/repo', jjReady = false, gitReady = false, dirty = false, initMode = 'ok' } = {}) {
    this.cwdForTests = cwd;
    this.jjReady = jjReady;
    this.gitReady = gitReady;
    this.dirty = dirty;
    this.initMode = initMode;
    this.calls = [];
    this.nextCommit = 1;
  }
  async exec(cmd, args, opts = {}) {
    this.calls.push({ cmd, args, cwd: opts.cwd });

    if (cmd === 'jj' && args[0] === 'status') {
      return this.jjReady
        ? { code: 0, stdout: this.dirty ? 'Modified files:\nM file.txt\n' : 'The working copy has no changes.\n', stderr: '' }
        : { code: 1, stdout: '', stderr: 'No jj repo' };
    }

    if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      return this.gitReady ? { code: 0, stdout: this.cwdForTests, stderr: '' } : { code: 1, stdout: '', stderr: 'not git' };
    }
    if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--git-dir') {
      return this.gitReady ? { code: 0, stdout: '.git', stderr: '' } : { code: 1, stdout: '', stderr: 'not git' };
    }

    if (cmd === 'jj' && args[0] === 'git' && args[1] === 'init') {
      if (this.initMode === 'existing-git-error' && args.includes('--no-colocate')) {
        return { code: 1, stdout: '', stderr: 'Error: Did not create a jj repo because there is an existing Git repo in this directory.' };
      }
      if (this.initMode === 'fail') return { code: 1, stdout: '', stderr: 'init failed' };
      this.jjReady = true;
      return { code: 0, stdout: '', stderr: '' };
    }

    if (cmd === 'jj' && args[0] === 'commit') {
      this.dirty = false;
      this.lastCommitMessage = args[2];
      this.lastCommitId = `chg${this.nextCommit++}`;
      return { code: 0, stdout: '', stderr: '' };
    }

    if (cmd === 'jj' && args[0] === 'log') {
      return { code: 0, stdout: this.lastCommitId || 'chg0', stderr: '' };
    }

    if (cmd === 'jj' && args[0] === 'new') {
      this.currentParent = args[1];
      return { code: 0, stdout: '', stderr: '' };
    }

    throw new Error(`unhandled fake exec: ${cmd} ${args.join(' ')}`);
  }
  called(cmd, argsPrefix) {
    return this.calls.some((call) => call.cmd === cmd && argsPrefix.every((arg, i) => call.args[i] === arg));
  }
}

function makeModel({ pi, ctx, settingsEnabled = false, autoRestore = true }) {
  const checkpoints = new Map();
  let enabled = settingsEnabled;

  const cwd = () => ctx.cwd;
  const detectJj = async () => (await pi.exec('jj', ['status'], { cwd: cwd() })).code === 0;
  const hasChanges = async () => {
    const { code, stdout } = await pi.exec('jj', ['status'], { cwd: cwd() });
    if (code !== 0) return false;
    return stdout.trim() && !/(working copy (is )?clean|working copy has no changes)/i.test(stdout.trim());
  };
  const commitChanges = async (message) => {
    await pi.exec('jj', ['commit', '-m', message], { cwd: cwd() });
    const { stdout } = await pi.exec('jj', ['log', '-r', '@-', '--no-graph', '-T', 'change_id.short()'], { cwd: cwd() });
    return stdout.trim().split(/\s+/)[0];
  };
  const ensureJjRepo = async () => {
    if (await detectJj()) return true;
    const gitRoot = await pi.exec('git', ['rev-parse', '--show-toplevel'], { cwd: cwd() });
    const gitDir = await pi.exec('git', ['rev-parse', '--git-dir'], { cwd: cwd() });
    let initResult;
    if (gitRoot.code === 0 && gitDir.code === 0) {
      initResult = await pi.exec('jj', ['git', 'init', '--git-repo', path.join(gitRoot.stdout.trim(), gitDir.stdout.trim()), gitRoot.stdout.trim()], { cwd: cwd() });
    } else {
      initResult = await pi.exec('jj', ['git', 'init', '--no-colocate', cwd()], { cwd: cwd() });
      if (initResult.code !== 0 && /existing Git repo/i.test(`${initResult.stderr}\n${initResult.stdout}`)) {
        initResult = await pi.exec('jj', ['git', 'init', '--colocate', cwd()], { cwd: cwd() });
      }
    }
    if (initResult.code !== 0) return false;
    if (await hasChanges()) await commitChanges('pi session baseline');
    return detectJj();
  };
  const latestUserEntryId = () => [...ctx.sessionManager.getEntries()].reverse().find((e) => e.type === 'message' && e.message?.role === 'user')?.id;
  const findCheckpointForEntry = (entryId) => {
    if (entryId && checkpoints.has(entryId)) return checkpoints.get(entryId);
    let cur = entryId;
    const seen = new Set();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const entry = ctx.sessionManager.getEntry(cur);
      cur = entry?.parentId;
      if (cur && checkpoints.has(cur)) return checkpoints.get(cur);
    }
    for (const entry of [...ctx.sessionManager.getPath()].reverse()) {
      if (checkpoints.has(entry.id)) return checkpoints.get(entry.id);
    }
  };
  return {
    checkpoints,
    get enabled() { return enabled; },
    async toggle() { enabled = !enabled; if (enabled) await ensureJjRepo(); return enabled; },
    messageStart(_text) {},
    async turnEnd() {
      if (!enabled) return;
      if (!(await ensureJjRepo())) return;
      if (!(await hasChanges())) return;
      const entryId = ctx.sessionManager.getLeafEntry()?.id;
      const description = `pi checkpoint ${entryId.slice(0, 8)}`;
      const commitId = await commitChanges(description);
      const checkpoint = { entryId, commitId, description, timestamp: Date.now() };
      checkpoints.set(entryId, checkpoint);
      const userEntryId = latestUserEntryId();
      if (userEntryId && userEntryId !== entryId) checkpoints.set(userEntryId, { ...checkpoint, entryId: userEntryId });
    },
    async restoreFor(entryId) {
      if (!enabled || !autoRestore) return false;
      const checkpoint = findCheckpointForEntry(entryId);
      if (!checkpoint) return false;
      if (!(await ensureJjRepo())) return false;
      await pi.exec('jj', ['new', checkpoint.commitId], { cwd: cwd() });
      return true;
    },
    async init() { return ensureJjRepo(); },
  };
}

// Source contract tests
test('source: extension is off by default and has expected commands', () => {
  includes('let jjEnabled = false');
  includes('settings.jjSession?.enabled === true');
  includes('pi.registerCommand("jj-toggle"');
  includes('pi.registerCommand("jj-init"');
  includes('pi.registerCommand("jj-checkpoints"');
  includes('pi.registerCommand("jj-restore"');
  includes('pi.registerCommand("jj-describe"');
  includes('pi.registerCommand("jj-compact"');
  includes('pi.registerCommand("jj-forget-checkpoints"');
  includes('pi.registerCommand("jj-sync"');
  excludes('pi.registerCommand("jj-doctor"');
});

test('source: uses ctx cwd, not pi.cwd', () => {
  includes('const cwd = (ctx?: any) => ctx?.cwd ?? process.cwd();');
  excludes('pi.cwd');
});

test('source: no-vcs init uses hidden jj git backend', () => {
  includes('["git", "init", "--no-colocate", root]');
});

test('source: existing git init uses --git-repo', () => {
  includes('["git", "init", "--git-repo"');
});

test('source: restore mirrors branching with jj new', () => {
  includes('pi.exec("jj", ["new", checkpoint.commitId]');
  excludes('"restore", "--from", checkpoint.commitId');
});

test('source: recognizes jj clean status wording', () => {
  includes('(working copy (is )?clean|working copy has no changes)');
});

test('source: automatic checkpoint messages do not include prompt text', () => {
  includes('const description = `pi checkpoint ${entryId.slice(0, 8)}`');
  excludes('pi.on("message_start"');
  excludes('pendingContent');
});

test('source: persists checkpoints across reloads/restarts', () => {
  includes('.jj", "pi-session-checkpoints.json"');
  includes('.pi", "jj-session-checkpoints.json"');
  includes('const loadCheckpoints = (ctx: any) =>');
  includes('const saveCheckpoints = (ctx: any) =>');
  includes('saveCheckpoints(ctx);');
  includes('loadCheckpoints(ctx);');
});

test('source: checkpoints command renders through the UI, not raw console output', () => {
  includes('ctx.ui.select(`JJ checkpoints (${rows.length})`');
  includes('const action = await ctx.ui.select(`JJ ${checkpoint.commitId.slice(0, 8)}`');
  includes('const message = await ctx.ui.input?.("Describe checkpoint"');
  includes('await restoreCheckpoint(checkpoint, ctx)');
  excludes('console.log');
});

test('source: warns when a pi point cannot restore because it was compacted', () => {
  includes('compactedCheckpoints = new Map');
  includes('const notifyCompactedIfNeeded = (ctx: any, entryId?: string) =>');
  includes('Cannot restore this pi point: its JJ checkpoint was compacted');
  includes('compactedCheckpoints.set(id, { ...checkpoint })');
});

test('source: gracefully handles stale checkpoint mappings', () => {
  includes('const revisionExists = async (ctx: any, revision: string) =>');
  includes('const markCheckpointMissing = (ctx: any, checkpoint: JjCheckpoint) =>');
  includes('const pruneMissingCheckpoints = async (ctx: any) =>');
  includes('await pruneMissingCheckpoints(ctx)');
  includes('Cannot describe this checkpoint: jj chg');
  includes('Cannot restore this checkpoint: jj chg');
});

test('source: exposes safe cleanup commands for checkpoint history', () => {
  includes('pi.registerCommand("jj-describe"');
  includes('pi.exec("jj", ["describe", "-r", checkpoint.commitId, "-m", message]');
  includes('pi.registerCommand("jj-compact"');
  includes('Cannot compact while the jj working copy has uncheckpointed changes');
  includes('pi.exec("jj", ["abandon", "--restore-descendants", ...discard.map((checkpoint) => checkpoint.commitId)]');
  includes('pi.registerCommand("jj-forget-checkpoints"');
  includes('fs.rmSync(checkpointsPathFor(ctx), { force: true })');
  includes('fs.rmSync(legacyCheckpointsPathFor(ctx), { force: true })');
});

test('source: shows enabled status and current jj change id in the UI', () => {
  includes('const STATUS_KEY = "jj-session"');
  includes('ctx.ui.setStatus?.(STATUS_KEY, styled)');
  includes('["log", "-r", "@", "--no-graph", "-T", "change_id.short()"]');
  includes('if (!jjEnabled) return setStatus(ctx, "jj off", "dim")');
  includes('const stateId = lastStateId ?? changeId');
  includes('setStatus(ctx, dirty ? `jj chg ${shortId} ±` : `jj chg ${shortId} ✓`, dirty ? "warning" : "accent")');
  includes('pi.on("session_start"');
});

// Behavioral model tests
test('behavior: disabled by default does not checkpoint dirty worktree', async () => {
  const pi = new FakePi({ jjReady: true, dirty: true });
  const ctx = { cwd: '/repo', sessionManager: new FakeSessionManager([{ id: 'u1', type: 'message', message: { role: 'user' } }]) };
  const model = makeModel({ pi, ctx });
  model.messageStart('change file');
  await model.turnEnd();
  assert.strictEqual(model.checkpoints.size, 0);
});

test('behavior: enabling initializes no-vcs project with --no-colocate', async () => {
  const pi = new FakePi({ jjReady: false, gitReady: false, dirty: false });
  const ctx = { cwd: '/repo', sessionManager: new FakeSessionManager([]) };
  const model = makeModel({ pi, ctx });
  await model.toggle();
  assert.strictEqual(model.enabled, true);
  assert(pi.called('jj', ['git', 'init', '--no-colocate']));
});

test('behavior: enabling in existing git repo uses --git-repo', async () => {
  const pi = new FakePi({ jjReady: false, gitReady: true, dirty: false });
  const ctx = { cwd: '/repo', sessionManager: new FakeSessionManager([]) };
  const model = makeModel({ pi, ctx });
  await model.toggle();
  assert(pi.called('jj', ['git', 'init', '--git-repo']));
  assert(!pi.called('jj', ['git', 'init', '--no-colocate']));
});

test('behavior: enabling in existing jj repo without git does not initialize', async () => {
  const pi = new FakePi({ jjReady: true, gitReady: false, dirty: false });
  const ctx = { cwd: '/repo', sessionManager: new FakeSessionManager([]) };
  const model = makeModel({ pi, ctx });
  await model.toggle();
  assert.strictEqual(model.enabled, true);
  assert(!pi.called('jj', ['git', 'init']));
  assert(!pi.called('git', ['rev-parse', '--show-toplevel']));
});

test('behavior: enabling in existing jj+git repo does not initialize', async () => {
  const pi = new FakePi({ jjReady: true, gitReady: true, dirty: false });
  const ctx = { cwd: '/repo', sessionManager: new FakeSessionManager([]) };
  const model = makeModel({ pi, ctx });
  await model.toggle();
  assert.strictEqual(model.enabled, true);
  assert(!pi.called('jj', ['git', 'init']));
  assert(!pi.called('git', ['rev-parse', '--show-toplevel']));
});

test('behavior: no git/no jj init failure returns not ready', async () => {
  const pi = new FakePi({ jjReady: false, gitReady: false, dirty: false, initMode: 'fail' });
  const ctx = { cwd: '/repo', sessionManager: new FakeSessionManager([]) };
  const model = makeModel({ pi, ctx });
  const ready = await model.init();
  assert.strictEqual(ready, false);
  assert(pi.called('jj', ['git', 'init', '--no-colocate']));
});

test('behavior: if --no-colocate reports existing git, fallback to --colocate', async () => {
  const pi = new FakePi({ jjReady: false, gitReady: false, dirty: false, initMode: 'existing-git-error' });
  const ctx = { cwd: '/repo', sessionManager: new FakeSessionManager([]) };
  const model = makeModel({ pi, ctx });
  await model.toggle();
  assert(pi.called('jj', ['git', 'init', '--no-colocate']));
  assert(pi.called('jj', ['git', 'init', '--colocate']));
});

test('behavior: enabling dirty no-vcs project creates baseline commit', async () => {
  const pi = new FakePi({ jjReady: false, gitReady: false, dirty: true });
  const ctx = { cwd: '/repo', sessionManager: new FakeSessionManager([]) };
  const model = makeModel({ pi, ctx });
  await model.toggle();
  assert.strictEqual(pi.lastCommitMessage, 'pi session baseline');
});

test('behavior: turn end commits dirty worktree and stores checkpoint under leaf and user prompt aliases', async () => {
  const pi = new FakePi({ jjReady: true, dirty: true });
  const entries = [
    { id: 'user1', type: 'message', message: { role: 'user' } },
    { id: 'leaf1', type: 'message', parentId: 'user1', message: { role: 'assistant' } },
  ];
  const ctx = { cwd: '/repo', sessionManager: new FakeSessionManager(entries) };
  const model = makeModel({ pi, ctx, settingsEnabled: true });
  model.messageStart('Create file a.txt with v1');
  await model.turnEnd();
  assert.strictEqual(pi.lastCommitMessage, 'pi checkpoint leaf1');
  assert(model.checkpoints.has('leaf1'));
  assert(model.checkpoints.has('user1'));
});

test('behavior: tree restore runs jj new <checkpoint> to mirror branch', async () => {
  const pi = new FakePi({ jjReady: true, dirty: false });
  const entries = [{ id: 'u1', type: 'message', message: { role: 'user' } }];
  const ctx = { cwd: '/repo', sessionManager: new FakeSessionManager(entries) };
  const model = makeModel({ pi, ctx, settingsEnabled: true });
  model.checkpoints.set('u1', { entryId: 'u1', commitId: 'chg1', description: 'pi session: x', timestamp: Date.now() });
  const restored = await model.restoreFor('u1');
  assert.strictEqual(restored, true);
  assert(pi.called('jj', ['new', 'chg1']));
});

test('behavior: checkpoint lookup can walk ancestors', async () => {
  const pi = new FakePi({ jjReady: true, dirty: false });
  const entries = [
    { id: 'u1', type: 'message', message: { role: 'user' } },
    { id: 'a1', parentId: 'u1', type: 'message', message: { role: 'assistant' } },
    { id: 'later', parentId: 'a1', type: 'message', message: { role: 'assistant' } },
  ];
  const sm = new FakeSessionManager(entries);
  sm.leafId = 'later';
  const ctx = { cwd: '/repo', sessionManager: sm };
  const model = makeModel({ pi, ctx, settingsEnabled: true });
  model.checkpoints.set('u1', { entryId: 'u1', commitId: 'chg1', description: 'pi session: x', timestamp: Date.now() });
  const restored = await model.restoreFor('later');
  assert.strictEqual(restored, true);
  assert(pi.called('jj', ['new', 'chg1']));
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log(`✓ ${name}`);
    } catch (err) {
      console.error(`✗ ${name}`);
      console.error(err && err.stack ? err.stack : err);
      process.exitCode = 1;
      break;
    }
  }
  console.log(`\n${passed}/${tests.length} tests passed`);
})();
