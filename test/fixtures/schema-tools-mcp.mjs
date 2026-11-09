import { createRequire } from "node:module";

const require = createRequire("/app/package.json");
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");

const server = new Server({ name: "schema-tools-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "read_probe",
      description: "Return the supplied positive amount.",
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { amount: { $ref: "#/$defs/positiveAmount" } },
        required: ["amount"],
        $defs: { positiveAmount: { type: "number", exclusiveMinimum: 0 } },
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: "write_probe",
      description: "Return the supplied message as a write operation.",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments ?? {};
  if (request.params.name === "read_probe") {
    return { content: [{ type: "text", text: `read:${args.amount}` }] };
  }
  if (request.params.name === "write_probe") {
    return { content: [{ type: "text", text: `write:${args.message}` }] };
  }
  return { content: [{ type: "text", text: "Unknown tool" }], isError: true };
});

await server.connect(new StdioServerTransport());
