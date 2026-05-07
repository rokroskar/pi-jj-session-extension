# Pi JJ Session Extension

A pi extension that ties local file state to pi's branching session timeline using [Jujutsu](https://jj-vcs.github.io/jj/latest/) (`jj`).

When enabled, the extension creates jj checkpoints after pi turns that change files. When you navigate the pi session tree or fork from an earlier point, it moves the jj working copy to a new branch from the matching checkpoint so file history follows conversation history.

## Status

- **Off by default**.
- Uses `jj` as the working VCS.
- If an existing Git repo is present, initializes jj on top of that Git repo.
- If no VCS is present, initializes a non-colocated jj repo (`.jj/` only, no top-level `.git/`).
- Mirrors pi branching with `jj new <checkpoint>`.
- Shows a compact footer status: `jj off` when disabled, `jj chg abc12345 ✓` when enabled and clean, or `jj chg abc12345 ±` when the working copy has uncheckpointed changes.
- Persists pi-entry-to-jj checkpoint mappings in `.pi/jj-session-checkpoints.json`, so tree restores survive `/reload` and pi restarts.

## Requirements

`jj` must be installed and available on `PATH`:

```bash
jj --version
```

## Installation

This repo is packaged as a pi package. The extension entry point is declared in `package.json`:

```json
{
  "pi": {
    "extensions": ["extensions/jj-session.ts"]
  }
}
```

### Local development

From another project, install this checkout globally:

```bash
pi install /absolute/path/to/pi-jj-session-extension
```

Or install it into the current project's `.pi/settings.json`:

```bash
pi install -l /absolute/path/to/pi-jj-session-extension
```

For one-off testing without installing:

```bash
pi -e /absolute/path/to/pi-jj-session-extension
```

### Git install

Installing from GitHub:

```bash
pi install git:github.com/rokroskar/pi-jj-session-extension
```

Pinned tag/version:

```bash
pi install git:github.com/rokroskar/pi-jj-session-extension@v1.0.0
```

Project-local team install:

```bash
pi install -l git:github.com/rokroskar/pi-jj-session-extension@v1.0.0
```

Then restart pi or run:

```text
/reload
```

## Enabling

The extension is off by default. Enable it in pi:

```text
/jj-toggle
```

This persists the setting to `.pi/settings.json` for the current project.

You can also configure it manually:

```json
{
  "jjSession": {
    "enabled": true,
    "autoRestore": true
  }
}
```

Disable again:

```text
/jj-toggle
```

## Repository initialization behavior

When the extension is enabled, it ensures a jj repo exists:

| Current project state | Behavior |
|---|---|
| Existing jj repo | Use it |
| Existing Git repo, no jj | `jj git init --git-repo <git-dir> <root>` |
| No VCS | `jj git init --no-colocate <cwd>` |

Your installed jj version does not support a native `jj init`. For projects without VCS, the extension uses `jj git init --no-colocate`, which creates a `.jj/` directory with the Git backing store hidden inside `.jj/`. It does **not** create a top-level `.git/`.

If the project already has files when jj is initialized, the extension creates a quiet baseline commit:

```text
pi session baseline
```

This gives future pi checkpoints a clean starting point.

## Commands

| Command | Description |
|---|---|
| `/jj-toggle` | Enable/disable the extension and persist the setting |
| `/jj-init` | Initialize jj for the current project if needed |
| `/jj-checkpoints` | List saved checkpoints for this project |
| `/jj-restore [entry-id-or-change-id]` | Restore files from a checkpoint, or latest if omitted |
| `/jj-describe <message>` | Rename/describe the latest checkpoint change |
| `/jj-describe -r <entry-id-or-change-id> <message>` | Rename/describe a specific checkpoint change |
| `/jj-forget-checkpoints` | Clear pi restore mappings without deleting jj history |
| `/jj-sync` | Restore files to the nearest checkpoint on the current pi session path |

## Example: conversation history controls file history

Start with the extension enabled:

```text
/jj-toggle
```

When disabled, the footer/status line shows:

```text
jj off
```

When enabled, it shows the latest checkpoint/restored state id:

```text
jj chg mzvwkqpn ✓
```

If the working copy has uncheckpointed changes, it switches to:

```text
jj chg mzvwkqpn ±
```

If jj has not been initialized yet, it shows:

```text
jj · not initialized
```

Then ask pi to make two changes:

```text
You: Create notes.txt containing "version 1"
pi:  writes notes.txt
     JJ checkpoint A

You: Change notes.txt to say "version 2"
pi:  edits notes.txt
     JJ checkpoint B
```

At this point your file contains:

```text
version 2
```

Your pi session and jj checkpoints line up like this:

```text
pi session history              file state

A  Create notes.txt        -->  notes.txt = "version 1"
│
B  Change to version 2     -->  notes.txt = "version 2"   <- current
```

