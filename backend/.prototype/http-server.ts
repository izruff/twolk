import http from "node:http";

import type { IMessageBus } from "./bus.ts";
import type { SpaceData } from "./domain.ts";
import { createNodeHttpServer, type TlsOptions } from "./utils/tls.ts";


/**
 * Frontend-facing HTTP API for the prototype.
 *
 * This server translates HTTP requests from the browser frontend into bus
 * requests, communicates it to the coordinator, and translates bus responses
 * to JSON.
 *
 * Routes:
 *
 * - `POST /space` with `SpaceData`: creates a space.
 * - `GET /space?uuid=<uuid>`: reads public space data and status.
 * - `GET /space/try-join?uuid=<uuid>`: returns a signaling server URL.
 */
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

  /** Creates the Node server and starts listening on the configured port. */
  start() {
    this.server = createNodeHttpServer(this.tlsOptions, (req, res) => {
      this.handleRequest(req, res);
    });
    this.server.listen(this.port);
  }

  /** Stops the Node server if it is running. */
  stop() {
    this.server?.close();
    this.server = null;
  }

  /** Routes one incoming HTTP request. */
  handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    // CORS: the frontend is served from a different origin (port).
    res.setHeader("Access-Control-Allow-Origin", this.allowedOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      // Preflight request. The CORS headers above are all the browser needs.
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://localhost:${this.port}`);

    if (req.method === "POST" && url.pathname === "/space") {
      this.handleCreateSpace(req, res);
    } else if (req.method === "GET" && url.pathname === "/space") {
      this.handleReadSpace(url, res);
    } else if (req.method === "GET" && url.pathname === "/space/try-join") {
      this.handleTryJoinSpace(url, res);
    } else {
      sendJson(res, 404, { error: "not found" });
    }
  }

  /** Handles `POST /space` by creating a coordinator space. */
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

        // TODO: Accept policyType from the frontend once space creation needs it.
        this.bus.publish("createSpaceRequest",
          { data, policyType: "subscription-driven" },
          ({ uuid }) => { sendJson(res, 201, { uuid }); },
          (e) => { sendJson(res, 500, { error: e.message }); });
      })
      .catch((e: Error) => { sendJson(res, 400, { error: e.message }); });
  }

  /** Handles `GET /space` by reading public coordinator space state. */
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

  /**
   * Handles `GET /space/try-join` by allocating a signaling server URL.
   *
   * Returns 404 when the space is missing, ended, or no signaling server is
   * available.
   */
  handleTryJoinSpace(url: URL, res: http.ServerResponse) {
    const spaceUuid = url.searchParams.get("uuid");
    if (spaceUuid === null) {
      sendJson(res, 400, { error: "missing uuid query parameter" });
      return;
    }

    this.bus.publish("tryJoinSpaceRequest", { spaceUuid },
      ({ serverUrl }) => { sendJson(res, 200, { serverUrl }); },
      (e) => { sendJson(res, 404, { error: e.message }); });
  }
}


/** Reads a full HTTP request body as UTF-8 text. */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => { chunks.push(chunk); });
    req.on("end", () => { resolve(Buffer.concat(chunks).toString("utf-8")); });
    req.on("error", reject);
  });
}


/** Parses and validates request JSON as `SpaceData`. */
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


/** Writes a JSON response with the given status code. */
function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}
