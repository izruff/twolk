import type { IMessageBus, SpaceUpdateSTypes } from "./bus.ts";
import type { IClientChannel } from "./client-channel-port.ts";
import type { MemberData, MemberState } from "./domain.ts";
import type {
  SignalingServer, ClientToServerEvents, ServerToClientEvents,
} from "./server.ts";
import { getClientSideSpace } from "./server.ts";


/**
 * Client events forwarded to the coordinator as matching `S:*` updates.
 *
 * The session acknowledges the client after the coordinator acknowledges the
 * forwarded space update. Produce and consume acknowledgements include
 * additional media ids and parameters.
 */
const FORWARD_AND_ACK_LISTEN_EVENTS_MAP: Map<keyof ClientToServerEvents,
  SpaceUpdateSTypes> = new Map([
    ["transportProducerConnect", "S:memberProducerConnectEvent"],
    ["transportProducerProduce", "S:memberProducerProduceEvent"],
    ["transportConsumerConnect", "S:memberConsumerConnectEvent"],
    ["transportConsumerConsume", "S:memberConsumerConsumeEvent"],
    ["transportConsumerResume", "S:memberConsumerResumeEvent"],
  ]);


type Channel = IClientChannel<ClientToServerEvents, ServerToClientEvents>;
type SimpleForwardAckEvent = "transportProducerConnectAck"
  | "transportConsumerConnectAck"
  | "transportConsumerResumeAck";


/**
 * An abstraction of a member connection to the signaling server.
 * 
 * It owns one client channel and its member lifecycle, and handles channel
 * messages from and to the client via the relevant application-level protocol.
 *
 * TODO: Track registered handlers so `close` cleanup can remove them before
 * dropping the channel reference.
 */
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

  /** Starts the join handshake and client event handling for this channel. */
  async start(): Promise<void> {
    this.channel.onClose(() => {
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

      const memberId = await this.server.prepareMember(spaceUuid,
        memberData, {
          ...memberState,
          transportIsConnected: false,
        });

      const space = this.server.getSpace(spaceUuid)!;

      // Start listening to client messages.

      this.channel.on("createWebRtcTransport", (async (_args, _cId) => {
        // TODO: Implement client-requested transport retry or readiness check.
      }) as ClientToServerEvents["createWebRtcTransport"]);

      this.channel.on("resendSpaceInit", (async (_cId) => {
        // TODO: Resend spaceInit from this server mirror without coordinator IO.
      }) as ClientToServerEvents["resendSpaceInit"]);

      this.channel.on("updateMemberState", (async ({ newState }, cId) => {
        try {
          this.server.updateMember(memberId, newState);
          this.channel.emit("updateMemberStateAck", cId);
        } catch (_err) {
          // TODO: Send a failure acknowledgement shape instead of success ack.
          this.channel.emit("updateMemberStateAck", cId);
        }
      }) as ClientToServerEvents["updateMemberState"]);

      // Forward media handshake events to the coordinator.
      FORWARD_AND_ACK_LISTEN_EVENTS_MAP.forEach((spaceUpdateType,
        clientEventType) => {
          this.channel.on(clientEventType, (async (data: any, cId: string) => {
            this.bus.publish("spaceUpdateStream", {
              uuid: spaceUuid,
              type: spaceUpdateType,
              payload: { memberId, data },
            } as any, (resp: any) => {
              // Produce and consume require extra fields to create the
              // browser-side producer or consumer.
              if (clientEventType === "transportProducerProduce") {
                this.channel.emit("transportProducerProduceAck", cId, resp!.id);
              } else if (clientEventType === "transportConsumerConsume") {
                this.channel.emit("transportConsumerConsumeAck", cId,
                  resp!.id, resp!.producerId!, resp!.kind!, resp!.rtpParameters!);
              } else {
                this.channel.emit((clientEventType + "Ack") as SimpleForwardAckEvent, cId);
              }
            }, (e: Error) => {
              // TODO: Add retry or emit client-visible failure.
              console.error(`[${this.channel.id}] failed to forward ${clientEventType}:`,
                e.message);
            });
          }) as any);
        });

      // This message also confirms that the client can send media commands.
      this.channel.emit("memberEvent", "spaceInit", {
        receivingMemberId: memberId,
        routerRtpCapabilities: space.routerRtpCapabilities,
        clientSideSpace: getClientSideSpace(space),
      });

      // Register the channel after spaceInit so broadcasts cannot arrive
      // before the initial space snapshot reaches the client.
      this.memberId = memberId;
      this.server.registerChannel(memberId, this.channel);
    } catch (err: any) {
      // TODO: Return a specific client-safe connection error.
      console.log(err);
      this.channel.emit("connectionFailed", { message: "" });
    }
  }
}
