/**
 * Discord MCP Server — Cloudflare Worker
 *
 * Remote MCP server exposing Discord tools via Streamable HTTP.
 * Forwards all tool calls to the Fly.io bot HTTP API.
 *
 * Accessible from Claude mobile, desktop, and web.
 *
 * Auth: API key via Authorization: Bearer header or URL path (/mcp/{key})
 * Transport: Streamable HTTP at /mcp or /mcp/{key}
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { registerTools } from "./tools";
import type { Env } from "./types";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

function corsResponse(status: number, body?: string): Response {
  return new Response(body ?? null, { status, headers: CORS_HEADERS });
}

function addCorsHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    headers.set(k, v);
  }
  return new Response(response.body, { status: response.status, headers });
}

/** Build a fake Request to pass to the transport's handleRequest. */
function makeReq(url: string, headers: Headers, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

/**
 * Create a fresh McpServer + transport, pre-initialized and ready
 * to handle tool calls immediately.
 *
 * Stateless design: Cloudflare Workers don't share memory across requests,
 * so we create and initialize a new server for each request.
 */
async function createInitializedServer(
  env: Env,
  url: string,
  headers: Headers
): Promise<WebStandardStreamableHTTPServerTransport> {
  const server = new McpServer({ name: "discord", version: "1.0.0" });
  registerTools(server, env);

  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  await server.connect(transport);

  // Step 1: Send initialize request
  await transport.handleRequest(
    makeReq(url, headers, {
      jsonrpc: "2.0",
      id: "__init__",
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "discord-mcp-cloud-internal", version: "1.0.0" },
      },
    })
  );

  // Step 2: Send initialized notification
  await transport.handleRequest(
    makeReq(url, headers, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    })
  );

  return transport;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return corsResponse(204);
    }

    // Health check
    if (url.pathname === "/" || url.pathname === "/health") {
      return corsResponse(200, "Discord MCP Cloud — OK");
    }

    // Auth: accept key via URL path (/mcp/{key}) or Authorization header
    const pathMatch = url.pathname.match(/^\/mcp(?:\/(.+))?$/);
    if (!pathMatch) {
      return corsResponse(404, "Not Found");
    }

    const urlKey = pathMatch[1];
    const headerKey = request.headers.get("Authorization")?.replace("Bearer ", "");
    const providedKey = urlKey || headerKey;

    if (!providedKey || providedKey !== env.API_KEY) {
      return corsResponse(401, "Unauthorized");
    }

    // Session close
    if (request.method === "DELETE") {
      return corsResponse(200, "Session closed");
    }

    if (request.method !== "POST") {
      return corsResponse(405, "Method Not Allowed");
    }

    // Parse the incoming JSON-RPC message
    const body = await request.json() as Record<string, unknown> | Record<string, unknown>[];
    const first = Array.isArray(body) ? body[0] : body;
    const method = first?.method as string | undefined;

    // Notifications — just accept (no server state needed)
    if (!first?.id && method?.startsWith("notifications/")) {
      return corsResponse(202);
    }

    // Create pre-initialized server and handle the actual request
    const transport = await createInitializedServer(env, request.url, request.headers);

    const actualReq = new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(body),
    });

    const response = await transport.handleRequest(actualReq);
    return addCorsHeaders(response);
  },
};
