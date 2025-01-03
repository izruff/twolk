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

type QueuePayloadTypeMap = {
  newRouterRequest: { assignedId: number };
}

type QueueConsumerCallback<K extends keyof QueuePayloadTypeMap> = (
  payload: QueuePayloadTypeMap[K], ack: () => void, nack: (e: Error) => void
) => void | Promise<void>;

type QueueConsumerCallbackCollection = {
  [K in keyof QueuePayloadTypeMap]: QueueConsumerCallback<K>[];
};

export class Coordinator {
  spaces: Map<string, Space>
  members: Map<number, Member>
  routers: Map<number, Router>
  transports: Map<number, Transport>

  queueConsumerCallbacks: QueueConsumerCallbackCollection

  constructor() {
    this.spaces = new Map();
    this.members = new Map();
    this.routers = new Map();
    this.transports = new Map();

    this.queueConsumerCallbacks = { newRouterRequest: [] };
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
  // assume this function acts like it consumes from a message queue.
  consume<K extends keyof QueuePayloadTypeMap>(
    queueName: K, callback: QueueConsumerCallback<K>
  ) {
    const callbackList = this.queueConsumerCallbacks[queueName];
    callbackList.push(callback);
  }
}
