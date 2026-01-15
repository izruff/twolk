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
import { RoundRobinServerStrategy } from "./channel-pre-allocator.ts";


// Resolve config.yaml relative to this file so the path is correct
// regardless of the working directory.
const CONFIG_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "config.yaml",
);

const config = loadConfig(CONFIG_PATH);

function buildAllocationStrategy(name: string) {
  if (name === "round-robin") return new RoundRobinServerStrategy();
  throw new Error("unknown channelAllocationStrategy: " + name);
}

const bus = new InProcessBus();
const coordinator = new Coordinator(bus,
  buildAllocationStrategy(config.channelAllocationStrategy));

// Each signaling server registers itself with the coordinator via the bus
// when constructed. The coordinator must exist before any server is created.
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
const mediaWorker = await MediasoupMediaWorker.create(config.sfuWorker.portRange);
const sfuWorker = new SfuWorker(mediaWorker, bus);

// Start the coordinator and worker before the signaling servers so the
// pipeline is ready before any client can connect.
coordinator.start();
sfuWorker.start((err) => { console.log(err); process.exit(1); });
signalingServers.forEach((s) => s.start());
httpServer.start();
