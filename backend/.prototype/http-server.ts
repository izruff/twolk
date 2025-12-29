/*

HTTP server facing the frontend.

A thin entry point that translates HTTP requests into bus requests and the
bus responses back into HTTP responses, the same way SignalingServer
translates client-channel events. It owns no state of its own; the
services behind the bus are the source of truth.

Today it only exposes Space CRUD; more resources will be added here later.

Routes:
- POST /space   body: SpaceData          -> 201 { uuid }
- GET  /space   query: ?uuid=<uuid>      -> 200 { ...SpaceData, status } | 404

Speaks https when given TlsOptions, plain http otherwise — the composition
root decides based on ENVIRONMENT.

*/

import http from "node:http";

import type { IMessageBus } from "./bus.ts";
import type { SpaceData } from "./domain.ts";
import { createNodeHttpServer, type TlsOptions } from "./utils/tls.ts";


export class FrontendFacingHttpServer {
  bus: IMessageBus
  port: number
  tlsOptions: TlsOptions | null
  allowedOrigin: string
  server: http.Server | null = null

  constructor(bus: IMessageBus, port: number, tlsOptions: TlsOptions | null,
    allowedOrigin: string) {
    this.bus = bus;
    this.port = port;
    this.tlsOptions = tlsOptions;
    this.allowedOrigin = allowedOrigin;
  }

  start() {
    this.server = createNodeHttpServer(this.tlsOptions, (req, res) => {
      this.handleRequest(req, res);
    });
    this.server.listen(this.port);
  }

  stop() {
    this.server?.close();
    this.server = null;
  }

  handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    // CORS: the frontend is served from a different origin (port).
    res.setHeader("Access-Control-Allow-Origin", this.allowedOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      // Preflight request — headers above are all the browser needs.
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://localhost:${this.port}`);

    if (req.method === "POST" && url.pathname === "/space") {
      this.handleCreateSpace(req, res);
    } else if (req.method === "GET" && url.pathname === "/space") {
      this.handleReadSpace(url, res);
    } else {
      sendJson(res, 404, { error: "not found" });
    }
  }

  handleCreateSpace(req: http.IncomingMessage, res: http.ServerResponse) {
    readBody(req)
      .then((body) => {
        let data: SpaceData;
        try {
          data = parseSpaceData(body);
        } catch (e: any) {
          sendJson(res, 400, { error: e.message });
          return;
        }

        this.bus.publish("createSpaceRequest", { data },
          ({ uuid }) => { sendJson(res, 201, { uuid }); },
          (e) => { sendJson(res, 500, { error: e.message }); });
      })
      .catch((e: Error) => { sendJson(res, 400, { error: e.message }); });
  }

  handleReadSpace(url: URL, res: http.ServerResponse) {
    const uuid = url.searchParams.get("uuid");
    if (uuid === null) {
      sendJson(res, 400, { error: "missing uuid query parameter" });
      return;
    }

    this.bus.publish("readSpaceRequest", { uuid },
      ({ data, status }) => { sendJson(res, 200, { ...data, status }); },
      () => { sendJson(res, 404, { error: "space not found" }); });
  }
}


function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => { chunks.push(chunk); });
    req.on("end", () => { resolve(Buffer.concat(chunks).toString("utf-8")); });
    req.on("error", reject);
  });
}


function parseSpaceData(body: string): SpaceData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("invalid JSON body");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("body must be a SpaceData object");
  }
  const { name, description } = parsed as Record<string, unknown>;
  if (typeof name !== "string" || typeof description !== "string") {
    throw new Error("name and description must be strings");
  }
  return { name, description };
}


function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}
