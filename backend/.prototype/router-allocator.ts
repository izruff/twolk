import type { IMessageBus } from "./bus.ts";
import type { Router, Space } from "./domain.ts";
import type { TransportAllocator } from "./transport-allocator.ts";
import type { IIdGenerator } from "./id-gen-port.ts";
import type { IAllocationStrategy } from "./allocation-strategy.ts";


/**
 * Coordinator-side subservice that allocates and tracks media routers.
 *
 * This class owns router IDs and the coordinator router map. It also keeps
 * track of available SFU workers through observers which the coordinator
 * attaches to the bus. Workers own the actual media routers and are addressed
 * through bus requests.
 *
 * TODO: This class currently only supports primary routers. We may want to
 * support multiple routers per space in the future.
 *
 * TODO: This class should be extended to support router failure handling,
 * removal, and re-allocation. Or perhaps some of these are better handled
 * some other way.
 */
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
      // TODO: Reject or replace duplicate worker ids instead of appending them.
      this._workerIds.push(workerId);
    });
    bus.onMediaWorkerDisconnected((workerId) => {
      this._workerIds = this._workerIds.filter((id) => id !== workerId);
    });
  }

  get(routerId: number): Router | undefined {
    return this.routers.get(routerId);
  }

  /**
   * Allocates the primary router for a space.
   *
   * If the space already has a primary router, that router is returned.
   */
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
          // TODO: Add proper failure handling and remove the pending router
          // coordinator-side object.
          reject(new Error("newRouterRequest nacked: " + e.message));
        });
    });
  }

  /** Removes a router and its coordinator-side transport records. */
  async remove(routerId: number): Promise<void> {
    const router = this.routers.get(routerId);
    if (router === undefined) {
      return;
    }

    // Clean up associated transports.
    router.transports.forEach((transport) => {
      this.transportAllocator.remove(transport.id);
    });

    // TODO: Send a worker command to close the actual media router.
    this.routers.delete(routerId);
  }
}
