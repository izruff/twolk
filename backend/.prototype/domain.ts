/*

Domain types shared across the coordinator-side services.

These describe what a space/member/router/transport *is*, not how any
service manipulates them. They reference each other circularly (Member →
Space, Space → Router, Router → Transport, etc.) and live in a single
file so the graph is easy to read.

Mediasoup types still leak in through TransportMetadata and
Router.rtpCapabilities; Phase 4 hides those behind a media port.

*/

import type mediasoup from "mediasoup";
import type mediasoupClient from "mediasoup-client";
import type { SpaceLifecyclePolicy } from "./space-lifecycle-policy.ts";


export interface SpaceData {
  name: string;
  description: string;
}

export type SpaceStatus = "initialized" | "running" | "ended";

export interface Space {
  uuid: string;
  status: SpaceStatus;
  policy: SpaceLifecyclePolicy;
  // TODO: This should be a map in the future
  primaryRouter: Router | null;
  data: SpaceData;
  members: Map<number, Member>
}

export interface MemberData {
  name: string;
}

export interface MemberState {
  // Changes made by the client
  isMuted: boolean;

  // Changes made by the server
  transportIsConnected: boolean;
}

export interface Member {
  id: number;
  owningSpace: Space;
  data: MemberData;
  state: MemberState;
  producer: Transport | null;
  memberToConsumerMap: Map<number, Transport>;
}

export interface Router {
  id: number;
  owningSpace: Space;
  rtpCapabilities: mediasoup.types.RtpCapabilities | null;
  transports: Map<number, Transport>;
}

export type TransportStatus = "unallocated" | "allocated" | "connected";

export interface TransportMetadata {
  options: mediasoupClient.types.TransportOptions;
}

export interface Transport {
  id: number;
  owningMember: Member;
  owningRouter: Router;
  consumesFromTransportId?: number;
  status: TransportStatus;
  metadata?: TransportMetadata;
}

export type ClientSideSpace = Omit<Space, "primaryRouter" | "members"> & {
  members: ClientSideMember[];
};

export type ClientSideMember = Omit<Member,
  "owningSpace" | "producer" | "memberToConsumerMap">;
