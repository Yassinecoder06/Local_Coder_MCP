/**
 * Owned by agy1. Normalises JSON Schema into the subset accepted by strict MCP clients (Gemini).
 */
import type { NormalizeToolSchema } from "../core/plugins.js";

const DROP_KEYS = new Set([
  "$schema",
  "$id",
  "$comment",
  "examples",
  "not",
  "if",
  "then",
  "else",
  "patternProperties",
  "dependentRequired",
  "dependentSchemas",
  "unevaluatedProperties",
  "contentMediaType",
  "contentEncoding",
]);

function safeClone<T>(val: T): T {
  try {
    return JSON.parse(JSON.stringify(val));
  } catch {
    return {} as T;
  }
}

function resolvePointer(root: Record<string, unknown>, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  const parts = ref.slice(2).split("/").map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: any = root;
  for (const part of parts) {
    if (current && typeof current === "object" && part in current) {
      current = current[part];
    } else {
      return undefined;
    }
  }
  return current;
}

export const normalizeToolSchema: NormalizeToolSchema = (input: unknown) => {
  const adjustments: string[] = [];

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      schema: { type: "object", properties: {} },
      adjustments: ["root: replaced invalid schema with {type: 'object', properties: {}}"],
    };
  }

  const root = safeClone(input) as Record<string, unknown>;

  // 1. Resolve $ref throughout the tree (depth ≤ 8; recursive → {type:"object"})
  function inlineRefs(node: any, path: string, depth: number, chain: Set<string>): void {
    if (!node || typeof node !== "object") return;

    if (typeof node.$ref === "string") {
      const ref = node.$ref;
      const pathPrefix = path || "root";
      if (chain.has(ref) || depth > 8) {
        delete node.$ref;
        for (const k of Object.keys(node)) delete node[k];
        node.type = "object";
        adjustments.push(`${pathPrefix}: recursive $ref ${ref} → {type: 'object'}`);
        return;
      }

      const target = resolvePointer(root, ref);
      if (target && typeof target === "object" && !Array.isArray(target)) {
        const clonedTarget = safeClone(target) as Record<string, unknown>;
        delete node.$ref;
        const nextChain = new Set(chain);
        nextChain.add(ref);
        inlineRefs(clonedTarget, path, depth + 1, nextChain);
        Object.assign(node, clonedTarget);
        adjustments.push(`${pathPrefix}: inlined $ref ${ref}`);
      } else {
        delete node.$ref;
        node.type = "object";
        adjustments.push(`${pathPrefix}: unresolved $ref ${ref} → {type: 'object'}`);
        return;
      }
    }

    if (node.properties && typeof node.properties === "object" && !Array.isArray(node.properties)) {
      for (const [key, val] of Object.entries(node.properties)) {
        const nextPath = path ? `${path}.properties.${key}` : `properties.${key}`;
        inlineRefs(val, nextPath, depth, chain);
      }
    }

    if (node.items && typeof node.items === "object") {
      if (Array.isArray(node.items)) {
        node.items.forEach((item: any, idx: number) => {
          const nextPath = path ? `${path}.items[${idx}]` : `items[${idx}]`;
          inlineRefs(item, nextPath, depth, chain);
        });
      } else {
        const nextPath = path ? `${path}.items` : "items";
        inlineRefs(node.items, nextPath, depth, chain);
      }
    }

    if (Array.isArray(node.anyOf)) {
      node.anyOf.forEach((branch: any, idx: number) => {
        const nextPath = path ? `${path}.anyOf[${idx}]` : `anyOf[${idx}]`;
        inlineRefs(branch, nextPath, depth, chain);
      });
    }

    if (Array.isArray(node.oneOf)) {
      node.oneOf.forEach((branch: any, idx: number) => {
        const nextPath = path ? `${path}.oneOf[${idx}]` : `oneOf[${idx}]`;
        inlineRefs(branch, nextPath, depth, chain);
      });
    }

    if (Array.isArray(node.allOf)) {
      node.allOf.forEach((sub: any, idx: number) => {
        const nextPath = path ? `${path}.allOf[${idx}]` : `allOf[${idx}]`;
        inlineRefs(sub, nextPath, depth, chain);
      });
    }
  }

  inlineRefs(root, "", 0, new Set());

  // Remove $defs and definitions from root
  if ("$defs" in root) {
    delete root.$defs;
    adjustments.push("root: dropped $defs");
  }
  if ("definitions" in root) {
    delete root.definitions;
    adjustments.push("root: dropped definitions");
  }

  // 2. Normalise nodes recursively
  function normalizeNode(node: any, path: string): void {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    const pathPrefix = path || "root";

    // allOf of objects merged (properties + required)
    if (Array.isArray(node.allOf)) {
      node.properties = (node.properties && typeof node.properties === "object" && !Array.isArray(node.properties))
        ? node.properties
        : {};
      const requiredSet = new Set<string>(Array.isArray(node.required) ? node.required : []);
      for (const sub of node.allOf) {
        if (sub && typeof sub === "object") {
          normalizeNode(sub, `${pathPrefix}.allOf`);
          if (sub.properties && typeof sub.properties === "object" && !Array.isArray(sub.properties)) {
            Object.assign(node.properties, sub.properties);
          }
          if (Array.isArray(sub.required)) {
            for (const r of sub.required) {
              if (typeof r === "string") requiredSet.add(r);
            }
          }
          if (sub.type === "object") {
            node.type = "object";
          }
        }
      }
      if (requiredSet.size > 0) {
        node.required = Array.from(requiredSet);
      }
      delete node.allOf;
      adjustments.push(`${pathPrefix}: allOf merged into object`);
    }

    // drop forbidden keys
    for (const key of Object.keys(node)) {
      if (DROP_KEYS.has(key)) {
        delete node[key];
        adjustments.push(`${pathPrefix}: dropped ${key}`);
      }
    }

    // exclusiveMinimum (number) → minimum + "(must be > n)" in description; boolean → dropped
    if (node.exclusiveMinimum !== undefined) {
      if (typeof node.exclusiveMinimum === "boolean") {
        delete node.exclusiveMinimum;
        adjustments.push(`${pathPrefix}: dropped boolean exclusiveMinimum`);
      } else if (typeof node.exclusiveMinimum === "number") {
        const val = node.exclusiveMinimum;
        node.minimum = val;
        delete node.exclusiveMinimum;
        const note = `(must be > ${val})`;
        node.description = node.description ? `${node.description} ${note}` : note;
        adjustments.push(`${pathPrefix}: exclusiveMinimum ${val} → minimum ${val}`);
      } else {
        delete node.exclusiveMinimum;
        adjustments.push(`${pathPrefix}: dropped invalid exclusiveMinimum`);
      }
    }

    // exclusiveMaximum (number) → maximum + "(must be < n)" in description; boolean → dropped
    if (node.exclusiveMaximum !== undefined) {
      if (typeof node.exclusiveMaximum === "boolean") {
        delete node.exclusiveMaximum;
        adjustments.push(`${pathPrefix}: dropped boolean exclusiveMaximum`);
      } else if (typeof node.exclusiveMaximum === "number") {
        const val = node.exclusiveMaximum;
        node.maximum = val;
        delete node.exclusiveMaximum;
        const note = `(must be < ${val})`;
        node.description = node.description ? `${node.description} ${note}` : note;
        adjustments.push(`${pathPrefix}: exclusiveMaximum ${val} → maximum ${val}`);
      } else {
        delete node.exclusiveMaximum;
        adjustments.push(`${pathPrefix}: dropped invalid exclusiveMaximum`);
      }
    }

    // const v → enum [v]; non-string enum → dropped, "one of: …" appended to description
    if (node.const !== undefined) {
      const val = node.const;
      delete node.const;
      if (typeof val === "string") {
        node.enum = [val];
        adjustments.push(`${pathPrefix}: const ${JSON.stringify(val)} → enum [${JSON.stringify(val)}]`);
      } else {
        const note = `one of: ${String(val)}`;
        node.description = node.description ? `${node.description} (${note})` : `(${note})`;
        adjustments.push(`${pathPrefix}: const ${JSON.stringify(val)} → dropped, appended to description`);
      }
    }

    if (node.enum !== undefined) {
      if (Array.isArray(node.enum)) {
        const allStrings = node.enum.every((item: unknown) => typeof item === "string");
        if (!allStrings) {
          const vals = node.enum.map((v: unknown) => String(v)).join(", ");
          delete node.enum;
          const note = `one of: ${vals}`;
          node.description = node.description ? `${node.description} (${note})` : `(${note})`;
          adjustments.push(`${pathPrefix}: non-string enum → dropped, appended to description`);
        }
      } else {
        delete node.enum;
        adjustments.push(`${pathPrefix}: dropped invalid enum`);
      }
    }

    // type [T, "null"] → T
    if (Array.isArray(node.type)) {
      const types = node.type;
      if (types.length === 2 && types.includes("null")) {
        const t = types.find((x: unknown) => x !== "null");
        if (typeof t === "string") {
          node.type = t;
          adjustments.push(`${pathPrefix}: type [${types.join(", ")}] → ${t}`);
        }
      } else if (types.length === 1 && typeof types[0] === "string") {
        node.type = types[0];
        adjustments.push(`${pathPrefix}: type [${types[0]}] → ${types[0]}`);
      } else {
        const nonNull = types.filter((x: unknown) => x !== "null");
        if (nonNull.length === 1 && typeof nonNull[0] === "string") {
          node.type = nonNull[0];
          adjustments.push(`${pathPrefix}: type [${types.join(", ")}] → ${nonNull[0]}`);
        }
      }
    }

    // anyOf / oneOf with a {type:"null"} branch → that branch removed, single remaining branch inlined
    if (Array.isArray(node.anyOf)) {
      const nullIndices: number[] = [];
      node.anyOf.forEach((b: any, idx: number) => {
        if (b && typeof b === "object" && (b.type === "null" || (Array.isArray(b.type) && b.type.length === 1 && b.type[0] === "null"))) {
          nullIndices.push(idx);
        }
      });
      if (nullIndices.length > 0) {
        const remaining = node.anyOf.filter((_: any, idx: number) => !nullIndices.includes(idx));
        if (remaining.length === 1 && typeof remaining[0] === "object" && !Array.isArray(remaining[0])) {
          delete node.anyOf;
          Object.assign(node, remaining[0]);
          adjustments.push(`${pathPrefix}: anyOf with null branch → inlined single branch`);
        } else {
          node.anyOf = remaining;
          adjustments.push(`${pathPrefix}: anyOf removed null branch`);
        }
      }
    }

    if (Array.isArray(node.oneOf)) {
      const nullIndices: number[] = [];
      node.oneOf.forEach((b: any, idx: number) => {
        if (b && typeof b === "object" && (b.type === "null" || (Array.isArray(b.type) && b.type.length === 1 && b.type[0] === "null"))) {
          nullIndices.push(idx);
        }
      });
      const remaining = nullIndices.length > 0
        ? node.oneOf.filter((_: any, idx: number) => !nullIndices.includes(idx))
        : node.oneOf;

      if (remaining.length === 1 && typeof remaining[0] === "object" && !Array.isArray(remaining[0])) {
        delete node.oneOf;
        Object.assign(node, remaining[0]);
        adjustments.push(`${pathPrefix}: oneOf with null branch → inlined single branch`);
      } else {
        node.anyOf = remaining;
        delete node.oneOf;
        adjustments.push(`${pathPrefix}: oneOf → anyOf`);
      }
    }

    // Recursion into properties
    if (node.properties && typeof node.properties === "object" && !Array.isArray(node.properties)) {
      for (const [key, val] of Object.entries(node.properties)) {
        const nextPath = path ? `${path}.properties.${key}` : `properties.${key}`;
        normalizeNode(val, nextPath);
      }
      // required entries not in properties removed
      if (Array.isArray(node.required)) {
        const propKeys = new Set(Object.keys(node.properties));
        const validRequired = node.required.filter((k: any) => typeof k === "string" && propKeys.has(k));
        if (validRequired.length !== node.required.length) {
          const removed = node.required.filter((k: any) => typeof k !== "string" || !propKeys.has(k));
          node.required = validRequired;
          adjustments.push(`${pathPrefix}.required: removed entries not in properties [${removed.join(", ")}]`);
        }
      } else if ("required" in node) {
        delete node.required;
        adjustments.push(`${pathPrefix}: dropped non-array required`);
      }
    }

    // Recursion into items
    if (node.items && typeof node.items === "object") {
      if (Array.isArray(node.items)) {
        node.items.forEach((item: any, idx: number) => {
          const nextPath = path ? `${path}.items[${idx}]` : `items[${idx}]`;
          normalizeNode(item, nextPath);
        });
      } else {
        const nextPath = path ? `${path}.items` : "items";
        normalizeNode(node.items, nextPath);
      }
    }

    // Recursion into anyOf
    if (Array.isArray(node.anyOf)) {
      node.anyOf.forEach((branch: any, idx: number) => {
        const nextPath = path ? `${path}.anyOf[${idx}]` : `anyOf[${idx}]`;
        normalizeNode(branch, nextPath);
      });
    }
  }

  normalizeNode(root, "");

  // 3. Ensure root forced to {type:"object", properties:{}} when missing
  if (root.type !== "object") {
    root.type = "object";
    adjustments.push("root: type forced to 'object'");
  }
  if (!root.properties || typeof root.properties !== "object" || Array.isArray(root.properties)) {
    root.properties = {};
    adjustments.push("root: properties initialized to {}");
  }
  if (Array.isArray(root.required)) {
    const propKeys = new Set(Object.keys(root.properties as object));
    const validRequired = root.required.filter((k: any) => typeof k === "string" && propKeys.has(k));
    if (validRequired.length !== root.required.length) {
      const removed = root.required.filter((k: any) => typeof k !== "string" || !propKeys.has(k));
      root.required = validRequired;
      adjustments.push(`root.required: removed entries not in properties [${removed.join(", ")}]`);
    }
  } else if ("required" in root) {
    delete root.required;
    adjustments.push("root: dropped non-array required");
  }

  return { schema: root, adjustments };
};
