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
import { RoundRobinStrategy } from "./channel-pre-allocator.ts";


// Resolve config.yaml relative to this file so the path is correct
// regardless of the working directory.
const CONFIG_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "config.yaml",
);

const config = loadConfig(CONFIG_PATH);

function buildAllocationStrategy(name: string) {
  if (name === "round-robin") return new RoundRobinStrategy();
  throw new Error("unknown allocation strategy: " + name);
}

const bus = new InProcessBus();

// Coordinator must be constructed before any server or worker is created,
// so it can subscribe to their registration events first.
const coordinator = new Coordinator(bus,
  buildAllocationStrategy(config.channelAllocationStrategy),
  buildAllocationStrategy(config.workerAllocationStrategy));

// Each SfuWorker registers with the coordinator via the bus when constructed.
const sfuWorkers = await Promise.all(
  config.sfuWorkers.map(async (wCfg) => {
    const mediaWorker = await MediasoupMediaWorker.create(wCfg.portRange);
    return new SfuWorker(wCfg.id, mediaWorker, bus);
  })
);

// Each signaling server also registers via the bus when constructed.
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

// Start the coordinator and workers before the signaling servers so the
// pipeline is ready before any client can connect.
coordinator.start();
sfuWorkers.forEach((w) => w.start((err) => { console.log(err); process.exit(1); }));
signalingServers.forEach((s) => s.start());
httpServer.start();
