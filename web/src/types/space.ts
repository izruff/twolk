import mediasoupClient from 'mediasoup-client';

import { Member, type MemberData, type MemberState, type MemberClientEventType } from "./member";
import type { SignalingSocketWrapper, ClientSideMember, ClientSideSpace } from "./signaling.socket";
import { ConsumerTransport, ProducerTransport, TransportFactory } from "./transport";


export interface SpaceData {
  name: string;
}


export class Space {
  uuid: string;
  data: SpaceData;

  _producerMember: Member<ProducerTransport>;
  _producerMemberId: number | null;
  _consumerMembers: Map<number, Member<ConsumerTransport>>;

  _socket: SignalingSocketWrapper;
  _transportFactory: TransportFactory;

  _consumerMemberEventHandlers: ((memberId: number, event: MemberClientEventType) => void)[] = [];

  _connectedHandler: (() => void) | null = null;
  _disconnectedHandler: (() => void) | null = null;
  _failedHandler: ((error: { message: string }) => void) | null = null;

  _memberJoinHandlers: ((memberId: number) => void)[] = [];
  _memberLeaveHandlers: ((memberId: number) => void)[] = [];
  _memberStateUpdateHandlers: ((memberId: number) => void)[] = [];
  _spaceCloseHandlers: (() => void)[] = [];
  _spaceInitHandlers: (() => void)[] = [];
  _transportParamsHandlers: ((memberId: number) => void)[] = [];

  _spaceInitReceived: boolean = false;

  constructor(
    uuid: string,
    data: SpaceData,
    producerData: MemberData,
    producerState: MemberState,
    socket: SignalingSocketWrapper,
  ) {
    // The socket is supposed to be disconnected so this class can implement reconnection logic.
    if (socket.status !== "disconnected") {
      throw new Error("socket must be disconnected when creating Space instance");
    }

    this.uuid = uuid;
    this.data = data;
    this._producerMember = new Member<ProducerTransport>(producerData, producerState);
    this._producerMemberId = null;
    this._consumerMembers = new Map();
    this._socket = socket;
    this._transportFactory = new TransportFactory(new mediasoupClient.Device(), socket);
  }

  // Start connecting, will reconnect automatically if disconnected, stops if failed
  init(
    onConnected: () => void,
    onDisconnected: () => void,
    onFailed: (error: { message: string }) => void,
  ) {
    // Start listening to socket events
    this._socket.onConnected(this.onSocketConnected.bind(this));
    this._socket.onDisconnected(this.onSocketDisconnected.bind(this));
    this._socket.onFailed(this.onSocketFailed.bind(this));

    this._socket.onSpaceWideEvent("memberJoin", this.handleMemberJoin.bind(this));
    this._socket.onSpaceWideEvent("memberLeave", this.handleMemberLeave.bind(this));
    this._socket.onSpaceWideEvent("memberStateUpdate", this.handleMemberStateUpdate.bind(this));
    this._socket.onSpaceWideEvent("spaceClose", this.handleSpaceClose.bind(this));

    this._socket.onMemberEvent("spaceInit", this.handleSpaceInit.bind(this));
    this._socket.onMemberEvent("transportParams", this.handleTransportParams.bind(this));

    // Set up user handlers
    this._connectedHandler = onConnected;
    this._disconnectedHandler = onDisconnected;
    this._failedHandler = onFailed;

    this.connect();
  }

  cleanup() {
    // Clear handlers
    this._connectedHandler = null;
    this._disconnectedHandler = null;
    this._failedHandler = null;

    // Stop listening to socket events
    this._socket.offConnected(this.onSocketConnected.bind(this));
    this._socket.offDisconnected(this.onSocketDisconnected.bind(this));
    this._socket.offFailed(this.onSocketFailed.bind(this));

    this._socket.offSpaceWideEvent("memberJoin", this.handleMemberJoin.bind(this));
    this._socket.offSpaceWideEvent("memberLeave", this.handleMemberLeave.bind(this));
    this._socket.offSpaceWideEvent("memberStateUpdate", this.handleMemberStateUpdate.bind(this));
    this._socket.offSpaceWideEvent("spaceClose", this.handleSpaceClose.bind(this));

    this._socket.offMemberEvent("spaceInit", this.handleSpaceInit.bind(this));
    this._socket.offMemberEvent("transportParams", this.handleTransportParams.bind(this));

    this._socket.disconnect();
  }

  onProducerMemberEvent(handler: (event: MemberClientEventType) => void) {
    this._producerMember.onEvent(handler);
  }

  onConsumerMemberEvent(handler: (memberId: number, event: MemberClientEventType) => void) {
    this._consumerMemberEventHandlers.push(handler);
    this._consumerMembers.forEach((member, memberId) => {
      member.onEvent((event: MemberClientEventType) => {
        handler(memberId, event);
      });
    });
  }

