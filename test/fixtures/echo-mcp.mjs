#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "echo-mcp",
  version: "1.0.0",
});

server.registerTool(
  "echo",
  {
    description: "Echoes back the message",
    inputSchema: {
      message: z.string().describe("Message to echo"),
    },
  },
  async ({ message }) => {
    return {
      content: [{ type: "text", text: `echo: ${message}` }],
    };
  }
);

server.registerTool(
  "add",
  {
    description: "Adds two numbers together",
    inputSchema: {
      a: z.number().describe("First number"),
      b: z.number().describe("Second number"),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async ({ a, b }) => {
    return {
      content: [{ type: "text", text: String(a + b) }],
    };
  }
);

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
process.stdin.on("close", () => {
  process.exit(0);
});
process.stdin.on("end", () => {
  process.exit(0);
});
const transport = new StdioServerTransport();
await server.connect(transport);
