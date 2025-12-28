try {
  process.loadEnvFile();
} catch {
  // .env file is optional
}

import { InProcessBus } from "./bus.ts";
import { SignalingServer } from "./server.ts";
import { FrontendFacingHttpServer } from "./http-server.ts";
import { SfuWorker } from "./worker.ts";
import { Coordinator } from "./coordinator.ts";
import { MediasoupMediaWorker } from "./media-mediasoup.ts";

import { SSL_KEY_PATH, SSL_CERTS_PATH, SFU_WORKER_PORT_RANGE, SPACE_HTTP_PORT } from "./utils/constants.ts";

import fs from "fs";

// Composition root: construct everything first, then start each service.
// Service constructors are side-effect-free; nothing listens or registers
// handlers until start() is called.

// Only one signaling server today; future work picks the id from
// config or generates it (see Phase 7 in PLANS.md).
const SERVER_ID = 0;

const bus = new InProcessBus();
const coordinator = new Coordinator(bus);
const signalingServer = SignalingServer.create(
  SERVER_ID,
  {
    key: fs.readFileSync(SSL_KEY_PATH, "utf-8"),
    cert: fs.readFileSync(SSL_CERTS_PATH, "utf-8"),
  },
  {
    cors: {
      origin: "http://localhost:5173",
      methods: ["GET", "POST"],
      credentials: true
    },
  },
  3000,
  bus,
);
const httpServer = new FrontendFacingHttpServer(bus, SPACE_HTTP_PORT);
const mediaWorker = await MediasoupMediaWorker.create(SFU_WORKER_PORT_RANGE);
const sfuWorker = new SfuWorker(mediaWorker, bus);

// Start the coordinator and worker before the signaling server so the
// pipeline is ready before any client can connect.
coordinator.start();
sfuWorker.start((err) => { console.log(err); process.exit(1); });
signalingServer.start();
httpServer.start();
