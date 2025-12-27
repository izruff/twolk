/*

Per-channel state for one client. Created by SignalingServer the moment
a channel is accepted; runs the join handshake, wires the channel's
event listeners, and tears everything down on close.

Owns:
- the IClientChannel
- the memberId, once prepareMember resolves
- the lifetime of the channel's event listeners

Delegates all cross-channel state (spaces, members map, the
memberId→channel registry) and bus publishes to SignalingServer.

*/

import type { IMessageBus, SpaceUpdateSTypes } from "./bus.ts";
import type { IClientChannel } from "./client-channel-port.ts";
import type { MemberData, MemberState } from "./domain.ts";
import type {
  SignalingServer, ClientToServerEvents, ServerToClientEvents,
} from "./server.ts";
import { getClientSideSpace } from "./server.ts";


// Client events that the server just forwards to the coordinator as the
// matching `S:*` space update, then acks the client when the coordinator
// acks the server. Produce/consume add extra fields to their acks.
const FORWARD_AND_ACK_LISTEN_EVENTS_MAP: Map<keyof ClientToServerEvents,
  SpaceUpdateSTypes> = new Map([
    ["transportProducerConnect", "S:memberProducerConnectEvent"],
    ["transportProducerProduce", "S:memberProducerProduceEvent"],
    ["transportConsumerConnect", "S:memberConsumerConnectEvent"],
    ["transportConsumerConsume", "S:memberConsumerConsumeEvent"],
    ["transportConsumerResume", "S:memberConsumerResumeEvent"],
  ]);


type Channel = IClientChannel<ClientToServerEvents, ServerToClientEvents>;


export class MemberSession {
  channel: Channel
  bus: IMessageBus
  server: SignalingServer

  memberId: number | null = null

  constructor(channel: Channel, bus: IMessageBus, server: SignalingServer) {
    this.channel = channel;
    this.bus = bus;
    this.server = server;
  }

  async start(): Promise<void> {
    console.log(`[${this.channel.id}] connected`);

    this.channel.onClose(() => {
      console.log(`[${this.channel.id}] disconnected`);
      if (this.memberId !== null) {
        this.server.unregisterChannel(this.memberId);
        this.server.deleteMember(this.memberId);
      }
    });

    const { spaceUuid, memberData, memberState } =
      this.channel.auth as {
        spaceUuid: string,
        memberData: MemberData,
        memberState: MemberState,
      };

    try {
      await this.server.prepareSpace(spaceUuid);
      this.channel.emit("connectionSuccessful");
      console.log(`[${this.channel.id}] sent connectionSuccessful`);

      const memberId = await this.server.prepareMember(spaceUuid,
        memberData, {
          ...memberState,
          transportIsConnected: false,
        });

      const space = this.server.getSpace(spaceUuid)!;

      // Start listening to client messages

      this.channel.on("createWebRtcTransport", (async (_args, _cId) => {
        // TODO: We're supposed to let the coordinator know to check if the
        // transport is being processed, and start processing if not.
      }) as ClientToServerEvents["createWebRtcTransport"]);

      this.channel.on("resendSpaceInit", (async (_cId) => {
        // TODO: Handle this; we don't need to tell the coordinator.
      }) as ClientToServerEvents["resendSpaceInit"]);

      this.channel.on("updateMemberState", (async ({ newState }, cId) => {
        console.log(`[${this.channel.id}] received updateMemberState; newState:`, newState, "cId:", cId);
        try {
          this.server.updateMember(memberId, newState);
          this.channel.emit("updateMemberStateAck", cId);
          console.log(`[${this.channel.id}] sent updateMemberStateAck; cId:`, cId);
        } catch (_err) {
          // TODO: Need to handle failure properly
          this.channel.emit("updateMemberStateAck", cId);
          console.log(`[${this.channel.id}] sent updateMemberStateAck; cId:`, cId);
        }
      }) as ClientToServerEvents["updateMemberState"]);

      // For all these message types, the signaling server simply forwards it
      // to the coordinator.
      FORWARD_AND_ACK_LISTEN_EVENTS_MAP.forEach((spaceUpdateType,
        clientEventType) => {
          this.channel.on(clientEventType, (async (data: any, cId: string) => {
            console.log(`[${this.channel.id}] received ${clientEventType}; data:`, data, "cId:", cId);
            this.bus.publish("spaceUpdateStream", {
              uuid: spaceUuid,
              type: spaceUpdateType,
              payload: { memberId, data },
            } as any, (resp: any) => {
              // Acknowledge to the client. Produce/consume require extra
              // fields from the response to set up the client-side
              // producer/consumer object.
              if (clientEventType === "transportProducerProduce") {
                this.channel.emit("transportProducerProduceAck", cId, resp!.id);
              } else if (clientEventType === "transportConsumerConsume") {
                this.channel.emit("transportConsumerConsumeAck", cId,
                  resp!.id, resp!.producerId!, resp!.kind!, resp!.rtpParameters!);
              } else {
                this.channel.emit((clientEventType + "Ack") as keyof ServerToClientEvents, cId);
              }
              console.log(`[${this.channel.id}] sent ${clientEventType + "Ack"}; cId:`, cId);
            }, (e: Error) => {
              // TODO: Need retry mechanism, then notify client on failure
              console.error(`[${this.channel.id}] failed to forward ${clientEventType}:`,
                e.message);
            });
          }) as any);
        });

      // This message also serves as confirmation that the client can start
      // sending messages back to the server.
      console.log(`Member ${memberId} successfully joined space ${spaceUuid}`);
      this.channel.emit("memberEvent", "spaceInit", {
        receivingMemberId: memberId,
        routerRtpCapabilities: space.routerRtpCapabilities,
        clientSideSpace: getClientSideSpace(space),
      });
      console.log(`[${this.channel.id}] sent memberEvent spaceInit; receivingMemberId:`,
        memberId, "routerRtpCapabilities:", space.routerRtpCapabilities, "clientSideSpace:", getClientSideSpace(space));

      // This map will be used to broadcast updates, and this insertion needs
      // to be performed with the memberEvent emission atomically; we want to
      // make sure no updates are missed.
      this.memberId = memberId;
      this.server.registerChannel(memberId, this.channel);
    } catch (err: any) {
      console.log(err);
      this.channel.emit("connectionFailed", { message: "" });
      console.log(`[${this.channel.id}] sent connectionFailed`);
    }
  }
}
