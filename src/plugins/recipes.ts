/**
 * Owned by agy2. Plugin recipes loader and input converter.
 * Loads curated, pinned plugin recipes and transforms them into PluginInput with secrets applied.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { loadConfig } from "../config.js";
import type { PluginInput, PluginRecipe, PluginTransport } from "../core/plugins.js";

const pluginTransportSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("stdio"),
    command: z.string(),
    args: z.array(z.string()),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
  }),
  z.object({
    type: z.literal("http"),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
]);

const pluginRecipeSecretSchema = z.object({
  key: z.string(),
  where: z.enum(["env", "header"]),
  label: z.string(),
  required: z.boolean(),
  help: z.string().optional(),
  prefix: z.string().optional(),
});

export const pluginRecipeSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/).max(40),
  name: z.string(),
  description: z.string(),
  homepage: z.string(),
  transport: pluginTransportSchema,
  secrets: z.array(pluginRecipeSecretSchema),
  runtime: z.enum(["node", "uv", "none"]),
  notes: z.string().optional(),
});

export const pluginRecipesArraySchema = z.array(pluginRecipeSchema);

/**
 * Checks whether all packages referenced in a recipe transport have pinned versions.
 * Disallows "latest", wildcards, and semver range prefixes (^, ~, >, <).
 */
export function isVersionPinned(recipe: PluginRecipe): boolean {
  if (recipe.transport.type === "http") {
    return true;
  }
  for (const arg of recipe.transport.args) {
    if (arg.includes("@") && !arg.startsWith("-")) {
      const atIdx = arg.lastIndexOf("@");
      if (atIdx > 0) {
        const versionPart = arg.slice(atIdx + 1);
        if (versionPart === "latest" || /[\^~><*]/.test(versionPart)) {
          return false;
        }
      }
    }
  }
  return true;
}

/**
 * Load and validate plugin recipes from the given directory (defaulting to builtinPluginsDir).
 */
export async function loadRecipes(dir?: string): Promise<PluginRecipe[]> {
  const pluginsDir = dir ? path.resolve(dir) : loadConfig().builtinPluginsDir;
  const filePath = path.join(pluginsDir, "recipes.json");

  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    throw new Error(`Failed to load recipes file at ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in recipes file at ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const recipes = pluginRecipesArraySchema.parse(parsed);

  const seenIds = new Set<string>();
  for (const r of recipes) {
    if (seenIds.has(r.id)) {
      throw new Error(`Duplicate recipe id: "${r.id}"`);
    }
    seenIds.add(r.id);

    if (!isVersionPinned(r)) {
      throw new Error(`Recipe "${r.id}" does not have pinned package versions in its transport args`);
    }
  }

  return recipes;
}

/**
 * Converts a PluginRecipe into a PluginInput by filling secrets and applying prefixes.
 * Throws if a required secret is missing.
 */
export function recipeToInput(
  recipe: PluginRecipe,
  secrets: Record<string, string> = {}
): PluginInput {
  for (const s of recipe.secrets) {
    if (s.required) {
      const val = secrets[s.key]?.trim();
      if (!val) {
        throw new Error(`Missing required secret: ${s.key} (${s.label})`);
      }
    }
  }

  let transport: PluginTransport;

  if (recipe.transport.type === "stdio") {
    const env: Record<string, string> = { ...(recipe.transport.env ?? {}) };
    for (const s of recipe.secrets) {
      if (s.where === "env") {
        const val = secrets[s.key]?.trim();
        if (val) {
          const prefix = s.prefix ?? "";
          env[s.key] = val.startsWith(prefix) ? val : `${prefix}${val}`;
        }
      }
    }
    transport = {
      ...recipe.transport,
      env: Object.keys(env).length > 0 ? env : undefined,
    };
  } else {
    const headers: Record<string, string> = { ...(recipe.transport.headers ?? {}) };
    for (const s of recipe.secrets) {
      if (s.where === "header") {
        const val = secrets[s.key]?.trim();
        if (val) {
          const prefix = s.prefix ?? "";
          headers[s.key] = val.startsWith(prefix) ? val : `${prefix}${val}`;
        }
      }
    }
    transport = {
      ...recipe.transport,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
    };
  }

  return {
    id: recipe.id,
    name: recipe.name,
    enabled: true,
    transport,
    recipe: recipe.id,
  };
}
