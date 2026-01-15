/*

YAML configuration parser for the backend.

Supported value forms per field:
  - Scalar (pure): a direct string, number, or boolean.
  - Env-var:       { env: VAR_NAME } — resolved from process.env at load time.
  - Builder:       a named-argument object whose sub-fields may use any of the
                   above forms. The parser calls a dedicated builder function
                   for these fields; they do not accept scalar/env directly.

The schema is encoded in the parser functions below; each field knows
which forms it accepts.

*/

import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { TlsOptions } from "./utils/tls.ts";


// ─── Internal resolution helpers ───────────────────────────────────────────

interface EnvSpec { env: string }

function isEnvSpec(v: unknown): v is EnvSpec {
  if (typeof v !== "object" || v === null) return false;
  const keys = Object.keys(v as object);
  return keys.length === 1 && keys[0] === "env"
    && typeof (v as Record<string, unknown>).env === "string";
}

function resolveString(raw: unknown, field: string): string {
  if (typeof raw === "string") return raw;
  if (isEnvSpec(raw)) {
    const val = process.env[raw.env];
    if (val === undefined) {
      throw new Error(`config: ${field}: env var "${raw.env}" is not set`);
    }
    return val;
  }
  throw new Error(
    `config: ${field}: expected a string or { env: VAR }, got ${JSON.stringify(raw)}`);
}

function resolveNumber(raw: unknown, field: string): number {
  if (typeof raw === "number") return raw;
  if (isEnvSpec(raw)) {
    const str = process.env[raw.env];
    if (str === undefined) {
      throw new Error(`config: ${field}: env var "${raw.env}" is not set`);
    }
    const n = Number(str);
    if (isNaN(n)) {
      throw new Error(
        `config: ${field}: env var "${raw.env}" value "${str}" is not a valid number`);
    }
    return n;
  }
  throw new Error(
    `config: ${field}: expected a number or { env: VAR }, got ${JSON.stringify(raw)}`);
}

function resolveOptionalString(
  raw: unknown, field: string, defaultValue: string,
): string {
  if (raw === undefined || raw === null) return defaultValue;
  return resolveString(raw, field);
}

function asObject(
  raw: unknown, field: string,
): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`config: ${field}: expected an object`);
  }
  return raw as Record<string, unknown>;
}


// ─── Builder parsers ────────────────────────────────────────────────────────

// Reads cert files and returns TlsOptions. Paths are resolved relative to
// the given base directory (the directory containing the config file).
function buildTls(
  raw: unknown, baseDir: string,
): TlsOptions {
  const r = asObject(raw, "tls");
  const keyPath = path.resolve(baseDir, resolveString(r.keyPath, "tls.keyPath"));
  const certPath = path.resolve(baseDir, resolveString(r.certPath, "tls.certPath"));
  return {
    key: readFileSync(keyPath, "utf-8"),
    cert: readFileSync(certPath, "utf-8"),
  };
}

function buildSfuWorkerEntry(
  raw: unknown, i: number,
): AppConfig["sfuWorkers"][number] {
  const field = `sfuWorkers[${i}]`;
  const r = asObject(raw, field);
  return {
    id: resolveNumber(r.id, `${field}.id`),
    portRange: {
      min: resolveNumber(r.portMin, `${field}.portMin`),
      max: resolveNumber(r.portMax, `${field}.portMax`),
    },
  };
}

function buildSignalingServerEntry(
  raw: unknown, i: number,
): AppConfig["signalingServers"][number] {
  const field = `signalingServers[${i}]`;
  const r = asObject(raw, field);
  return {
    id: resolveNumber(r.id, `${field}.id`),
    port: resolveNumber(r.port, `${field}.port`),
  };
}

function buildHttpServer(raw: unknown): AppConfig["httpServer"] {
  const r = asObject(raw, "httpServer");
  return {
    port: resolveNumber(r.port, "httpServer.port"),
  };
}


// ─── Public types and entry points ─────────────────────────────────────────

export interface AppConfig {
  webOrigin: string;
  environment: string;
  signalingServers: Array<{ id: number; port: number }>;
  channelAllocationStrategy: string;
  workerAllocationStrategy: string;
  httpServer: { port: number };
  // null when environment !== "production" or when the tls section is absent.
  tls: TlsOptions | null;
  sfuWorkers: Array<{ id: number; portRange: { min: number; max: number } }>;
}

export function parseAppConfig(raw: unknown, configDir: string = "."): AppConfig {
  const r = asObject(raw, "<root>");

  const webOrigin = resolveString(r.webOrigin, "webOrigin");
  const environment = resolveOptionalString(r.environment, "environment", "development");
  const channelAllocationStrategy = resolveOptionalString(
    r.channelAllocationStrategy, "channelAllocationStrategy", "round-robin");
  const workerAllocationStrategy = resolveOptionalString(
    r.workerAllocationStrategy, "workerAllocationStrategy", "round-robin");

  // signalingServers is a builder-only array field.
  if (!Array.isArray(r.signalingServers) || r.signalingServers.length === 0) {
    throw new Error("config: signalingServers: expected a non-empty array");
  }
  const signalingServers = r.signalingServers.map(
    (entry, i) => buildSignalingServerEntry(entry, i));

  const httpServer = buildHttpServer(r.httpServer);

  // tls is a builder-only field; it is optional and only applied in production.
  let tls: TlsOptions | null = null;
  if (r.tls !== undefined && r.tls !== null) {
    if (environment !== "production") {
      console.warn("config: tls section present but environment is not production — TLS ignored");
    } else {
      tls = buildTls(r.tls, configDir);
    }
  } else if (environment === "production") {
    console.warn("config: environment is production but no tls section provided — serving over HTTP");
  }

  if (!Array.isArray(r.sfuWorkers) || r.sfuWorkers.length === 0) {
    throw new Error("config: sfuWorkers: expected a non-empty array");
  }
  const sfuWorkers = r.sfuWorkers.map(
    (entry, i) => buildSfuWorkerEntry(entry, i));

  return {
    webOrigin, environment, signalingServers,
    channelAllocationStrategy, workerAllocationStrategy,
    httpServer, tls, sfuWorkers,
  };
}

export function loadConfig(configPath: string): AppConfig {
  const content = readFileSync(configPath, "utf-8");
  const raw = parseYaml(content);
  const configDir = path.dirname(path.resolve(configPath));
  return parseAppConfig(raw, configDir);
}
