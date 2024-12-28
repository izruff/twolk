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

interface MemberState {
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

export class Coordinator {
  spaces: Map<string, Space>
  members: Map<number, Member>
  routers: Map<number, Router>
  transports: Map<number, Transport>

  constructor() {
    this.spaces = new Map();
    this.members = new Map();
    this.routers = new Map();
    this.transports = new Map();
  }

  openSpace(id: string) {
    // TODO
    return;
  }

  closeSpace(id: string, validationToken?: string) {
    // TODO
    return;
  }

  addMemberToSpace(spaceId: string): { memberId: string } {
    // TODO
    return { memberId: "" };
  }

  removeMemberFromSpace(spaceId: number, producerId: number) {
    // TODO
    return;
  }
}
