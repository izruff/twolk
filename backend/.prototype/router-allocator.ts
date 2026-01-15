/*

Allocates and tracks mediasoup routers on behalf of spaces.

Owns the `routers` map and the router-id counter. Allocation goes through
the bus as `newRouterRequest` to whichever worker is chosen by the
IAllocationStrategy. On success, the router's RTP capabilities are stored
and the owning space's `primaryRouter` pointer is set.

Worker registration events come in via the bus; the allocator maintains
its own list of available worker IDs and uses the strategy to pick one
per allocation.

Removal cascades into the transport allocator so transports tied to the
removed router are released.

*/

import type { IMessageBus } from "./bus.ts";
import type { Router, Space } from "./domain.ts";
import type { TransportAllocator } from "./transport-allocator.ts";
import type { IIdGenerator } from "./id-gen-port.ts";
import type { IAllocationStrategy } from "./allocation-strategy.ts";


export class RouterAllocator {
  bus: IMessageBus
  transportAllocator: TransportAllocator
  idGen: IIdGenerator
  private _strategy: IAllocationStrategy
  private _workerIds: number[] = []

  routers: Map<number, Router> = new Map()

  constructor(
    bus: IMessageBus,
    transportAllocator: TransportAllocator,
    idGen: IIdGenerator,
    workerStrategy: IAllocationStrategy,
  ) {
    this.bus = bus;
    this.transportAllocator = transportAllocator;
    this.idGen = idGen;
    this._strategy = workerStrategy;

    bus.onMediaWorkerConnected((workerId) => {
      this._workerIds.push(workerId);
    });
    bus.onMediaWorkerDisconnected((workerId) => {
      this._workerIds = this._workerIds.filter((id) => id !== workerId);
    });
  }

  get(routerId: number): Router | undefined {
    return this.routers.get(routerId);
  }

  // Allocates one router per space (the primary router). Picks the worker
  // using the injected strategy; the chosen workerId is sent with the
  // request so other workers skip it silently.
  async allocate(space: Space): Promise<Router> {
    if (space.primaryRouter !== null) {
      return space.primaryRouter;
    }

    if (this._workerIds.length === 0) {
      throw new Error("no media workers available");
    }
    const workerId = this._strategy.pick([...this._workerIds]);

    const id = this.idGen.next();
    const router: Router = {
      id, owningSpace: space,
      rtpCapabilities: null,
      transports: new Map(),
    };
    this.routers.set(id, router);

    return new Promise<Router>((resolve, reject) => {
      this.bus.publish("newRouterRequest", { assignedId: router.id, workerId },
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
