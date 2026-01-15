/*

Unit test for SfuWorker's pending-consume buffering. When a
C:transportConsumerConsumeEvent arrives before the matching producer
has been created, the worker should buffer it and flush as soon as
C:transportProducerProduceEvent for that producing transport arrives.

Drives the worker directly through the bus — no coordinator, no
signaling server.

*/

import { describe, it, expect } from "vitest";

import { InProcessBus } from "../bus.ts";
import { SfuWorker } from "../worker.ts";
import { FakeMediaWorker } from "../test-fakes/fake-media-worker.ts";
import { waitFor } from "./test-utils.ts";


function buildWorker(): { bus: InProcessBus; worker: SfuWorker; media: FakeMediaWorker } {
  const bus = new InProcessBus();
  const media = new FakeMediaWorker();
  const worker = new SfuWorker(/* workerId */ 0, media, bus);
  worker.start((err) => { throw err; });
  return { bus, worker, media };
}


// Synchronous bus-publish helper that throws on nack, resolves on ack.
function publish<K extends Parameters<InProcessBus["publish"]>[0]>(
  bus: InProcessBus,
  queue: K,
  payload: Parameters<InProcessBus["publish"]>[1],
): Promise<any> {
  return new Promise((resolve, reject) => {
    bus.publish(queue as any, payload as any,
      (resp: any) => resolve(resp),
      (e: Error) => reject(e),
    );
  });
}


describe("SfuWorker", () => {
  it("buffers a consume request and flushes it once the producer exists", async () => {
    const { bus, media } = buildWorker();

    // Allocate router 0 on worker 0.
    await publish(bus, "newRouterRequest", { assignedId: 0, workerId: 0 });

    // Allocate two transports on it: 100 (producer) and 200 (consumer).
    await publish(bus, "newWebRtcTransportRequest",
      { routerId: 0, assignedId: 100, isProducer: true });
    await publish(bus, "newWebRtcTransportRequest",
      { routerId: 0, assignedId: 200, isProducer: false });

    // Track ack/nack for the consume call.
    let consumeResp: any = null;
    let consumeNackErr: Error | null = null;

    // Fire the consume BEFORE the producer is created. This should
    // buffer rather than fail.
    bus.publish("transportUpdateStream", {
      id: 200,
      type: "C:transportConsumerConsumeEvent",
      payload: {
        rtpCapabilities: {} as any,
        producingTransportId: 100,
      },
    }, (resp) => { consumeResp = resp; },
       (e) => { consumeNackErr = e; });

    // Give microtasks a moment. Neither ack nor nack should have fired yet.
    await new Promise((r) => setImmediate(r));
    expect(consumeResp).toBeNull();
    expect(consumeNackErr).toBeNull();

    // Now produce on transport 100.
    await publish(bus, "transportUpdateStream", {
      id: 100,
      type: "C:transportProducerProduceEvent",
      payload: { kind: "audio", rtpParameters: {} as any },
    });

    // Worker should now flush the buffered consume.
    await waitFor(() => consumeResp !== null);
    expect(consumeNackErr).toBeNull();
    expect(consumeResp).toMatchObject({ id: expect.any(String) });

    // Fake bookkeeping: the consumer was created on the consumer transport.
    expect(media.routers[0].transports[1].consumers).toHaveLength(1);
  });

  it("consumes immediately when the producer already exists", async () => {
    const { bus } = buildWorker();

    await publish(bus, "newRouterRequest", { assignedId: 0, workerId: 0 });
    await publish(bus, "newWebRtcTransportRequest",
      { routerId: 0, assignedId: 100, isProducer: true });
    await publish(bus, "newWebRtcTransportRequest",
      { routerId: 0, assignedId: 200, isProducer: false });

    // Produce first.
    await publish(bus, "transportUpdateStream", {
      id: 100,
      type: "C:transportProducerProduceEvent",
      payload: { kind: "audio", rtpParameters: {} as any },
    });

    // Now consume — should resolve directly.
    const resp = await publish(bus, "transportUpdateStream", {
      id: 200,
      type: "C:transportConsumerConsumeEvent",
      payload: {
        rtpCapabilities: {} as any,
        producingTransportId: 100,
      },
    });

    expect(resp).toMatchObject({ id: expect.any(String) });
  });
});