  offProducerMemberEvent(handler: (event: MemberClientEventType) => void) {
    this._producerMember.offEvent(handler);
  }

  offConsumerMemberEvent(handler: (memberId: number, event: MemberClientEventType) => void) {
    this._consumerMemberEventHandlers = this._consumerMemberEventHandlers.filter(h => h !== handler);
    this._consumerMembers.forEach((member, memberId) => {
      member.offEvent((event: MemberClientEventType) => {
        handler(memberId, event);
      });
    });
  }

  private connect() {
    this._socket.connect();
  }

  private onSocketConnected() {
    this._spaceInitReceived = false;
    if (this._connectedHandler) {
      this._connectedHandler();
    }
  }

  private onSocketDisconnected() {
    console.log("Space socket disconnected");
    if (this._disconnectedHandler) {
      this._disconnectedHandler();
      // Attempt reconnection
      this.connect();
    }
  }

  private onSocketFailed(error: { message: string }) {
    console.log("Space socket connection failed:", error.message);
    if (this._failedHandler) {
      this._failedHandler(error);
      // No reconnection on failure
      this.cleanup();
    }
  }

  updateProducerMemberState(newState: Partial<MemberState>) {
    this._producerMember.updateState(newState);
    this._socket.updateMemberState(newState);
  }

  handleMemberJoin(payload: { member: ClientSideMember }) {
    const { member } = payload;
    if (this._consumerMembers.has(member.id) || member.id === this._producerMemberId) {
      // This should not happen
      console.warn("Received memberJoin for an existing member:", member.id);
      return;
    } else {
      const consumerMember = new Member<ConsumerTransport>(member.data, member.state);
      this._consumerMembers.set(member.id, consumerMember);
      for (const handler of this._consumerMemberEventHandlers) {
        consumerMember.onEvent((event: MemberClientEventType) => {
          handler(member.id, event);
        });
      }
    }
    this._memberJoinHandlers.forEach(handler => handler(member.id));
  }

  handleMemberLeave(payload: { memberId: number }) {
    const { memberId } = payload;
    if (this._consumerMembers.has(memberId)) {
      this._consumerMembers.delete(memberId);
    } else {
      // This should not happen
      console.warn("Received memberLeave for a non-existing member:", memberId);
      return;
    }
    this._memberLeaveHandlers.forEach(handler => handler(memberId));
  }

  handleMemberStateUpdate(payload: { memberId: number, newState: MemberState }) {
    const { memberId, newState } = payload;
    if (memberId === this._producerMemberId) {
      // TODO: What to do here? We don't need to update again since we already updated earlier.
      // We can maybe have a logic to sync local state with server acks.
      // this._producerMember.updateState(newState);
    } else if (this._consumerMembers.has(memberId)) {
      const consumerMember = this._consumerMembers.get(memberId)!;
      consumerMember.updateState(newState);
    } else {
      // This should not happen
      console.warn("Received memberStateUpdate for a non-existing member:", memberId);
      return;
    }
    this._memberStateUpdateHandlers.forEach(handler => handler(memberId));
  }

  handleSpaceClose() {
    this._spaceCloseHandlers.forEach(handler => handler());
  }

  handleSpaceInit(payload: { receivingMemberId: number, clientSideSpace: ClientSideSpace }) {
    const { receivingMemberId, clientSideSpace } = payload;
    if (!this._spaceInitReceived) {
      this._producerMemberId = receivingMemberId;
      this.uuid = clientSideSpace.uuid;
      this.data = clientSideSpace.data;
      clientSideSpace.members.forEach(({ id, data, state }) => {
        if (id === this._producerMemberId) {
          this._producerMember.data = data;
          this._producerMember.state = state;
        } else {
          const consumerMember = new Member<ConsumerTransport>(data, state);
          this._consumerMembers.set(id, consumerMember);
        }
      });
      this._spaceInitReceived = true;
    } else {
      // TODO: Resync logic (maybe add the option to pass a handler for this)
      return;
    }
    this._spaceInitHandlers.forEach(handler => handler());
  }

  handleTransportParams(payload: { memberId: number; options: mediasoupClient.types.TransportOptions; }) {
    const { memberId, options } = payload;
    if (memberId === this._producerMemberId) {
      // Handle producer transport params
      const transport = this._transportFactory.createProducer(options);
      this._producerMember.assignTransport(transport);
    } else if (this._consumerMembers.has(memberId)) {
      // Handle consumer transport params
      const transport = this._transportFactory.createConsumer(options, memberId);
      const consumerMember = this._consumerMembers.get(memberId)!;
      consumerMember.assignTransport(transport);
    } else {
      // This should not happen
      console.warn("Received transportParams for a non-existing member:", memberId);
      return;
    }
    this._transportParamsHandlers.forEach(handler => handler(memberId));
  }
}
