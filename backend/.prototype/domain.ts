/**
 * Shared coordinator-side domain model.
 *
 * These types are used by the coordinator service to represent spaces and
 * their members, as well as proxies for media objects like routers and
 * transports.
 *
 * TODO(mediasoup-decoupling): Some of the types here still depend on
 * `mediasoup`. We need to decouple them and use the types which will be
 * defined in `media-port.ts` in the future.
 */

import type mediasoup from "mediasoup";
import type mediasoupClient from "mediasoup-client";
import type { SpaceLifecyclePolicy } from "./space-lifecycle-policy.ts";


/** Metadata supplied by the creator of a space. */
export interface SpaceData {
  name: string;
  description: string;
}

/** Lifecycle state of a space. */
export type SpaceStatus = "initialized" | "running" | "ended";

/** Coordinator-side aggregate for one conferencing room. */
export interface Space {
  uuid: string;
  status: SpaceStatus;
  policy: SpaceLifecyclePolicy;
  // TODO: Support multiple routers per space instead of a single primary router.
  primaryRouter: Router | null;
  data: SpaceData;
  members: Map<number, Member>
}

/** Metadata and other immutable data supplied by the user. */
export interface MemberData {
  name: string;
}

/** Mutable states of a member. */
export interface MemberState {
  /** Client-controlled mute state. */
  isMuted: boolean;

  /** True after the producer transport completes DTLS connection. */
  transportIsConnected: boolean;
}

/** Coordinator-side participant record. */
export interface Member {
  id: number;
  owningSpace: Space;
  data: MemberData;
  state: MemberState;
  producer: Transport | null;
  memberToConsumerMap: Map<number, Transport>;
}

/** Logical media router allocated to a space. */
export interface Router {
  id: number;
  owningSpace: Space;
  // TODO: We need to decouple this from `mediasoup`; see `media-port.ts`.
  rtpCapabilities: mediasoup.types.RtpCapabilities | null;
  transports: Map<number, Transport>;
}

/** Allocation and connection status for a WebRTC transport. */
export type TransportStatus = "unallocated" | "allocated" | "connected";

/** Parameters returned by the worker for client-side transport creation. */
export interface TransportMetadata {
  // TODO: We need to decouple this from `mediasoup`; see `media-port.ts`.
  options: mediasoupClient.types.TransportOptions;
}

/** Coordinator-side reference to a producer or consumer WebRTC transport. */
export interface Transport {
  id: number;
  owningMember: Member;
  owningRouter: Router;
  consumesFromTransportId?: number;
  status: TransportStatus;
  metadata?: TransportMetadata;
}

/** Space projection sent to clients through signaling. */
export type ClientSideSpace = Pick<Space, "uuid" | "data"> & {
  members: ClientSideMember[];
};

/** Member projection sent to clients through signaling. */
export type ClientSideMember = Omit<Member,
  "owningSpace" | "producer" | "memberToConsumerMap">;
