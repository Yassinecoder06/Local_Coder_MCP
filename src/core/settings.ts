/**
 * Owned by agy1. Persisted settings in DATA_DIR/settings.json.
 * Settings override environment variables.
 */
import fs from "node:fs";
import path from "node:path";

export interface Settings {
  disabledTools: string[];
  disabledSkills: string[];
  approvalMode?: "trust" | "minimal" | "standard";
  toolProfile?: "essential" | "full";
  lastWorkspace?: string;
  lastWorkspaceByClient?: Record<string, string>;
  workspaceRoots?: string[];
  defaultWorkspace?: string;
}

let activeSettings: Settings = {
  disabledTools: [],
  disabledSkills: [],
};

let settingsFilePath: string | null = null;

export function initSettings(dataDir: string, defaults?: Partial<Settings>): Settings {
  settingsFilePath = path.join(dataDir, "settings.json");
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    if (fs.existsSync(settingsFilePath)) {
      const raw = fs.readFileSync(settingsFilePath, "utf-8");
      const parsed = JSON.parse(raw);
      activeSettings = {
        disabledTools: Array.isArray(parsed.disabledTools) ? parsed.disabledTools : [],
        disabledSkills: Array.isArray(parsed.disabledSkills) ? parsed.disabledSkills : [],
        approvalMode: parsed.approvalMode ?? defaults?.approvalMode,
        toolProfile: parsed.toolProfile ?? defaults?.toolProfile,
        lastWorkspace: parsed.lastWorkspace ?? defaults?.lastWorkspace,
        lastWorkspaceByClient: parsed.lastWorkspaceByClient && typeof parsed.lastWorkspaceByClient === "object" ? parsed.lastWorkspaceByClient : defaults?.lastWorkspaceByClient,
        workspaceRoots: Array.isArray(parsed.workspaceRoots) ? parsed.workspaceRoots : defaults?.workspaceRoots,
        defaultWorkspace: typeof parsed.defaultWorkspace === "string" ? parsed.defaultWorkspace : defaults?.defaultWorkspace,
      };
      return activeSettings;
    }
  } catch (err) {
    console.warn("[settings] Failed to load settings.json, using defaults:", err);
  }

  activeSettings = {
    disabledTools: defaults?.disabledTools ?? [],
    disabledSkills: defaults?.disabledSkills ?? [],
    approvalMode: defaults?.approvalMode,
    toolProfile: defaults?.toolProfile,
    lastWorkspace: defaults?.lastWorkspace,
    lastWorkspaceByClient: defaults?.lastWorkspaceByClient,
    workspaceRoots: defaults?.workspaceRoots,
    defaultWorkspace: defaults?.defaultWorkspace,
  };
  saveSettingsSync();
  return activeSettings;
}

function saveSettingsSync(): void {
  if (!settingsFilePath) return;
  try {
    fs.mkdirSync(path.dirname(settingsFilePath), { recursive: true });
    const tmp = `${settingsFilePath}.tmp.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(activeSettings, null, 2), "utf-8");
    fs.renameSync(tmp, settingsFilePath);
  } catch (err) {
    console.error("[settings] Failed to persist settings:", err);
  }
}

export function getSettings(): Settings {
  return {
    disabledTools: [...activeSettings.disabledTools],
    disabledSkills: [...activeSettings.disabledSkills],
    approvalMode: activeSettings.approvalMode,
    toolProfile: activeSettings.toolProfile,
    lastWorkspace: activeSettings.lastWorkspace,
    lastWorkspaceByClient: activeSettings.lastWorkspaceByClient ? { ...activeSettings.lastWorkspaceByClient } : undefined,
    workspaceRoots: activeSettings.workspaceRoots ? [...activeSettings.workspaceRoots] : undefined,
    defaultWorkspace: activeSettings.defaultWorkspace,
  };
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  activeSettings = {
    disabledTools: patch.disabledTools !== undefined ? [...patch.disabledTools] : activeSettings.disabledTools,
    disabledSkills: patch.disabledSkills !== undefined ? [...patch.disabledSkills] : activeSettings.disabledSkills,
    approvalMode: patch.approvalMode !== undefined ? patch.approvalMode : activeSettings.approvalMode,
    toolProfile: patch.toolProfile !== undefined ? patch.toolProfile : activeSettings.toolProfile,
    lastWorkspace: "lastWorkspace" in patch ? patch.lastWorkspace : activeSettings.lastWorkspace,
    lastWorkspaceByClient: "lastWorkspaceByClient" in patch ? (patch.lastWorkspaceByClient ? { ...patch.lastWorkspaceByClient } : undefined) : activeSettings.lastWorkspaceByClient,
    workspaceRoots: "workspaceRoots" in patch ? (patch.workspaceRoots ? [...patch.workspaceRoots] : undefined) : activeSettings.workspaceRoots,
    defaultWorkspace: "defaultWorkspace" in patch ? patch.defaultWorkspace : activeSettings.defaultWorkspace,
  };
  saveSettingsSync();
  return getSettings();
}
