#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "rich-mcp",
  version: "1.0.0",
});

server.registerTool(
  "produce_rich",
  {
    description: "Produces text, image, and structuredContent",
    inputSchema: {
      tag: z.string().optional(),
    },
    annotations: {
      readOnlyHint: true,
    },
  },
  async ({ tag }) => {
    return {
      content: [
        { type: "text", text: `result for ${tag || "default"}` },
        {
          type: "image",
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          mimeType: "image/png",
        },
      ],
      structuredContent: { status: "complete", score: 99 },
    };
  }
);

server.registerTool(
  "produce_error",
  {
    description: "Produces an error result",
    annotations: {
      readOnlyHint: true,
    },
  },
  async () => {
    return {
      content: [{ type: "text", text: "Operation failed upstream" }],
      isError: true,
    };
  }
);

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
process.stdin.on("end", () => process.exit(0));

const transport = new StdioServerTransport();
await server.connect(transport);
