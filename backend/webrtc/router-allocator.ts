/*

Allocates and tracks mediasoup routers on behalf of spaces.

Owns the `routers` map and the router-id counter. Allocation goes through
the bus as `newRouterRequest` to whichever worker handles it. On success,
the router's RTP capabilities are stored and the owning space's
`primaryRouter` pointer is set.

Removal cascades into the transport allocator so transports tied to the
removed router are released.

*/

import type { IMessageBus } from "./bus.ts";
import type { Router, Space } from "./domain.ts";
import type { TransportAllocator } from "./transport-allocator.ts";


export class RouterAllocator {
  bus: IMessageBus
  transportAllocator: TransportAllocator

  routers: Map<number, Router> = new Map()

  // TODO: Phase 7 replaces these statics with an injected IIdGenerator.
  static MAX_COUNTER = Number.MAX_SAFE_INTEGER
  static _idCounter = 0

  constructor(bus: IMessageBus, transportAllocator: TransportAllocator) {
    this.bus = bus;
    this.transportAllocator = transportAllocator;
  }

  _getNewId() {
    const id = RouterAllocator._idCounter;
    RouterAllocator._idCounter = (RouterAllocator._idCounter + 1) % RouterAllocator.MAX_COUNTER;
    return id;
  }

  get(routerId: number): Router | undefined {
    return this.routers.get(routerId);
  }

  // When we scale the workers, we might need this to distribute members across
  // multiple resources. For now, we just allocate one router for each space;
  // we call this the primary router.
  async allocate(space: Space): Promise<Router> {
    if (space.primaryRouter !== null) {
      return space.primaryRouter;
    }

    const id = this._getNewId();
    const router: Router = {
      id, owningSpace: space,
      rtpCapabilities: null,
      transports: new Map(),
    };
    this.routers.set(id, router);

    return new Promise<Router>((resolve, reject) => {
      this.bus.publish("newRouterRequest", { assignedId: router.id },
        ({ rtpCapabilities }) => {
          router.rtpCapabilities = rtpCapabilities;
          space.primaryRouter = router;
          resolve(router);
        },
        (e: Error) => {
          reject(new Error("newRouterRequest nacked: " + e.message));
        });
    });
  }

  async remove(routerId: number): Promise<void> {
    const router = this.routers.get(routerId);
    if (router === undefined) {
      return;
    }

    // Clean up associated transports
    router.transports.forEach((transport) => {
      this.transportAllocator.remove(transport.id);
    });

    // TODO: Need to send message to SFU worker to deallocate.
    this.routers.delete(routerId);
  }
}
