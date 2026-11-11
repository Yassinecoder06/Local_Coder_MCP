import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";
import { getSettings, updateSettings } from "./settings.js";
import { resolveWorkspaces, isPathInsideRoots } from "./workspace.js";

export interface JanitorRun {
  at: string;
  cleaned: number;
  settings: number;
  checkpoints: number;
  orphanedPlans: number;
}

let lastRun: JanitorRun | undefined;

export function getJanitorLastRun(): JanitorRun | undefined {
  return lastRun ? { ...lastRun } : undefined;
}

async function existsDirectory(folder: unknown): Promise<boolean> {
  if (typeof folder !== "string" || !path.isAbsolute(folder)) return false;
  try { return (await fs.stat(folder)).isDirectory(); } catch { return false; }
}

async function atomicJson(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tmp, file);
}

function oldCheckpointWorkspace(files: unknown): string | undefined {
  if (!Array.isArray(files) || files.length === 0 || files.some((file) => typeof file !== "string")) return undefined;
  const paths = files as string[];
  let common = path.dirname(path.resolve(paths[0]));
  for (const file of paths.slice(1)) {
    const target = path.dirname(path.resolve(file));
    while (common !== path.dirname(common) && target !== common && !target.startsWith(common + path.sep)) common = path.dirname(common);
  }
  return common;
}

async function pruneCheckpoints(dataDir: string): Promise<number> {
  const root = path.join(dataDir, "checkpoints");
  const indexFile = path.join(root, "index.json");
  let index: { version: number; checkpoints: Array<Record<string, unknown>> };
  try {
    const parsed = JSON.parse(await fs.readFile(indexFile, "utf8"));
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.checkpoints)) return 0;
    index = parsed;
  } catch { return 0; }

  const keep: Array<Record<string, unknown>> = [];
  const removed: Array<Record<string, unknown>> = [];
  for (const item of index.checkpoints) {
    if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.id !== "string") {
      keep.push(item);
      continue;
    }
    const workspace = typeof item.workspace === "string" ? item.workspace : oldCheckpointWorkspace(item.files);
    if (workspace && !(await existsDirectory(workspace))) removed.push(item);
    else keep.push(item);
  }
  if (!removed.length) return 0;
  await atomicJson(indexFile, { ...index, checkpoints: keep });
  for (const item of removed) {
    if (typeof item.id === "string" && /^[\w-]+$/.test(item.id)) {
      await fs.rm(path.join(root, "data", item.id), { recursive: true, force: true }).catch(() => {});
    }
  }
  return removed.length;
}

async function markOrphanedPlans(dataDir: string): Promise<number> {
  const dir = path.join(dataDir, "agent");
  let names: string[];
  try { names = await fs.readdir(dir); } catch { return 0; }
  let marked = 0;
  for (const name of names.filter((entry) => entry.endsWith(".json"))) {
    const file = path.join(dir, name);
    try {
      const plan = JSON.parse(await fs.readFile(file, "utf8"));
      if (typeof plan.workspace !== "string" || !Array.isArray(plan.todos)) continue;
      const orphaned = !(await existsDirectory(plan.workspace));
      if (Boolean(plan.orphaned) !== orphaned) {
        await atomicJson(file, { ...plan, orphaned });
        if (orphaned) marked++;
      }
    } catch { /* Leave unreadable plans untouched. */ }
  }
  return marked;
}

export async function runStateJanitor(config: AppConfig): Promise<JanitorRun> {
  let settingsCleaned = 0;
  const settings = getSettings();
  const roots = resolveWorkspaces(config, settings).roots;
  const valid = async (folder: unknown) => (await existsDirectory(folder)) && isPathInsideRoots(String(folder), roots);
  const patch: { lastWorkspace?: string; lastWorkspaceByClient?: Record<string, string> | undefined } = {};
  if (settings.lastWorkspace && !(await valid(settings.lastWorkspace))) {
    patch.lastWorkspace = undefined;
    settingsCleaned++;
  }
  const clients = settings.lastWorkspaceByClient;
  if (clients && typeof clients === "object") {
    const kept: Record<string, string> = {};
    for (const [client, folder] of Object.entries(clients)) {
      if (await valid(folder)) kept[client] = folder;
      else settingsCleaned++;
    }
    if (settingsCleaned > (settings.lastWorkspace && !(await valid(settings.lastWorkspace)) ? 1 : 0)) {
      patch.lastWorkspaceByClient = kept;
    }
  }
  if (Object.keys(patch).length) await updateSettings(patch);

  const checkpoints = await pruneCheckpoints(config.dataDir).catch(() => 0);
  const orphanedPlans = await markOrphanedPlans(config.dataDir);
  const run: JanitorRun = {
    at: new Date().toISOString(),
    cleaned: settingsCleaned + checkpoints,
    settings: settingsCleaned,
    checkpoints,
    orphanedPlans,
  };
  lastRun = run;
  console.log(`[janitor] cleaned ${run.cleaned} stale entries (${settingsCleaned} settings, ${checkpoints} checkpoints); marked ${orphanedPlans} plans orphaned at ${run.at}`);
  return { ...run };
}

export async function startStateJanitor(config: AppConfig): Promise<ReturnType<typeof setInterval>> {
  await runStateJanitor(config);
  const timer = setInterval(() => { void runStateJanitor(config).catch((err) => console.warn("[janitor] run failed:", err)); }, 6 * 60 * 60 * 1000);
  timer.unref();
  return timer;
}
