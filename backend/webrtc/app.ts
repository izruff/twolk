try {
  process.loadEnvFile();
} catch {
  // .env file is optional
}

import { InProcessBus } from "./bus.ts";
import { SignalingServer } from "./server.ts";
import { SfuWorker } from "./worker.ts";
import { Coordinator } from "./coordinator.ts";

import { SSL_KEY_PATH, SSL_CERTS_PATH, SFU_WORKER_PORT_RANGE } from "./utils/constants.ts";

import fs from "fs";

const bus = new InProcessBus();

// Constructing the coordinator registers its consumers on the bus; the
// variable isn't used elsewhere yet. Phase 2 will move this side-effect
// into an explicit `start()`.
const coordinator = new Coordinator(bus);

const io = SignalingServer.create(
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

const worker = SfuWorker.create(
  SFU_WORKER_PORT_RANGE,
  bus,
  (err) => { console.log(err); process.exit(1); }
);
