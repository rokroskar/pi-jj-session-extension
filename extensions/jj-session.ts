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
}

let checkpoints = new Map<string, JjCheckpoint>();
let jjEnabled = false;
let autoRestore = true;
let pendingContent: string | undefined;

export default function (pi: ExtensionAPI) {
  const cwd = (ctx?: any) => ctx?.cwd ?? process.cwd();

  const settingsPathFor = (ctx?: any) => path.join(cwd(ctx), ".pi", "settings.json");

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
    return !!text && !/working copy (is )?clean/i.test(text);
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
    try {
      await pi.exec("jj", ["new", checkpoint.commitId], { cwd: cwd(ctx) });
      notify(ctx, `Restored files: ${checkpoint.description}`, "success");
    } catch (err: any) {
      notify(ctx, `Restore failed: ${err?.message ?? err}`, "error");
    }
  };

  const latestUserEntryId = (ctx: any): string | undefined => {
    const entries = ctx.sessionManager.getEntries?.() ?? [];
    return [...entries].reverse().find((e: any) => e?.type === "message" && e.message?.role === "user")?.id;
  };

  const findCheckpointForEntry = (ctx: any, entryId?: string): JjCheckpoint | undefined => {
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

  pi.on("message_start", (event: any) => {
    if (!jjEnabled || event.message?.role !== "user") return;
    const content = event.message.content;
    const text = Array.isArray(content)
      ? content.map((c: any) => (c.type === "text" ? c.text : "")).join("\n")
      : String(content ?? "");
    pendingContent = text.trim().split("\n")[0].slice(0, 60);
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (!jjEnabled) return;
    const content = pendingContent;
    pendingContent = undefined;

    try {
      if (!(await ensureJjRepo(ctx))) return;
      if (!(await hasChanges(ctx))) return;

      const entryId = ctx.sessionManager.getLeafEntry()?.id;
      if (!entryId) return;

      const description = content ? `pi session: ${content}` : `pi session: ${entryId.slice(0, 8)}`;
      const commitId = await commitChanges(ctx, description);
      if (!commitId) return;

      const checkpoint = { entryId, commitId, description, timestamp: Date.now() };
      checkpoints.set(entryId, checkpoint);

      const userEntryId = latestUserEntryId(ctx);
      if (userEntryId && userEntryId !== entryId) checkpoints.set(userEntryId, { ...checkpoint, entryId: userEntryId });

      notify(ctx, `JJ checkpoint: ${description.replace(/^pi session: /, "").slice(0, 48)}`, "info");
    } catch (err: any) {
      notify(ctx, `JJ checkpoint failed: ${err?.message ?? err}`, "warning");
    }
  });

  pi.on("session_tree", async (event: any, ctx) => {
    if (!jjEnabled || !autoRestore) return;
    const checkpoint = findCheckpointForEntry(ctx, event.newLeafId);
    if (checkpoint) await restoreCheckpoint(checkpoint, ctx);
  });

  pi.on("session_before_fork", async (event: any, ctx) => {
    if (!jjEnabled || !autoRestore) return;
    const checkpoint = findCheckpointForEntry(ctx, event.entryId);
    if (checkpoint) await restoreCheckpoint(checkpoint, ctx);
  });

  pi.registerCommand("jj-checkpoints", {
    description: "List jj checkpoints for this pi runtime",
    handler: async (_args, ctx) => {
      if (!jjEnabled) return notify(ctx, "JJ Session extension is disabled", "info");
      if (checkpoints.size === 0) return notify(ctx, "No JJ checkpoints yet", "info");
      const unique = [...checkpoints.values()]
        .sort((a, b) => a.timestamp - b.timestamp)
        .filter((checkpoint, index, all) => all.findIndex((other) => other.commitId === checkpoint.commitId) === index);
      const rows = unique.map((c) => `${c.entryId.slice(0, 8)}  ${c.commitId.slice(0, 12)}  ${c.description}`);
      console.log(`\n[JJ] Checkpoints (${rows.length})\n${rows.join("\n")}`);
      notify(ctx, `Found ${rows.length} JJ checkpoint(s)`, "info");
    },
  });

  pi.registerCommand("jj-restore", {
    description: "Restore files from a checkpoint (entry id or latest)",
    handler: async (args, ctx) => {
      if (!jjEnabled) return notify(ctx, "JJ Session extension is disabled", "info");
      const requested = args?.trim();
      const checkpoint = requested
        ? checkpoints.get(requested) ?? [...checkpoints.values()].find((c) => c.entryId.startsWith(requested))
        : [...checkpoints.values()].sort((a, b) => b.timestamp - a.timestamp)[0];
      if (!checkpoint) return notify(ctx, "No matching JJ checkpoint", "error");
      await restoreCheckpoint(checkpoint, ctx);
    },
  });

  pi.registerCommand("jj-sync", {
    description: "Restore files to the nearest checkpoint on the current session path",
    handler: async (_args, ctx) => {
      if (!jjEnabled) return notify(ctx, "JJ Session extension is disabled", "info");
      const checkpoint = findCheckpointForEntry(ctx, ctx.sessionManager.getLeafEntry()?.id);
      if (!checkpoint) return notify(ctx, "No JJ checkpoint on current session path", "warning");
      await restoreCheckpoint(checkpoint, ctx);
    },
  });

  pi.registerCommand("jj-init", {
    description: "Initialize jj for this project if needed",
    handler: async (_args, ctx) => {
      const ready = await ensureJjRepo(ctx);
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
        notify(ctx, ready ? "JJ Session: enabled" : "JJ Session: enabled, but jj init failed", ready ? "info" : "warning");
      } else {
        notify(ctx, "JJ Session: disabled", "info");
      }
    },
  });
}
