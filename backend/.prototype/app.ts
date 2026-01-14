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


// Resolve config.yaml relative to this file so the path is correct
// regardless of the working directory.
const CONFIG_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "config.yaml",
);

const config = loadConfig(CONFIG_PATH);

const bus = new InProcessBus();
const coordinator = new Coordinator(bus);
const signalingServer = SignalingServer.create(
  config.signalingServer.id,
  config.tls,
  {
    cors: {
      origin: config.webOrigin,
      methods: ["GET", "POST"],
      credentials: true,
    },
  },
  config.signalingServer.port,
  bus,
);
const httpServer = new FrontendFacingHttpServer(
  bus, config.httpServer.port, config.tls, config.webOrigin);
const mediaWorker = await MediasoupMediaWorker.create(config.sfuWorker.portRange);
const sfuWorker = new SfuWorker(mediaWorker, bus);

// Start the coordinator and worker before the signaling server so the
// pipeline is ready before any client can connect.
coordinator.start();
sfuWorker.start((err) => { console.log(err); process.exit(1); });
signalingServer.start();
httpServer.start();
