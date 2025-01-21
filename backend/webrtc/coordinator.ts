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
  // Requests from coordinator to create a new router for a space
  newRouterRequest: {
    assignedId: number,
  };
  newTransportRequest: {
    routerId: number,
    consumesFromTransportId?: number,  // Only for consumer transports
  };
  subscribeToSpaceRequest: {
    uuid: string,
  };
  addMemberRequest: {
    spaceUuid: string,
    memberData: MemberData,
    memberState: MemberState,
  };
  removeMemberRequest: {
    id: number,
  }
  unsubscribeFromSpaceRequest: {
    uuid: string,
  };
  spaceUpdateStream: {
    uuid: string,
  };
  transportUpdateStream: {
    id: number,
  };
}

export type QueueResponseTypeMap = {
  newRouterRequest: void;
  newTransportRequest: void;
  subscribeToSpaceRequest: {
    data: SpaceData,
  };
  addMemberRequest: {
    id: number,
  };
  removeMemberRequest: void;
  unsubscribeFromSpaceRequest: void;
  spaceUpdateStream: void;
  transportUpdateStream: void;
}

// Maybe not the best way to do this? Ideally, the queue types should be defined before the other two.
type QueueTypes = keyof QueuePayloadTypeMap & keyof QueueResponseTypeMap;

export type QueueConsumerCallback<K extends QueueTypes> = (
  payload: QueuePayloadTypeMap[K], ack: (resp: QueueResponseTypeMap[K]) => void, nack: (e: Error) => void
) => void | Promise<void>;

type QueueConsumerCallbackCollection = {
  [K in QueueTypes]: Set<QueueConsumerCallback<K>>;
};


export class Coordinator {
  /*
  This is a mock implementation of the coordinator service. In reality, this service
  should be a separate microservice that communicates with the signaling server
  and SFU workers via gRPC bidirectional streaming.
  
  The `queueConsumerCallbacks` map was meant to simulate message queues that the
  coordinator service would publish to/consume from. Originally, it was meant as a
  message broker simulator, but after some thinking, our needs are more aligned to a
  request-response pattern that goes both ways; gRPC would be better suited for this.

  Instead of changing the code to fit gRPC right away, we keep this as is for now,
  but make it so that we can send messages both ways.
  */

  spaces: Map<string, Space>
  members: Map<number, Member>
  routers: Map<number, Router>
  transports: Map<number, Transport>

  queueConsumerCallbacks: QueueConsumerCallbackCollection

  // These should be okay because these resources are not permanent and the
  // traffic should not exceed this maximum limit.
  static MAX_COUNTER = Number.MAX_SAFE_INTEGER
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
      newTransportRequest: new Set(),
      subscribeToSpaceRequest: new Set(),
      addMemberRequest: new Set(),
      removeMemberRequest: new Set(),
      unsubscribeFromSpaceRequest: new Set(),
      spaceUpdateStream: new Set(),
      transportUpdateStream: new Set(),
    };

    this.consume("subscribeToSpaceRequest", this.onSubscribeToSpaceRequest);
    this.consume("addMemberRequest", this.onAddMemberRequest);
    this.consume("removeMemberRequest", this.onRemoveMemberRequest);
    this.consume("unsubscribeFromSpaceRequest", this.onUnsubscribeFromSpaceRequest);
    this.consume("transportUpdateStream", this.onTransportUpdate);
  }

  _getNewRouterId() {
    const id = Coordinator._routerIdCounter;
    Coordinator._routerIdCounter = (Coordinator._routerIdCounter + 1) % Coordinator.MAX_COUNTER;
    return id;
  }

  _getNewMemberId() {
    const id = Coordinator._memberIdCounter;
    Coordinator._memberIdCounter = (Coordinator._memberIdCounter + 1) % Coordinator.MAX_COUNTER;
    return id;
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

  // This is supposed to come from a message broker client class, but here we
  // assume this function acts like it consumes from a message queue. Also,
  // we don't implement tags here; for simplicity we just include tags in the
  // message content if needed.
  consume<K extends QueueTypes>(
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
  publish<K extends QueueTypes>(
    queueName: K, payload: QueuePayloadTypeMap[K],
    onAck: (resp: QueueResponseTypeMap[K]) => void,
    onNack: (e: Error) => void,
  ) {
    this.queueConsumerCallbacks[queueName].forEach((callback) => {
      callback(payload, onAck, onNack);
    });
  }

  onSubscribeToSpaceRequest: QueueConsumerCallback<"subscribeToSpaceRequest"> =
    ({ uuid }, ack, nack) => {
      // Allocate a router for this space. For now, we assume each space uses
      // exactly one router, and only one worker is present.
      const assignedId = this._getNewRouterId();

      this.publish("newRouterRequest", { assignedId }, () => {
        // Deep-copy the object instead of sharing reference
        const space = this.routers.get(assignedId)!.space;
        ack({ data: structuredClone(space.data) });
      }, (e: Error) => {
        // TODO: Need retry mechanism
        throw new Error("newRouterRequest nacked: " + e.message);
      });
    }

  onAddMemberRequest: QueueConsumerCallback<"addMemberRequest"> =
    ({ spaceUuid, memberData, memberState }, ack, nack) => {
      const id = this._getNewMemberId();

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

      ack({ id });
    };

  onRemoveMemberRequest: QueueConsumerCallback<"removeMemberRequest"> =
    ({ id }, ack, nack) => {
      const member = this.members.get(id);
      if (member === undefined) {
        nack(new Error("member not found"));
        return;
      }

      this.transports.forEach((transport) => {
        if (transport.router.id === member.router.id) {
          this.transports.delete(transport.id);
        }
      });

      // TODO: These transports will require some cleanup.
      this.transports.delete(member.producer.id);
      member.memberToConsumerMap.forEach((transport) => {
        this.transports.delete(transport.id);
      });

      member.space.members.delete(id);
      this.members.delete(id);

      ack();
    };

  onUnsubscribeFromSpaceRequest: QueueConsumerCallback<"unsubscribeFromSpaceRequest"> =
    ({ uuid }, ack, nack) => {
      const space = this.spaces.get(uuid);
      if (space === undefined) {
        nack(new Error("space not found"));
        return;
      }
      if (space.members.size > 0) {
        nack(new Error("space still not empty"));
        return;
      }

      // TODO: Clean up routers associated to the space

      this.spaces.delete(uuid);

      ack();
    };

  onTransportUpdate: QueueConsumerCallback<"transportUpdateStream"> =
    ({ id }, ack, nack) => {
      const transport = this.transports.get(id);
      if (transport === undefined) {
        nack(new Error("transport not found"));
        return;
      }
      
      // TODO: Handle transport updates

      ack();
    }
}
