/**
 * JJ Session Extension
 *
 * Off by default. When enabled, initializes/uses jj, checkpoints file state per
 * pi turn, and mirrors pi session branching with jj branches.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import fs from "fs";
import path from "path";

interface JjCheckpoint {
  entryId: string;
  commitId: string;
  description: string;
  timestamp: number;
  named?: boolean;
}

interface CompactedCheckpoint {
  entryId: string;
  commitId: string;
  description: string;
  timestamp: number;
}

let checkpoints = new Map<string, JjCheckpoint>();
let compactedCheckpoints = new Map<string, CompactedCheckpoint>();
let jjEnabled = false;
let autoRestore = true;
let lastStateId: string | undefined;

const STATUS_KEY = "jj-session";

export default function (pi: ExtensionAPI) {
  const cwd = (ctx?: any) => ctx?.cwd ?? process.cwd();

  const settingsPathFor = (ctx?: any) => path.join(cwd(ctx), ".pi", "settings.json");
  const legacyCheckpointsPathFor = (ctx?: any) => path.join(cwd(ctx), ".pi", "jj-session-checkpoints.json");
  const checkpointsPathFor = (ctx?: any) => path.join(cwd(ctx), ".jj", "pi-session-checkpoints.json");

  try {
    const settingsPath = settingsPathFor();
    const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, "utf8")) : {};
    jjEnabled = settings.jjSession?.enabled === true; // off by default
    autoRestore = settings.jjSession?.autoRestore !== false;
  } catch {
    // Defaults above.
  }

  const notify = (ctx: any, message: string, type: "info" | "success" | "warning" | "error" = "info") => {
    if (ctx?.hasUI) ctx.ui.notify(message, type);
  };

  const setStatus = (ctx: any, text?: string, tone: "accent" | "dim" | "warning" = "dim") => {
    if (!ctx?.hasUI) return;
    const styled = text && ctx.ui.theme?.fg ? ctx.ui.theme.fg(tone, text) : text;
    ctx.ui.setStatus?.(STATUS_KEY, styled);
  };

  const saveEnabledSetting = (ctx: any, enabled: boolean) => {
    try {
      const settingsPath = settingsPathFor(ctx);
      const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, "utf8")) : {};
      settings.jjSession = { ...(settings.jjSession ?? {}), enabled };
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    } catch {
      // Runtime toggle still works even if persistence fails.
    }
  };

  const formatExecFailure = (label: string, result: any) => {
    const output = [result?.stderr, result?.stdout].filter(Boolean).join("\n").trim();
    return `${label} failed${output ? `: ${output.slice(0, 300)}` : ""}`;
  };

  const loadCheckpoints = (ctx: any) => {
    try {
      const file = fs.existsSync(checkpointsPathFor(ctx)) ? checkpointsPathFor(ctx) : legacyCheckpointsPathFor(ctx);
      if (!fs.existsSync(file)) return;
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      checkpoints = new Map(Object.entries(data.checkpoints ?? {}) as [string, JjCheckpoint][]);
      compactedCheckpoints = new Map(Object.entries(data.compactedCheckpoints ?? {}) as [string, CompactedCheckpoint][]);
      lastStateId = data.lastStateId;
    } catch {
      // In-memory checkpoints still work if persistence cannot be read.
    }
  };

  const saveCheckpoints = (ctx: any) => {
    try {
      const file = checkpointsPathFor(ctx);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify({
        lastStateId,
        checkpoints: Object.fromEntries(checkpoints),
        compactedCheckpoints: Object.fromEntries(compactedCheckpoints),
      }, null, 2)}\n`);
    } catch {
      // Non-fatal.
    }
  };

  const detectJj = async (ctx: any): Promise<boolean> => {
    try {
      const { code } = await pi.exec("jj", ["status"], { cwd: cwd(ctx) });
      return code === 0;
    } catch {
      return false;
    }
  };

  const hasChanges = async (ctx: any) => {
    const { stdout, code } = await pi.exec("jj", ["status"], { cwd: cwd(ctx) });
    if (code !== 0) return false;
    const text = stdout.trim();
    return !!text && !/(working copy (is )?clean|working copy has no changes)/i.test(text);
  };

  const currentChangeId = async (ctx: any) => {
    const { stdout, code } = await pi.exec("jj", ["log", "-r", "@", "--no-graph", "-T", "change_id.short()"], { cwd: cwd(ctx) });
    if (code !== 0) return undefined;
    return stdout.trim().split(/\s+/)[0];
  };

  const refreshStatus = async (ctx: any) => {
    if (!ctx?.hasUI) return;
    if (!jjEnabled) return setStatus(ctx, "jj off", "dim");
    if (!(await detectJj(ctx))) return setStatus(ctx, "jj · not initialized", "warning");
    const [changeId, dirty] = await Promise.all([currentChangeId(ctx), hasChanges(ctx)]);
    const stateId = lastStateId ?? changeId;
    const shortId = stateId?.slice(0, 8) ?? "unknown";
    setStatus(ctx, dirty ? `jj chg ${shortId} ±` : `jj chg ${shortId} ✓`, dirty ? "warning" : "accent");
  };

  const revisionExists = async (ctx: any, revision: string) => {
    const { code } = await pi.exec("jj", ["log", "-r", revision, "--no-graph", "-T", "change_id.short()"], { cwd: cwd(ctx) });
    return code === 0;
  };

  const markCheckpointMissing = (ctx: any, checkpoint: JjCheckpoint) => {
    for (const [id, existing] of [...checkpoints.entries()]) {
      if (existing.commitId === checkpoint.commitId) {
        checkpoints.delete(id);
        compactedCheckpoints.set(id, { ...existing });
      }
    }
    saveCheckpoints(ctx);
  };

  const pruneMissingCheckpoints = async (ctx: any) => {
    const unique = [...checkpoints.values()]
      .filter((checkpoint, index, all) => all.findIndex((other) => other.commitId === checkpoint.commitId) === index);
    let removed = 0;
    for (const checkpoint of unique) {
      if (!(await revisionExists(ctx, checkpoint.commitId))) {
        markCheckpointMissing(ctx, checkpoint);
        removed++;
      }
    }
    return removed;
  };

  const commitChanges = async (ctx: any, message: string) => {
    await pi.exec("jj", ["commit", "-m", message], { cwd: cwd(ctx) });
    const { stdout } = await pi.exec("jj", ["log", "-r", "@-", "--no-graph", "-T", "change_id.short()"], { cwd: cwd(ctx) });
    return stdout.trim().split(/\s+/)[0];
  };

  const ensureJjRepo = async (ctx: any) => {
    if (await detectJj(ctx)) return true;

    const root = cwd(ctx);
    if (fs.existsSync(path.join(root, ".jj"))) {
      notify(ctx, "A .jj directory exists, but jj status failed", "warning");
      return false;
    }

    const gitRoot = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: root });
    const gitDir = await pi.exec("git", ["rev-parse", "--git-dir"], { cwd: root });
    let initResult: any;

    if (gitRoot.code === 0 && gitDir.code === 0) {
      const gitRootPath = gitRoot.stdout.trim();
      const gitDirPath = path.isAbsolute(gitDir.stdout.trim())
        ? gitDir.stdout.trim()
        : path.join(gitRootPath, gitDir.stdout.trim());
      initResult = await pi.exec("jj", ["git", "init", "--git-repo", gitDirPath, gitRootPath], { cwd: root });
      if (initResult.code !== 0) {
        notify(ctx, formatExecFailure("jj git init --git-repo", initResult), "warning");
        return false;
      }
    } else {
      // Your jj version has no native `jj init`. This creates only .jj/ at the
      // top level; the Git backing store is hidden under .jj/.
      initResult = await pi.exec("jj", ["git", "init", "--no-colocate", root], { cwd: root });
      if (initResult.code !== 0) {
        const output = `${initResult.stderr ?? ""}\n${initResult.stdout ?? ""}`;
        if (/existing Git repo/i.test(output)) {
          initResult = await pi.exec("jj", ["git", "init", "--colocate", root], { cwd: root });
        }
      }
      if (initResult.code !== 0) {
        notify(ctx, formatExecFailure("jj git init", initResult), "warning");
        return false;
      }
    }

    try {
      if (await hasChanges(ctx)) await commitChanges(ctx, "pi session baseline");
    } catch {
      // Non-fatal.
    }

    const ready = await detectJj(ctx);
    if (!ready) notify(ctx, "JJ init completed, but jj status still fails", "warning");
    return ready;
  };

  const restoreCheckpoint = async (checkpoint: JjCheckpoint, ctx: any) => {
    if (!(await ensureJjRepo(ctx))) return;
    if (!(await revisionExists(ctx, checkpoint.commitId))) {
      markCheckpointMissing(ctx, checkpoint);
      notify(ctx, `Cannot restore this checkpoint: jj chg ${checkpoint.commitId.slice(0, 8)} no longer exists`, "warning");
      return;
    }
    try {
      await pi.exec("jj", ["new", checkpoint.commitId], { cwd: cwd(ctx) });
      lastStateId = checkpoint.commitId;
      saveCheckpoints(ctx);
      await refreshStatus(ctx);
      notify(ctx, `Restored files: ${checkpoint.description}`, "success");
    } catch (err: any) {
      notify(ctx, `Restore failed: ${err?.message ?? err}`, "error");
    }
  };

  const latestUserEntryId = (ctx: any): string | undefined => {
    const entries = ctx.sessionManager.getEntries?.() ?? [];
    return [...entries].reverse().find((e: any) => e?.type === "message" && e.message?.role === "user")?.id;
  };

  const latestCheckpoint = () => [...checkpoints.values()].sort((a, b) => b.timestamp - a.timestamp)[0];

  const resolveCheckpoint = (ctx: any, selector?: string): JjCheckpoint | undefined => {
    loadCheckpoints(ctx);
    const query = selector?.trim();
    if (!query) return latestCheckpoint();
    return checkpoints.get(query)
      ?? [...checkpoints.values()].find((c) => c.entryId.startsWith(query) || c.commitId.startsWith(query));
  };

  const findCompactedCheckpointForEntry = (ctx: any, entryId?: string): CompactedCheckpoint | undefined => {
    loadCheckpoints(ctx);
    if (entryId && compactedCheckpoints.has(entryId)) return compactedCheckpoints.get(entryId);

    let cur = entryId;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const entry = ctx.sessionManager.getEntry?.(cur);
      cur = entry?.parentId;
      if (cur && compactedCheckpoints.has(cur)) return compactedCheckpoints.get(cur);
    }
    return undefined;
  };

  const findCheckpointForEntry = (ctx: any, entryId?: string): JjCheckpoint | undefined => {
    loadCheckpoints(ctx);
    if (entryId && checkpoints.has(entryId)) return checkpoints.get(entryId);

    let cur = entryId;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const entry = ctx.sessionManager.getEntry?.(cur);
      cur = entry?.parentId;
      if (cur && checkpoints.has(cur)) return checkpoints.get(cur);
    }

    const pathEntries = ctx.sessionManager.getPath?.() ?? [];
    for (const entry of [...pathEntries].reverse()) {
      const id = typeof entry === "string" ? entry : entry?.id;
      if (id && checkpoints.has(id)) return checkpoints.get(id);
    }
    return undefined;
  };

  const notifyCompactedIfNeeded = (ctx: any, entryId?: string) => {
    const compacted = findCompactedCheckpointForEntry(ctx, entryId);
    if (!compacted) return false;
    notify(ctx, `Cannot restore this pi point: its JJ checkpoint was compacted (${compacted.commitId.slice(0, 8)})`, "warning");
    return true;
  };

  const parseDescribeArgs = (args?: string) => {
    const text = args?.trim() ?? "";
    if (!text) return { message: "" };
    const delimiter = text.indexOf(" -- ");
    if (delimiter >= 0) {
      return { selector: text.slice(0, delimiter).trim(), message: text.slice(delimiter + 4).trim() };
    }
    const revMatch = text.match(/^-r\s+(\S+)\s+(.+)$/s);
    if (revMatch) return { selector: revMatch[1], message: revMatch[2].trim() };
    return { message: text };
  };

  const describeCheckpoint = async (ctx: any, checkpoint: JjCheckpoint, message: string) => {
    if (!(await revisionExists(ctx, checkpoint.commitId))) {
      markCheckpointMissing(ctx, checkpoint);
      notify(ctx, `Cannot describe this checkpoint: jj chg ${checkpoint.commitId.slice(0, 8)} no longer exists`, "warning");
      return false;
    }
    const result = await pi.exec("jj", ["describe", "-r", checkpoint.commitId, "-m", message], { cwd: cwd(ctx) });
    if (result.code !== 0) {
      notify(ctx, formatExecFailure("jj describe", result), "warning");
      return false;
    }

    const updated = { ...checkpoint, description: message, named: true };
    for (const [id, existing] of checkpoints.entries()) {
      if (existing.commitId === checkpoint.commitId) checkpoints.set(id, { ...updated, entryId: id });
    }
    saveCheckpoints(ctx);
    await refreshStatus(ctx);
    notify(ctx, `Described jj chg ${checkpoint.commitId.slice(0, 8)}: ${message.slice(0, 60)}`, "success");
    return true;
  };

  pi.on("session_start", async (_event, ctx) => {
    loadCheckpoints(ctx);
    await refreshStatus(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (!jjEnabled) {
      setStatus(ctx, "jj off", "dim");
      return;
    }

    try {
      if (!(await ensureJjRepo(ctx))) return;
      if (!(await hasChanges(ctx))) return;

      const entryId = ctx.sessionManager.getLeafEntry()?.id;
      if (!entryId) return;

      const description = `pi checkpoint ${entryId.slice(0, 8)}`;
      const commitId = await commitChanges(ctx, description);
      if (!commitId) return;

      lastStateId = commitId;
      const checkpoint = { entryId, commitId, description, timestamp: Date.now() };
      checkpoints.set(entryId, checkpoint);

      const userEntryId = latestUserEntryId(ctx);
      if (userEntryId && userEntryId !== entryId) checkpoints.set(userEntryId, { ...checkpoint, entryId: userEntryId });
      saveCheckpoints(ctx);

      notify(ctx, `JJ checkpoint chg ${commitId.slice(0, 8)}`, "info");
    } catch (err: any) {
      notify(ctx, `JJ checkpoint failed: ${err?.message ?? err}`, "warning");
    } finally {
      await refreshStatus(ctx);
    }
  });

  pi.on("session_tree", async (event: any, ctx) => {
    if (!jjEnabled || !autoRestore) return;
    const checkpoint = findCheckpointForEntry(ctx, event.newLeafId);
    if (checkpoint) await restoreCheckpoint(checkpoint, ctx);
    else notifyCompactedIfNeeded(ctx, event.newLeafId);
  });

  pi.on("session_before_fork", async (event: any, ctx) => {
    if (!jjEnabled || !autoRestore) return;
    const checkpoint = findCheckpointForEntry(ctx, event.entryId);
    if (checkpoint) await restoreCheckpoint(checkpoint, ctx);
    else notifyCompactedIfNeeded(ctx, event.entryId);
  });

  pi.registerCommand("jj-checkpoints", {
    description: "List jj checkpoints for this pi runtime",
    handler: async (_args, ctx) => {
      if (!jjEnabled) return notify(ctx, "JJ Session extension is disabled", "info");
      loadCheckpoints(ctx);
      if (await ensureJjRepo(ctx)) await pruneMissingCheckpoints(ctx);
      if (checkpoints.size === 0) return notify(ctx, "No JJ checkpoints yet", "info");
      const unique = [...checkpoints.values()]
        .sort((a, b) => a.timestamp - b.timestamp)
        .filter((checkpoint, index, all) => all.findIndex((other) => other.commitId === checkpoint.commitId) === index);
      const rows = unique.map((c) => `${c.named ? "★" : "·"} ${c.commitId.slice(0, 8)}  ${c.description}`);
      if (ctx?.hasUI && ctx.ui.select) {
        const selected = await ctx.ui.select(`JJ checkpoints (${rows.length})`, [...rows, "Close"]);
        if (!selected || selected === "Close") return;
        const index = rows.indexOf(selected);
        const checkpoint = unique[index];
        if (!checkpoint) return;
        const action = await ctx.ui.select(`JJ ${checkpoint.commitId.slice(0, 8)}`, ["Describe", "Restore", "Close"]);
        if (action === "Describe") {
          const message = await ctx.ui.input?.("Describe checkpoint", checkpoint.named ? checkpoint.description : "");
          if (message?.trim()) await describeCheckpoint(ctx, checkpoint, message.trim());
        } else if (action === "Restore") {
          await restoreCheckpoint(checkpoint, ctx);
        }
      } else {
        notify(ctx, `Found ${rows.length} JJ checkpoint(s)`, "info");
      }
    },
  });

  pi.registerCommand("jj-restore", {
    description: "Restore files from a checkpoint (entry id/change id or latest)",
    handler: async (args, ctx) => {
      if (!jjEnabled) return notify(ctx, "JJ Session extension is disabled", "info");
      const checkpoint = resolveCheckpoint(ctx, args);
      if (!checkpoint) return notify(ctx, "No matching JJ checkpoint", "error");
      await restoreCheckpoint(checkpoint, ctx);
    },
  });

  pi.registerCommand("jj-describe", {
    description: "Describe a checkpoint change: /jj-describe [-r id] message",
    handler: async (args, ctx) => {
      if (!jjEnabled) return notify(ctx, "JJ Session extension is disabled", "info");
      if (!(await ensureJjRepo(ctx))) return;
      loadCheckpoints(ctx);
      await pruneMissingCheckpoints(ctx);
      const { selector, message } = parseDescribeArgs(args);
      if (!message) return notify(ctx, "Usage: /jj-describe [-r entry-or-change] <message>", "info");
      const checkpoint = resolveCheckpoint(ctx, selector);
      if (!checkpoint) return notify(ctx, "No matching JJ checkpoint", "error");

      await describeCheckpoint(ctx, checkpoint, message);
    },
  });

  pi.registerCommand("jj-compact", {
    description: "Abandon unnamed checkpoint changes and keep only /jj-describe points",
    handler: async (args, ctx) => {
      if (!jjEnabled) return notify(ctx, "JJ Session extension is disabled", "info");
      if (!(await ensureJjRepo(ctx))) return;
      loadCheckpoints(ctx);

      if (await hasChanges(ctx)) {
        return notify(ctx, "Cannot compact while the jj working copy has uncheckpointed changes", "warning");
      }

      const unique = [...checkpoints.values()]
        .sort((a, b) => a.timestamp - b.timestamp)
        .filter((checkpoint, index, all) => all.findIndex((other) => other.commitId === checkpoint.commitId) === index);
      const keep = unique.filter((checkpoint) => checkpoint.named);
      const discard = unique.filter((checkpoint) => !checkpoint.named);

      if (keep.length === 0) return notify(ctx, "No named checkpoints yet. Use /jj-describe first.", "warning");
      if (discard.length === 0) return notify(ctx, "No unnamed checkpoints to compact", "info");

      const force = /(^|\s)--yes(\s|$)/.test(args ?? "");
      if (!force && ctx?.hasUI && ctx.ui.confirm) {
        const ok = await ctx.ui.confirm(
          "Compact JJ checkpoints?",
          `This keeps ${keep.length} named checkpoint(s), abandons ${discard.length} unnamed checkpoint change(s), and removes intermediate pi restore points.`
        );
        if (!ok) return notify(ctx, "Skipped JJ compact", "info");
      }

      const result = await pi.exec("jj", ["abandon", "--restore-descendants", ...discard.map((checkpoint) => checkpoint.commitId)], { cwd: cwd(ctx) });
      if (result.code !== 0) return notify(ctx, formatExecFailure("jj compact", result), "warning");

      for (const [id, checkpoint] of checkpoints.entries()) {
        if (!checkpoint.named) compactedCheckpoints.set(id, { ...checkpoint });
      }
      checkpoints = new Map([...checkpoints.entries()].filter(([, checkpoint]) => checkpoint.named));
      lastStateId = latestCheckpoint()?.commitId;
      saveCheckpoints(ctx);
      await refreshStatus(ctx);
      notify(ctx, `Compacted JJ checkpoints: kept ${keep.length}, removed ${discard.length}`, "success");
    },
  });

  pi.registerCommand("jj-forget-checkpoints", {
    description: "Forget pi-to-jj restore mappings without changing jj history",
    handler: async (args, ctx) => {
      if (!jjEnabled) return notify(ctx, "JJ Session extension is disabled", "info");
      const force = /(^|\s)--yes(\s|$)/.test(args ?? "");
      if (!force && ctx?.hasUI && ctx.ui.confirm) {
        const ok = await ctx.ui.confirm(
          "Forget JJ checkpoints?",
          "This clears pi tree restore mappings, but does not delete jj commits. Old tree entries may no longer restore file states."
        );
        if (!ok) return notify(ctx, "Kept JJ checkpoints", "info");
      }
      checkpoints.clear();
      compactedCheckpoints.clear();
      lastStateId = undefined;
      try {
        fs.rmSync(checkpointsPathFor(ctx), { force: true });
        fs.rmSync(legacyCheckpointsPathFor(ctx), { force: true });
      } catch {
        // Non-fatal.
      }
      await refreshStatus(ctx);
      notify(ctx, "Forgot JJ checkpoint mappings", "success");
    },
  });

  pi.registerCommand("jj-sync", {
    description: "Restore files to the nearest checkpoint on the current session path",
    handler: async (_args, ctx) => {
      if (!jjEnabled) return notify(ctx, "JJ Session extension is disabled", "info");
      const entryId = ctx.sessionManager.getLeafEntry()?.id;
      const checkpoint = findCheckpointForEntry(ctx, entryId);
      if (!checkpoint) {
        if (notifyCompactedIfNeeded(ctx, entryId)) return;
        return notify(ctx, "No JJ checkpoint on current session path", "warning");
      }
      await restoreCheckpoint(checkpoint, ctx);
    },
  });

  pi.registerCommand("jj-init", {
    description: "Initialize jj for this project if needed",
    handler: async (_args, ctx) => {
      const ready = await ensureJjRepo(ctx);
      await refreshStatus(ctx);
      notify(ctx, ready ? "JJ repository ready" : "JJ repository initialization failed", ready ? "success" : "warning");
    },
  });

  pi.registerCommand("jj-toggle", {
    description: "Toggle jj session checkpointing",
    handler: async (_args, ctx) => {
      jjEnabled = !jjEnabled;
      saveEnabledSetting(ctx, jjEnabled);
      if (jjEnabled) {
        const ready = await ensureJjRepo(ctx);
        await refreshStatus(ctx);
        notify(ctx, ready ? "JJ Session: enabled" : "JJ Session: enabled, but jj init failed", ready ? "info" : "warning");
      } else {
        setStatus(ctx, "jj off", "dim");
        notify(ctx, "JJ Session: disabled", "info");
      }
    },
  });
}
