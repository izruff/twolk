import { createWsSignalingServer } from "./server.ts";
import { SfuWorker } from "./worker.ts";
import { Coordinator } from "./coordinator.ts";

import { SSL_KEY_PATH, SSL_CERTS_PATH, SFU_WORKER_PORT_RANGE } from "./constants.ts";

import fs from "fs";

const coordinator = new Coordinator();

const io = createWsSignalingServer(
  {
    key: fs.readFileSync(SSL_KEY_PATH, "utf-8"),
    cert: fs.readFileSync(SSL_CERTS_PATH, "utf-8"),
  },
  3000,
  coordinator,
);

const worker = SfuWorker.create(
  SFU_WORKER_PORT_RANGE,
  coordinator,
  (err) => { console.log(err); process.exit(1); }
);