Now open pi's tree:

```text
/tree
```

Select the earlier `Create notes.txt` turn. The extension restores the matching jj checkpoint by creating a new jj child from checkpoint `A`:

```text
pi session history              jj/file history

A  Create notes.txt        -->  A: notes.txt = "version 1"  <- restored
│                              ├─ B: notes.txt = "version 2"
B  Change to version 2         └─ @: new working branch from A
```

Your working file is back to:

```text
version 1
```

If you now ask pi to try something different:

```text
You: Change notes.txt to say "alternate version 2"
```

jj records a real branch:

```text
A  notes.txt = "version 1"
├─ B  notes.txt = "version 2"
└─ C  notes.txt = "alternate version 2"  <- current
```

That is the core idea: moving around pi's session tree also moves your files to the matching point in jj history, so experiments can branch naturally. The footer status updates along the way so you can always see which jj change your working copy is on.

If you want to force synchronization after navigation:

```text
/jj-sync
```

Check jj's graph:

```bash
jj log
```

You should see branching corresponding to pi branching after you navigate back and make new changes.

## How branching works

For each file-changing pi turn:

1. pi changes files.
2. The extension runs `jj commit -m "pi session: ..."`.
3. It stores the produced jj change id as a checkpoint.

When you navigate back in pi:

1. The extension finds the nearest checkpoint for the selected session entry/path.
2. It runs:

   ```bash
   jj new <checkpoint>
   ```

3. The working copy now sits on a new child of that checkpoint.
4. The next pi file-changing turn commits on that branch.

So jj history can mirror pi's session tree:

```text
pi:  A ─ B ─ C
          └ D

jj:  A ─ B ─ C
          └ D
```

## Keeping history sane

The extension's commits are exploration checkpoints. Later, clean them up into meaningful commits with normal jj workflows.

Important: commands that squash, abandon, or rewrite jj history can break old pi tree restores. Tree navigation depends on `.pi/jj-session-checkpoints.json` mapping pi entries to jj change ids. If those jj changes are removed or rewritten away, intermediate file states may no longer be restorable.

Safe extension commands:

```text
/jj-describe Implement feature X
```

Describes the latest checkpoint change. This is equivalent to a targeted `jj describe -r <latest-checkpoint> -m ...`.

```text
/jj-describe -r abc123 Implement feature X
```

Describes a specific checkpoint by pi entry prefix or jj change id prefix.

```text
/jj-forget-checkpoints
```

Clears the pi-entry-to-jj restore mappings without deleting jj history. Use this after you decide you no longer need old pi tree entries to restore intermediate file states.

Normal jj cleanup commands:

Inspect history:

```bash
jj log
jj status
jj diff -r <rev>
```

Rename a useful checkpoint:

```bash
jj describe -r <rev> -m "Implement feature X"
```

Describe the current working-copy change and start a new empty one:

```bash
jj describe -m "Implement feature X"
jj new
```

Squash/fold exploratory checkpoints together:

```bash
jj squash -r <checkpoint> --into <target>
```

Move a bookmark to the final revision:

```bash
jj bookmark set my-feature -r <final-rev>
```

Push to a Git remote from a git-backed jj repo:

```bash
jj git push --bookmark my-feature
```

Recommended cleanup flow:

```bash
jj log
jj diff -r <interesting-rev>
```

Then from pi, describe the useful checkpoint:

```text
/jj-describe -r <interesting-rev> Meaningful commit message
```

Optionally squash/abandon exploratory checkpoints with jj once you no longer need tree restore for those intermediate states:

```bash
jj squash -r <checkpoint> --into <target>
# or
jj abandon <checkpoint>
```

Then clear stale restore mappings:

```text
/jj-forget-checkpoints
```

Finally publish/move bookmarks if desired:

```bash
jj bookmark set my-feature -r <final-rev>
jj git push --bookmark my-feature
```

## Testing

The project includes dependency-free tests:

```bash
npm test
# or
node tests/jj-session.spec.js
```

Validate syntax and tests together:

```bash
npm run check
```

Preview packaged files:

```bash
npm pack --dry-run
```

Current coverage includes:

- extension off by default
- command registration
- no `pi.cwd` dependency
- initialization matrix: no VCS, Git only, jj only, Git+jj, init failure, jj existing-git fallback
- baseline commit behavior
- checkpoint creation
- checkpoint aliasing for leaf and user prompt entries
- jj branch mirroring with `jj new <checkpoint>`
- ancestor checkpoint lookup

## Limitations

- Checkpoint mappings are stored in `.pi/jj-session-checkpoints.json`. If that file is deleted, jj commits remain, but automatic pi-entry-to-jj restore lookup is lost.
- The extension uses jj commands under the hood; if a jj command fails due to conflicts or repository issues, resolve with jj and continue.
- Existing Git repos are supported, but the extension's branch mirroring is jj-first.
