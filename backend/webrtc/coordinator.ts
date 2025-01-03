/*

Implementation of the coordinator service.
- Keep track of active spaces and their members.
- Allocate resources to members trying to join a space.

In the future, it should also handle scaling the SFU workers horizontally,
managing load distribution and RTP packet transfer between two workers, and
implementing router migration policies from one worker to another.

*/

import mediasoup from "mediasoup";
import mediasoupClient from "mediasoup-client";


export interface SpaceData {
  rtpCapabilities: mediasoup.types.RtpCapabilities,
}

interface Space {
  uuid: string;
  primaryRouter: Router;
  data: SpaceData;
  members: Map<number, Member>
}

export interface MemberData {
  name: string;
}

export interface MemberState {
  // TODO: isMuted, etc.
}

interface Member {
  id: number;
  space: Space;
  router: Router;
  data: MemberData;
  state: MemberState;
  producer: Transport;
  memberToConsumerMap: Map<number, Transport>;
}

interface Router {
  id: number;
  space: Space;
}

type TransportStatus = "unallocated" | "allocated" | "connected";

export interface TransportMetadata {
  options: mediasoupClient.types.TransportOptions;
}

interface Transport {
  id: number;
  router: Router;
  isProducer: boolean;
  status: TransportStatus;
  metadata?: TransportMetadata;
}

// Most of these should have a message tag if we want to have more than one
// signaling server or SFU worker, but we only use one for now, so no tags
// needed.
// TODO: The payloads for the result queues all assume that they never fail.
// Currently, if something fails, the worker or signaling server throws an
// error or process exits.
export type QueuePayloadTypeMap = {
  newRouterRequest: { assignedId: number };
  openSpaceResult: {
    uuid: string,
    data: SpaceData,
  };
  addMemberResult: {
    id: number,
    spaceUuid: string,
    data: MemberData,
    state: MemberState,
    tempId: string,
  };
}

type QueueConsumerCallback<K extends keyof QueuePayloadTypeMap> = (
  payload: QueuePayloadTypeMap[K], ack: () => void, nack: (e: Error) => void
) => void | Promise<void>;

type QueueConsumerCallbackCollection = {
  [K in keyof QueuePayloadTypeMap]: Set<QueueConsumerCallback<K>>;
};


export class Coordinator {
  // This is a mock implementation of a service which will later only receive
  // requests in gRPC.

  spaces: Map<string, Space>
  members: Map<number, Member>
  routers: Map<number, Router>
  transports: Map<number, Transport>

  queueConsumerCallbacks: QueueConsumerCallbackCollection

  // These should be okay because these resources are not permanent and the
  // traffic should not exceed this maximum limit.
  static MAX_COUNTER = 2 << 32
  static _routerIdCounter = 0
  static _memberIdCounter = 0
  static _transportIdCounter = 0

  constructor() {
    this.spaces = new Map();
    this.members = new Map();
    this.routers = new Map();
    this.transports = new Map();

    // TODO: Automate this set instantiations
    this.queueConsumerCallbacks = {
      newRouterRequest: new Set(),
      openSpaceResult: new Set(),
      addMemberResult: new Set(),
    };
  }

  _getNewRouterId() {
    const id = Coordinator._routerIdCounter;
    Coordinator._routerIdCounter = (Coordinator._routerIdCounter + 1) % Coordinator.MAX_COUNTER;
  }

  _getNewMemberId() {
    const id = Coordinator._memberIdCounter;
    Coordinator._memberIdCounter = (Coordinator._memberIdCounter + 1) % Coordinator.MAX_COUNTER;
  }

  _createNewTransport(router: Router, isProducer: boolean): Transport {
    const id = Coordinator._transportIdCounter;
    Coordinator._transportIdCounter = (Coordinator._transportIdCounter + 1) % Coordinator.MAX_COUNTER;

    const transport: Transport = { id, router, isProducer, status: "unallocated" };
    this.transports.set(id, transport);
    this._allocateTransport(transport);

    return transport;
  }

  _allocateTransport(transport: Transport) {
    // TODO
  }

  // When we scale the workers, we might need this to distribute members across
  // multiple resources. For now, we just allocate one router for each space;
  // we call this the primary router.
  _allocateRouter(space: Space): Router {
    return space.primaryRouter;
  }

  async openSpace(uuid: string) {
    // Allocate a router for this space. For now, we assume each space uses
    // exactly one router, and only one worker is present.
    const assignedId = Coordinator._routerIdCounter;
    Coordinator._routerIdCounter = (Coordinator._routerIdCounter + 1) % Coordinator.MAX_COUNTER;

    this.publish("newRouterRequest", { assignedId }, () => {
      // Deep-copy the object instead of sharing reference
      const space = structuredClone(this.routers.get(assignedId)!.space);
      this.publish("openSpaceResult", { uuid: space.uuid, data: space.data },
        () => {
          // No need to do anything for now.
        },
        (e: Error) => {
          // TODO: Need retry mechanism
          throw new Error("openSpaceResult nacked: " + e.message);
        });
    }, (e: Error) => {
      // TODO: Need retry mechanism
      throw new Error("newRouterRequest nacked: " + e.message);
    });
  }

  async closeSpace(uuid: string, validationToken?: string) {
    // TODO
    return;
  }

  async addMemberToSpace(spaceUuid: string, tempId: string,
    memberData: MemberData, memberState: MemberState) {
    const id = Coordinator._memberIdCounter;
    Coordinator._memberIdCounter = (Coordinator._memberIdCounter + 1) % Coordinator.MAX_COUNTER;

    const space = this.spaces.get(spaceUuid)!;
    const router = this._allocateRouter(space);
    const newMember: Member = {
      id, space, router, data: memberData, state: memberState,
      producer: this._createNewTransport(router, true),
      memberToConsumerMap: new Map(),
    };
    space.members.forEach((other) => {
      if (other.id !== id) {
        newMember.memberToConsumerMap.set(other.id,
          this._createNewTransport(router, false));
      }
    });
    this.members.set(id, newMember);
    space.members.set(id, newMember);

    this.publish("addMemberResult", {
      id, spaceUuid, data: memberData, state: memberState, tempId
    }, () => {
      // No need to do anything for now.
    }, (e: Error) => {
      // TODO: Need retry mechanism
      throw new Error("addMemberResult nacked: " + e.message);
    });
  }

  async removeMemberFromSpace(spaceUuid: string, memberId: number) {
    // TODO
    return;
  }

  // This is supposed to come from a message broker client class, but here we
  // assume this function acts like it consumes from a message queue. Also,
  // we don't implement tags here; for simplicity we just include tags in the
  // message content if needed.
  consume<K extends keyof QueuePayloadTypeMap>(
    queueName: K, callback: QueueConsumerCallback<K>
  ): (() => void) {
    const callbackSet = this.queueConsumerCallbacks[queueName];
    callbackSet.add(callback);

    const cancelCallback = () => {
      callbackSet.delete(callback);
    };
    return cancelCallback;
  }

  // Again, this function acts like it publishes to a message queue. Think of
  // the ack() and nack() functions as a message to a reply-to queue, used for
  // acknowledging the message and notifying the publisher if it was successful
  // or not.
  // TODO: We are under the assumption that there is only one consumer per
  // queue, which allows for ack() to take no parameters.
  publish<K extends keyof QueuePayloadTypeMap>(
    queueName: K, payload: QueuePayloadTypeMap[K],
    onAck: () => void, onNack: (e: Error) => void,
  ) {
    this.queueConsumerCallbacks[queueName].forEach((callback) => {
      callback(payload, onAck, onNack);
    });
  }
}
