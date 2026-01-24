/**
 * The entry point of the prototype backend application.
 */

try {
  process.loadEnvFile();
} catch {
  // .env file is optional
}

import { fileURLToPath } from "node:url";
import path from "node:path";

import { loadConfig } from "./config.ts";
import { InProcessBus } from "./bus.ts";
import { SignalingServer } from "./server.ts";
import { FrontendFacingHttpServer } from "./http-server.ts";
import { SfuWorker } from "./worker.ts";
import { Coordinator } from "./coordinator.ts";
import { MediasoupMediaWorker } from "./media-mediasoup.ts";
import { RoundRobinStrategy } from "./allocation-strategy.ts";


// Resolve config.yaml relative to this module instead of the shell cwd.
const CONFIG_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "config.yaml",
);

const config = loadConfig(CONFIG_PATH);

/** Builds the configured allocation strategy implementation. */
function buildAllocationStrategy(name: string) {
  if (name === "round-robin") return new RoundRobinStrategy();
  throw new Error("unknown allocation strategy: " + name);
}

const bus = new InProcessBus();

// Construct the coordinator before workers and servers so it can subscribe to
// registration events before those collaborators announce themselves.
const coordinator = new Coordinator(bus,
  buildAllocationStrategy(config.channelAllocationStrategy),
  buildAllocationStrategy(config.workerAllocationStrategy));

// Each worker facade registers with the bus when constructed.
const sfuWorkers = await Promise.all(
  config.sfuWorkers.map(async (wCfg) => {
    const mediaWorker = await MediasoupMediaWorker.create(wCfg.portRange);
    return new SfuWorker(wCfg.id, mediaWorker, bus);
  })
);

// Each signaling server registers with the bus when constructed.
const signalingServers = config.signalingServers.map((srvCfg) =>
  SignalingServer.create(
    srvCfg.id,
    config.tls,
    {
      cors: {
        origin: config.webOrigin,
        methods: ["GET", "POST"],
        credentials: true,
      },
    },
    srvCfg.port,
    bus,
  )
);

const httpServer = new FrontendFacingHttpServer(
  bus, config.httpServer.port, config.tls, config.webOrigin);

// Start coordinator and workers before accepting client channels.
coordinator.start();
sfuWorkers.forEach((w) => w.start((err) => { console.log(err); process.exit(1); }));
signalingServers.forEach((s) => s.start());
httpServer.start();
