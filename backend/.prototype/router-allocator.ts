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
import type { IIdGenerator } from "./id-gen-port.ts";


export class RouterAllocator {
  bus: IMessageBus
  transportAllocator: TransportAllocator
  idGen: IIdGenerator

  routers: Map<number, Router> = new Map()

  constructor(
    bus: IMessageBus,
    transportAllocator: TransportAllocator,
    idGen: IIdGenerator,
  ) {
    this.bus = bus;
    this.transportAllocator = transportAllocator;
    this.idGen = idGen;
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

    const id = this.idGen.next();
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
