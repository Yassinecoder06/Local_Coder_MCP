import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeToolSchema } from "../src/plugins/schema.js";

describe("Plugin Schema Normalisation (normalizeToolSchema)", () => {
  it("drops forbidden keywords ($schema, $id, $comment, examples, not, if/then/else, patternProperties, dependentRequired, dependentSchemas, unevaluatedProperties, contentMediaType, contentEncoding)", () => {
    const raw = {
      $schema: "http://json-schema.org/draft-07/schema#",
      $id: "https://example.com/tool.schema.json",
      $comment: "Internal developer note",
      type: "object",
      properties: {
        payload: {
          type: "string",
          contentMediaType: "application/json",
          contentEncoding: "utf-8",
          examples: ["hello world"],
          $comment: "Nested comment",
        },
      },
      not: { type: "string" },
      if: { properties: { payload: { type: "string" } } },
      then: { properties: { payload: { minLength: 1 } } },
      else: { properties: { payload: { minLength: 0 } } },
      patternProperties: { "^S_": { type: "string" } },
      dependentRequired: { payload: ["other"] },
      dependentSchemas: { payload: { type: "object" } },
      unevaluatedProperties: false,
    };

    const { schema, adjustments } = normalizeToolSchema(raw);

    assert.equal(schema.$schema, undefined);
    assert.equal(schema.$id, undefined);
    assert.equal(schema.$comment, undefined);
    assert.equal(schema.not, undefined);
    assert.equal(schema.if, undefined);
    assert.equal(schema.then, undefined);
    assert.equal(schema.else, undefined);
    assert.equal(schema.patternProperties, undefined);
    assert.equal(schema.dependentRequired, undefined);
    assert.equal(schema.dependentSchemas, undefined);
    assert.equal(schema.unevaluatedProperties, undefined);

    const payloadProp = (schema.properties as any).payload;
    assert.equal(payloadProp.contentMediaType, undefined);
    assert.equal(payloadProp.contentEncoding, undefined);
    assert.equal(payloadProp.examples, undefined);
    assert.equal(payloadProp.$comment, undefined);

    assert.ok(!adjustments.some((a) => a.includes("dropped $schema")), "metadata drops are silent");
    assert.ok(adjustments.some((a) => a.includes("dropped not")));
    assert.ok(!adjustments.some((a) => a.includes("dropped $id")));
    assert.ok(!adjustments.some((a) => a.includes("dropped examples")));
    assert.ok(adjustments.some((a) => a.includes("dropped patternProperties")));
  });

  it("converts exclusiveMinimum/Maximum (number) to minimum/maximum + description note", () => {
    const raw = {
      type: "object",
      properties: {
        score: {
          type: "number",
          exclusiveMinimum: 10,
          description: "Initial score",
        },
        speed: {
          type: "number",
          exclusiveMaximum: 100,
        },
      },
    };

    const { schema, adjustments } = normalizeToolSchema(raw);
    const scoreProp = (schema.properties as any).score;
    assert.equal(scoreProp.exclusiveMinimum, undefined);
    assert.equal(scoreProp.minimum, 10);
    assert.match(scoreProp.description, /must be > 10/);

    const speedProp = (schema.properties as any).speed;
    assert.equal(speedProp.exclusiveMaximum, undefined);
    assert.equal(speedProp.maximum, 100);
    assert.match(speedProp.description, /must be < 100/);

    assert.ok(adjustments.some((a) => a.includes("properties.score: exclusiveMinimum 10 → minimum 10")));
    assert.ok(adjustments.some((a) => a.includes("properties.speed: exclusiveMaximum 100 → maximum 100")));
  });

  it("drops boolean draft-4 form of exclusiveMinimum and exclusiveMaximum", () => {
    const raw = {
      type: "object",
      properties: {
        count: {
          type: "number",
          minimum: 1,
          exclusiveMinimum: true,
          maximum: 50,
          exclusiveMaximum: false,
        },
      },
    };

    const { schema, adjustments } = normalizeToolSchema(raw);
    const countProp = (schema.properties as any).count;
    assert.equal(countProp.exclusiveMinimum, undefined);
    assert.equal(countProp.exclusiveMaximum, undefined);
    assert.equal(countProp.minimum, 1);
    assert.equal(countProp.maximum, 50);

    assert.ok(adjustments.some((a) => a.includes("dropped boolean exclusiveMinimum")));
    assert.ok(adjustments.some((a) => a.includes("dropped boolean exclusiveMaximum")));
  });

  it("converts const string to enum [string]", () => {
    const raw = {
      type: "object",
      properties: {
        kind: {
          type: "string",
          const: "admin",
        },
      },
    };

    const { schema, adjustments } = normalizeToolSchema(raw);
    const kindProp = (schema.properties as any).kind;
    assert.equal(kindProp.const, undefined);
    assert.deepEqual(kindProp.enum, ["admin"]);
    assert.ok(adjustments.some((a) => a.includes('const "admin" → enum')));
  });

  it("drops non-string enum and non-string const, appending note to description", () => {
    const raw = {
      type: "object",
      properties: {
        status: {
          type: "number",
          enum: [200, 404, 500],
          description: "HTTP status code",
        },
        flag: {
          const: 42,
        },
      },
    };

    const { schema, adjustments } = normalizeToolSchema(raw);
    const statusProp = (schema.properties as any).status;
    assert.equal(statusProp.enum, undefined);
    assert.match(statusProp.description, /one of: 200, 404, 500/);

    const flagProp = (schema.properties as any).flag;
    assert.equal(flagProp.const, undefined);
    assert.match(flagProp.description, /one of: 42/);

    assert.ok(adjustments.some((a) => a.includes("non-string enum → dropped, appended to description")));
    assert.ok(adjustments.some((a) => a.includes("const 42 → dropped, appended to description")));
  });

  it("converts type [T, 'null'] to T", () => {
    const raw = {
      type: "object",
      properties: {
        name: {
          type: ["string", "null"],
        },
        age: {
          type: ["null", "integer"],
        },
      },
    };

    const { schema, adjustments } = normalizeToolSchema(raw);
    const nameProp = (schema.properties as any).name;
    assert.equal(nameProp.type, "string");
    const ageProp = (schema.properties as any).age;
    assert.equal(ageProp.type, "integer");

    assert.ok(adjustments.some((a) => a.includes("properties.name: type [string, null] → string")));
    assert.ok(adjustments.some((a) => a.includes("properties.age: type [null, integer] → integer")));
  });

  it("removes {type:'null'} branch in anyOf/oneOf and inlines single remaining branch", () => {
    const raw = {
      type: "object",
      properties: {
        address: {
          anyOf: [{ type: "string" }, { type: "null" }],
        },
        city: {
          oneOf: [{ type: "string", minLength: 2 }, { type: "null" }],
        },
      },
    };

    const { schema, adjustments } = normalizeToolSchema(raw);
    const addressProp = (schema.properties as any).address;
    assert.equal(addressProp.anyOf, undefined);
    assert.equal(addressProp.type, "string");

    const cityProp = (schema.properties as any).city;
    assert.equal(cityProp.oneOf, undefined);
    assert.equal(cityProp.type, "string");
    assert.equal(cityProp.minLength, 2);

    assert.ok(adjustments.some((a) => a.includes("properties.address: anyOf with null branch → inlined single branch")));
    assert.ok(adjustments.some((a) => a.includes("properties.city: oneOf with null branch → inlined single branch")));
  });

  it("converts remaining oneOf branches to anyOf", () => {
    const raw = {
      type: "object",
      properties: {
        choice: {
          oneOf: [{ type: "string" }, { type: "number" }],
        },
      },
    };

    const { schema, adjustments } = normalizeToolSchema(raw);
    const choiceProp = (schema.properties as any).choice;
    assert.equal(choiceProp.oneOf, undefined);
    assert.ok(Array.isArray(choiceProp.anyOf));
    assert.equal(choiceProp.anyOf.length, 2);
    assert.ok(adjustments.some((a) => a.includes("properties.choice: oneOf → anyOf")));
  });

  it("inlines $ref to #/$defs and #/definitions and removes $defs/definitions", () => {
    const raw = {
      type: "object",
      properties: {
        user: { $ref: "#/$defs/User" },
        settings: { $ref: "#/definitions/Settings" },
      },
      $defs: {
        User: {
          type: "object",
          properties: {
            username: { type: "string" },
          },
          required: ["username"],
        },
      },
      definitions: {
        Settings: {
          type: "object",
          properties: {
            theme: { type: "string" },
          },
        },
      },
    };

    const { schema, adjustments } = normalizeToolSchema(raw);
    assert.equal(schema.$defs, undefined);
    assert.equal(schema.definitions, undefined);

    const userProp = (schema.properties as any).user;
    assert.equal(userProp.$ref, undefined);
    assert.equal(userProp.type, "object");
    assert.equal(userProp.properties.username.type, "string");

    const settingsProp = (schema.properties as any).settings;
    assert.equal(settingsProp.$ref, undefined);
    assert.equal(settingsProp.type, "object");
    assert.equal(settingsProp.properties.theme.type, "string");

    assert.ok(adjustments.some((a) => a.includes("inlined $ref #/$defs/User")));
    assert.ok(adjustments.some((a) => a.includes("inlined $ref #/definitions/Settings")));
    assert.ok(adjustments.some((a) => a.includes("root: dropped $defs")));
    assert.ok(adjustments.some((a) => a.includes("root: dropped definitions")));
  });

  it("handles recursive $ref by inlining up to cycle and replacing recursive ref with {type:'object'}", () => {
    const raw = {
      type: "object",
      properties: {
        node: { $ref: "#/$defs/LinkedList" },
      },
      $defs: {
        LinkedList: {
          type: "object",
          properties: {
            value: { type: "string" },
            next: { $ref: "#/$defs/LinkedList" },
          },
        },
      },
    };

    const { schema, adjustments } = normalizeToolSchema(raw);
    assert.equal(schema.$defs, undefined);

    const nodeProp = (schema.properties as any).node;
    assert.equal(nodeProp.type, "object");
    assert.equal(nodeProp.properties.value.type, "string");
    assert.equal(nodeProp.properties.next.type, "object");
    assert.equal(nodeProp.properties.next.$ref, undefined);

    assert.ok(adjustments.some((a) => a.includes("recursive $ref #/$defs/LinkedList → {type: 'object'}")));
  });

  it("merges allOf of objects (properties + required)", () => {
    const raw = {
      type: "object",
      properties: {
        composite: {
          allOf: [
            {
              type: "object",
              properties: { id: { type: "string" } },
              required: ["id"],
            },
            {
              type: "object",
              properties: { created: { type: "number" } },
              required: ["created"],
            },
          ],
        },
      },
    };

    const { schema, adjustments } = normalizeToolSchema(raw);
    const comp = (schema.properties as any).composite;
    assert.equal(comp.allOf, undefined);
    assert.equal(comp.type, "object");
    assert.equal(comp.properties.id.type, "string");
    assert.equal(comp.properties.created.type, "number");
    assert.deepEqual(comp.required.sort(), ["created", "id"]);

    assert.ok(adjustments.some((a) => a.includes("properties.composite: allOf merged into object")));
  });

  it("forces root to {type:'object', properties:{}} when missing and filters required entries not in properties", () => {
    const rawMissing = {};
    const res1 = normalizeToolSchema(rawMissing);
    assert.equal(res1.schema.type, "object");
    assert.deepEqual(res1.schema.properties, {});
    assert.ok(res1.adjustments.some((a) => a.includes("root: type forced to 'object'")));
    assert.ok(res1.adjustments.some((a) => a.includes("root: properties initialized to {}")));

    const rawWithInvalidRequired = {
      type: "object",
      properties: {
        real: { type: "string" },
      },
      required: ["real", "ghost", 123],
    };
    const res2 = normalizeToolSchema(rawWithInvalidRequired);
    assert.deepEqual(res2.schema.required, ["real"]);
    assert.ok(res2.adjustments.some((a) => a.includes("removed entries not in properties [ghost, 123]")));

    const invalidInputs = [null, undefined, "not an object", 42, [1, 2]];
    for (const bad of invalidInputs) {
      const res = normalizeToolSchema(bad);
      assert.equal(res.schema.type, "object");
      assert.deepEqual(res.schema.properties, {});
      assert.ok(res.adjustments.length > 0);
    }
  });

  it("handles the real DevTools shape { 'type':'number','exclusiveMinimum':0 }", () => {
    const raw = {
      type: "object",
      properties: {
        width: {
          type: "number",
          exclusiveMinimum: 0,
        },
        timeout: {
          type: "number",
          exclusiveMinimum: 0,
          description: "Operation timeout in ms",
        },
      },
    };

    const { schema, adjustments } = normalizeToolSchema(raw);
    const width = (schema.properties as any).width;
    assert.equal(width.exclusiveMinimum, undefined);
    assert.equal(width.minimum, 0);
    assert.equal(width.description, "(must be > 0)");

    const timeout = (schema.properties as any).timeout;
    assert.equal(timeout.exclusiveMinimum, undefined);
    assert.equal(timeout.minimum, 0);
    assert.match(timeout.description, /^Operation timeout in ms \(must be > 0\)$/);

    assert.ok(adjustments.some((a) => a.includes("properties.width: exclusiveMinimum 0 → minimum 0")));
    assert.ok(adjustments.some((a) => a.includes("properties.timeout: exclusiveMinimum 0 → minimum 0")));
  });

  it("is idempotent: normalising twice yields the identical schema and zero new adjustments", () => {
    const complex = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        limit: { type: "number", exclusiveMinimum: 0 },
        tag: { type: ["string", "null"] },
        color: { enum: ["red", "green", "blue"] },
        mode: { const: "auto" },
        items: {
          type: "array",
          items: {
            allOf: [
              { properties: { name: { type: "string" } } },
              { properties: { priority: { type: "number", exclusiveMaximum: 10 } } },
            ],
          },
        },
      },
      required: ["limit", "missingKey"],
    };

    const firstPass = normalizeToolSchema(complex);
    assert.ok(firstPass.adjustments.length > 0);

    const secondPass = normalizeToolSchema(firstPass.schema);
    assert.deepEqual(secondPass.schema, firstPass.schema);
    assert.deepEqual(secondPass.adjustments, []);
  });

  it("produces zero adjustments on an already-clean schema", () => {
    const clean = {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "The message to send",
        },
        count: {
          type: "number",
          minimum: 1,
          maximum: 100,
        },
        level: {
          type: "string",
          enum: ["debug", "info", "warn", "error"],
        },
      },
      required: ["message"],
    };

    const { schema, adjustments } = normalizeToolSchema(clean);
    assert.deepEqual(schema, clean);
    assert.deepEqual(adjustments, []);
  });
});
