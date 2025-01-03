/*

Implementation of the coordinator service.
- Keep track of active spaces and their members.
- Allocate resources to members trying to join a space.

In the future, it should also handle scaling the SFU workers horizontally,
managing load distribution and RTP packet transfer between two workers, and
implementing router migration policies from one worker to another.

*/

import mediasoupClient from "mediasoup-client";


interface Space {
  uuid: string;
}

export interface MemberData {
  name: string;
}

export interface MemberState {
  // TODO: isMuted, etc.
}

interface Member {
  id: number;
  spaceUuid: string;
  routerId: string;
  data: MemberData;
  state: MemberState;
  producerId: number;
  memberToConsumerIdMap: Map<number, number>;
}

interface Router {
  id: number;
  spaceUuid: string;
}

type TransportStatus = "unallocated" | "allocated" | "connected";

export interface TransportMetadata {
  options: mediasoupClient.types.TransportOptions;
}

interface Transport {
  id: number;
  routerId: number;
  isProducer: number;
  status: TransportStatus;
  metadata?: TransportMetadata;
}

// Most of these should have a message tag if we want to have more than one
// signaling server or SFU worker, but we only use one for now, so no tags
// needed.
// TODO: The payloads for the result queues all assume that they never fail.
// Currently, if something fails, the worker or signaling server throws an
// error or process exits.
type QueuePayloadTypeMap = {
  newRouterRequest: { assignedId: number };
  openSpaceResult: undefined;
  addMemberResult: { memberId: number };
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

  static _memberIdCounter: number = 0

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

  async openSpace(uuid: string) {
    // TODO
    return;
  }

  async closeSpace(uuid: string, validationToken?: string) {
    // TODO
    return;
  }

  async addMemberToSpace(spaceUuid: string, tempId: string,
    memberData: MemberData, memberState: MemberState) {
    // TODO
    return;
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
}
