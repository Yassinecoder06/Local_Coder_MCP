import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadRecipes, recipeToInput, isVersionPinned, pluginRecipeSchema } from "../src/plugins/recipes.js";
import type { PluginRecipe } from "../src/core/plugins.js";

test("plugin recipes: loader, validation, pinning, and input conversion", async (t) => {
  await t.test("loadRecipes: loads and validates builtin recipes.json", async () => {
    const recipes = await loadRecipes();

    assert.ok(Array.isArray(recipes));
    assert.ok(recipes.length >= 4);

    // Verify expected recipe IDs
    const ids = recipes.map((r) => r.id);
    assert.ok(ids.includes("playwright"));
    assert.ok(ids.includes("fetch"));
    assert.ok(ids.includes("memory"));
    assert.ok(ids.includes("github"));

    // Verify all IDs are unique
    assert.equal(new Set(ids).size, ids.length);

    // Validate each recipe with zod schema
    for (const r of recipes) {
      assert.doesNotThrow(() => pluginRecipeSchema.parse(r));
    }
  });

  await t.test("version pinning: all builtin recipes have strictly pinned versions", async () => {
    const recipes = await loadRecipes();

    for (const r of recipes) {
      assert.equal(
        isVersionPinned(r),
        true,
        `Recipe "${r.id}" must have pinned versions in transport`
      );

      if (r.transport.type === "stdio") {
        for (const arg of r.transport.args) {
          if (arg.includes("@") && !arg.startsWith("-")) {
            const version = arg.slice(arg.lastIndexOf("@") + 1);
            assert.notEqual(version, "latest", `Package in ${r.id} cannot be "latest"`);
            assert.match(
              version,
              /^[0-9]/,
              `Package in ${r.id} version "${version}" must start with a digit, no range prefixes`
            );
            assert.equal(
              /[\^~><*]/.test(version),
              false,
              `Package in ${r.id} version "${version}" cannot contain semver range characters`
            );
          }
        }
      }
    }
  });

  await t.test("playwright recipe configuration", async () => {
    const recipes = await loadRecipes();
    const pw = recipes.find((r) => r.id === "playwright");
    assert.ok(pw);
    assert.equal(pw.runtime, "node");
    assert.equal(pw.transport.type, "stdio");
    if (pw.transport.type === "stdio") {
      assert.equal(pw.transport.command, "npx");
      assert.ok(pw.transport.args.some((a) => a.startsWith("@playwright/mcp@")));
      assert.ok(pw.transport.args.includes("--headless"));
      assert.ok(pw.transport.args.includes("--no-sandbox"));
      assert.ok(pw.transport.args.includes("--executable-path"));
      assert.ok(pw.transport.args.includes("/usr/local/bin/chromium"));
    }
  });

  await t.test("fetch recipe configuration", async () => {
    const recipes = await loadRecipes();
    const fetchRecipe = recipes.find((r) => r.id === "fetch");
    assert.ok(fetchRecipe);
    assert.equal(fetchRecipe.runtime, "uv");
    assert.equal(fetchRecipe.transport.type, "stdio");
    if (fetchRecipe.transport.type === "stdio") {
      assert.equal(fetchRecipe.transport.command, "uvx");
      assert.ok(fetchRecipe.transport.args.some((a) => a.startsWith("mcp-server-fetch@")));
    }
  });

  await t.test("memory recipe configuration", async () => {
    const recipes = await loadRecipes();
    const memory = recipes.find((r) => r.id === "memory");
    assert.ok(memory);
    assert.equal(memory.runtime, "node");
    assert.equal(memory.transport.type, "stdio");
    if (memory.transport.type === "stdio") {
      assert.equal(memory.transport.command, "npx");
      assert.ok(memory.transport.args.some((a) => a.startsWith("@modelcontextprotocol/server-memory@")));
      assert.equal(memory.transport.env?.MEMORY_FILE_PATH, "/data/plugins/memory.json");
    }
  });

  await t.test("github recipe configuration", async () => {
    const recipes = await loadRecipes();
    const gh = recipes.find((r) => r.id === "github");
    assert.ok(gh);
    assert.equal(gh.runtime, "none");
    assert.equal(gh.transport.type, "http");
    if (gh.transport.type === "http") {
      assert.equal(gh.transport.url, "https://api.githubcopilot.com/mcp/");
    }
    assert.equal(gh.secrets.length, 1);
    assert.equal(gh.secrets[0].key, "Authorization");
    assert.equal(gh.secrets[0].where, "header");
    assert.equal(gh.secrets[0].required, true);
    assert.equal(gh.secrets[0].prefix, "Bearer ");
  });

  await t.test("loadRecipes: detects duplicates and unpinned versions in custom directory", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "recipes-test-"));
    try {
      // 1. Duplicate IDs
      const duplicateRecipes = [
        {
          id: "dup",
          name: "Duplicate 1",
          description: "First",
          homepage: "https://example.com",
          runtime: "node",
          transport: { type: "stdio", command: "node", args: ["server.js"] },
          secrets: [],
        },
        {
          id: "dup",
          name: "Duplicate 2",
          description: "Second",
          homepage: "https://example.com",
          runtime: "node",
          transport: { type: "stdio", command: "node", args: ["server.js"] },
          secrets: [],
        },
      ];
      await fs.writeFile(path.join(tmp, "recipes.json"), JSON.stringify(duplicateRecipes));
      await assert.rejects(
        () => loadRecipes(tmp),
        /Duplicate recipe id: "dup"/
      );

      // 2. Unpinned version ("latest")
      const unpinnedLatest = [
        {
          id: "unpinned",
          name: "Unpinned",
          description: "Uses latest",
          homepage: "https://example.com",
          runtime: "node",
          transport: { type: "stdio", command: "npx", args: ["@some/pkg@latest"] },
          secrets: [],
        },
      ];
      await fs.writeFile(path.join(tmp, "recipes.json"), JSON.stringify(unpinnedLatest));
      await assert.rejects(
        () => loadRecipes(tmp),
        /does not have pinned package versions/
      );

      // 3. Unpinned version with range (^)
      const unpinnedRange = [
        {
          id: "unpinned",
          name: "Unpinned",
          description: "Uses range",
          homepage: "https://example.com",
          runtime: "node",
          transport: { type: "stdio", command: "npx", args: ["@some/pkg@^1.2.0"] },
          secrets: [],
        },
      ];
      await fs.writeFile(path.join(tmp, "recipes.json"), JSON.stringify(unpinnedRange));
      await assert.rejects(
        () => loadRecipes(tmp),
        /does not have pinned package versions/
      );
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  });

  await t.test("recipeToInput: happy path without secrets (playwright)", async () => {
    const recipes = await loadRecipes();
    const pw = recipes.find((r) => r.id === "playwright")!;
    const input = recipeToInput(pw);

    assert.equal(input.id, "playwright");
    assert.equal(input.name, "Playwright MCP");
    assert.equal(input.enabled, true);
    assert.equal(input.recipe, "playwright");
    assert.equal(input.transport.type, "stdio");
  });

  await t.test("recipeToInput: happy path with secret and prefix (github)", async () => {
    const recipes = await loadRecipes();
    const gh = recipes.find((r) => r.id === "github")!;

    // Case A: token without prefix
    const inputA = recipeToInput(gh, { Authorization: "ghp_secrettoken123" });
    assert.equal(inputA.transport.type, "http");
    if (inputA.transport.type === "http") {
      assert.equal(inputA.transport.headers?.Authorization, "Bearer ghp_secrettoken123");
    }

    // Case B: token already has prefix
    const inputB = recipeToInput(gh, { Authorization: "Bearer ghp_secrettoken123" });
    if (inputB.transport.type === "http") {
      assert.equal(inputB.transport.headers?.Authorization, "Bearer ghp_secrettoken123");
    }
  });

  await t.test("recipeToInput: missing required secret throws error", async () => {
    const recipes = await loadRecipes();
    const gh = recipes.find((r) => r.id === "github")!;

    assert.throws(
      () => recipeToInput(gh, {}),
      /Missing required secret: Authorization/
    );

    assert.throws(
      () => recipeToInput(gh, { Authorization: "   " }),
      /Missing required secret: Authorization/
    );
  });

  await t.test("recipeToInput: env secret with prefix on stdio transport", () => {
    const customRecipe: PluginRecipe = {
      id: "custom-stdio",
      name: "Custom Stdio",
      description: "Test recipe",
      homepage: "https://example.com",
      runtime: "node",
      transport: {
        type: "stdio",
        command: "node",
        args: ["index.js"],
        env: { FIXED_VAR: "1" },
      },
      secrets: [
        {
          key: "API_KEY",
          where: "env",
          label: "API Key",
          required: true,
          prefix: "key_",
        },
      ],
    };

    const input = recipeToInput(customRecipe, { API_KEY: "secret123" });
    assert.equal(input.transport.type, "stdio");
    if (input.transport.type === "stdio") {
      assert.equal(input.transport.env?.FIXED_VAR, "1");
      assert.equal(input.transport.env?.API_KEY, "key_secret123");
    }
  });
});
