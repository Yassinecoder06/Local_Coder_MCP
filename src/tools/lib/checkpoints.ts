import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isUtf8 } from "node:buffer";
import type { AppConfig } from "../../config.js";

export interface CheckpointFileSnapshot {
  path: string;
  existed: boolean;
  is_directory?: boolean;
  encoding?: "utf-8" | "base64";
  content?: string;
  children?: CheckpointFileSnapshot[];
  skipped?: boolean;
  skip_reason?: string;
}

export interface CheckpointSummary {
  id: string;
  workspace?: string;
  created_at: string;
  tool: string;
  summary: string;
  files: string[];
  file_count: number;
}

export interface CheckpointManifest {
  version: 1;
  id: string;
  created_at: string;
  tool: string;
  summary: string;
  files: CheckpointFileSnapshot[];
}

interface CheckpointIndex {
  version: 1;
  checkpoints: CheckpointSummary[];
}

const INDEX_VERSION = 1 as const;
const MAX_CHECKPOINTS = 200;
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_DIR_DEPTH = 8;

function getStoreRoot(config: AppConfig): string {
  return path.join(config.dataDir, "checkpoints");
}

function checkpointDir(config: AppConfig, id: string): string {
  return path.join(getStoreRoot(config), "data", id);
}

function indexPath(config: AppConfig): string {
  return path.join(getStoreRoot(config), "index.json");
}

function manifestPath(config: AppConfig, id: string): string {
  return path.join(checkpointDir(config, id), "manifest.json");
}

async function readIndex(config: AppConfig): Promise<CheckpointIndex> {
  try {
    const raw = await fs.readFile(indexPath(config), "utf-8");
    const parsed = JSON.parse(raw) as CheckpointIndex;
    if (parsed.version === INDEX_VERSION && Array.isArray(parsed.checkpoints)) {
      return parsed;
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // Ignore corrupt index and return clean state
    }
  }
  return { version: INDEX_VERSION, checkpoints: [] };
}

async function writeIndex(config: AppConfig, index: CheckpointIndex): Promise<void> {
  const root = getStoreRoot(config);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(indexPath(config), JSON.stringify(index, null, 2), "utf-8");
}

async function snapshotFile(filePath: string): Promise<CheckpointFileSnapshot> {
  const resolved = path.resolve(filePath);
  try {
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) {
      return snapshotDirectory(resolved, 0);
    }
    if (stat.size > MAX_FILE_BYTES) {
      return {
        path: resolved,
        existed: true,
        skipped: true,
        skip_reason: `file size exceeds ${MAX_FILE_BYTES} bytes (${stat.size} bytes)`,
      };
    }
    const buf = await fs.readFile(resolved);
    if (isUtf8(buf)) {
      return { path: resolved, existed: true, encoding: "utf-8", content: buf.toString("utf-8") };
    }
    return { path: resolved, existed: true, encoding: "base64", content: buf.toString("base64") };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { path: resolved, existed: false };
    }
    throw err;
  }
}

async function snapshotDirectory(dirPath: string, depth: number): Promise<CheckpointFileSnapshot> {
  if (depth > MAX_DIR_DEPTH) {
    return {
      path: dirPath,
      existed: true,
      is_directory: true,
      skipped: true,
      skip_reason: `directory depth exceeds ${MAX_DIR_DEPTH}`,
      children: [],
    };
  }

  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const children: CheckpointFileSnapshot[] = [];

  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      children.push(await snapshotDirectory(full, depth + 1));
    } else if (entry.isFile()) {
      children.push(await snapshotFile(full));
    }
  }

  return { path: dirPath, existed: true, is_directory: true, children };
}

async function restoreSnapshot(snapshot: CheckpointFileSnapshot): Promise<void> {
  const target = snapshot.path;

  if (!snapshot.existed) {
    try {
      const stat = await fs.stat(target);
      if (stat.isDirectory()) {
        await fs.rm(target, { recursive: true, force: true });
      } else {
        await fs.unlink(target);
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return;
  }

  if (snapshot.skipped) {
    throw new Error(`Cannot restore skipped snapshot for ${target}: ${snapshot.skip_reason ?? "unknown reason"}`);
  }

  if (snapshot.is_directory) {
    await fs.mkdir(target, { recursive: true });
    for (const child of snapshot.children ?? []) {
      await restoreSnapshot(child);
    }
    return;
  }

  await fs.mkdir(path.dirname(target), { recursive: true });
  const buffer =
    snapshot.encoding === "base64"
      ? Buffer.from(snapshot.content ?? "", "base64")
      : Buffer.from(snapshot.content ?? "", "utf-8");
  await fs.writeFile(target, buffer);
}

export async function createCheckpoint(
  config: AppConfig,
  tool: string,
  summary: string,
  filePaths: string[],
  workspace?: string
): Promise<string | undefined> {
  if (!config.checkpoints) return undefined;
  if (filePaths.length === 0) return undefined;

  const id = `cp_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`;
  const dir = checkpointDir(config, id);
  await fs.mkdir(dir, { recursive: true });

  const uniquePaths = Array.from(new Set(filePaths.map((p) => path.resolve(p))));
  const snapshots: CheckpointFileSnapshot[] = [];

  for (const p of uniquePaths) {
    snapshots.push(await snapshotFile(p));
  }

  const manifest: CheckpointManifest = {
    version: INDEX_VERSION,
    id,
    created_at: new Date().toISOString(),
    tool,
    summary,
    files: snapshots,
  };

  await fs.writeFile(manifestPath(config, id), JSON.stringify(manifest, null, 2), "utf-8");

  const index = await readIndex(config);
  index.checkpoints.unshift({
    id,
    ...(workspace ? { workspace: path.resolve(workspace) } : {}),
    created_at: manifest.created_at,
    tool,
    summary,
    files: uniquePaths,
    file_count: uniquePaths.length,
  });

  // Prune old checkpoints
  if (index.checkpoints.length > MAX_CHECKPOINTS) {
    const removed = index.checkpoints.splice(MAX_CHECKPOINTS);
    for (const item of removed) {
      await fs.rm(checkpointDir(config, item.id), { recursive: true, force: true }).catch(() => {});
    }
  }

  await writeIndex(config, index);
  return id;
}

export async function restoreCheckpoint(
  config: AppConfig,
  checkpointId: string
): Promise<{ id: string; restoredFiles: string[] }> {
  const mPath = manifestPath(config, checkpointId);
  let raw: string;
  try {
    raw = await fs.readFile(mPath, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Checkpoint "${checkpointId}" not found`);
    }
    throw err;
  }

  const manifest = JSON.parse(raw) as CheckpointManifest;
  const restoredFiles: string[] = [];

  for (const snapshot of manifest.files) {
    await restoreSnapshot(snapshot);
    restoredFiles.push(snapshot.path);
  }

  return { id: manifest.id, restoredFiles };
}

export async function listCheckpoints(config: AppConfig, limit = 10): Promise<CheckpointSummary[]> {
  const index = await readIndex(config);
  return index.checkpoints.slice(0, limit);
}
