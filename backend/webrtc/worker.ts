/*

Implementation of the SFU worker.
- Receives and sends RTP packets from and to client via WebRTC.
- Routes RTP packets between clients in the same space.
- Facilitates transport to other media-related workers.

*/

import { Coordinator } from "./coordinator.ts";

import mediasoup from "mediasoup";


export class SfuWorker {
  mediasoupWorker: mediasoup.types.Worker
  coordinator: Coordinator

  routers: Map<number, mediasoup.types.Router>

  constructor(worker: mediasoup.types.Worker, coordinator: Coordinator) {
    this.mediasoupWorker = worker;
    this.coordinator = coordinator;

    this.routers = new Map();

    coordinator.consume(
      "newRouterRequest", async ({ assignedId }, ack, nack) => {
        try {
          await this.createRouter(assignedId);
          ack();
        } catch (err: any) {
          nack(err);
        }
      });  // No need for cancel callback since only one worker is used currently
  }

  static async create(
    rtcPortRange: { min: number, max: number },
    coordinator: Coordinator,
    onDied: (err: Error) => void,
  ) {
    const worker = await mediasoup.createWorker({
      rtcMinPort: rtcPortRange.min,
      rtcMaxPort: rtcPortRange.max,
    });

    worker.on("died", onDied);

    return new SfuWorker(worker, coordinator);
  }

  async createRouter(assignedRouterId: number) {
    // TODO: Not sure what the router options should be
    const router = await this.mediasoupWorker.createRouter();
    this.routers.set(assignedRouterId, router);
  }
}

