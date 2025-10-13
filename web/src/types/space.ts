import mediasoupClient, { Device as mediasoupDevice } from 'mediasoup-client';

import { Member, type MemberData, type MemberState, type MemberClientEventType, type MemberStateFromClient } from "./member";
import type { SignalingSocketWrapper, ClientSideMember, ClientSideSpace } from "./signaling.socket";
import { ConsumerTransport, ProducerTransport, TransportFactory } from "./transport";


export interface SpaceData {
  name: string;
}


export interface SpaceSnapshot {
  uuid: string;
  data: SpaceData;
  members: {
    id: number;
    data: MemberData;
    state: MemberState;
  }[];
  producer: {
    id: number;
  };
}


export class Space {
  uuid: string | null;
  data: SpaceData | null;

  _producerMember: Member<ProducerTransport>;
  _producerMemberId: number | null;
  _consumerMembers: Map<number, Member<ConsumerTransport>>;

  _socket: SignalingSocketWrapper;
  _transportFactory: TransportFactory;

  _routerRtpCapabilities: mediasoupClient.types.RtpCapabilities | null = null;

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

  _snapshotUpdateCallbacks: (() => void)[] = [];

  _spaceInitReceived: boolean = false;

  // Cache for the snapshot to prevent creating new objects unnecessarily
  _cachedSnapshot: SpaceSnapshot | null = null;
  _snapshotCacheValid: boolean = false;

  // Bound method references to ensure consistent function identity for event listener removal
  onSocketConnectedBound!: () => void;
  onSocketDisconnectedBound!: () => void;
  onSocketFailedBound!: (error: { message: string }) => void;
  handleMemberJoinBound!: (payload: { member: ClientSideMember }) => void;
  handleMemberLeaveBound!: (payload: { memberId: number }) => void;
  handleMemberStateUpdateBound!: (payload: { memberId: number, newState: MemberState }) => void;
  handleSpaceCloseBound!: () => void;
  handleSpaceInitBound!: (payload: { receivingMemberId: number, routerRtpCapabilities: mediasoupClient.types.RtpCapabilities, clientSideSpace: ClientSideSpace }) => void;
  handleTransportParamsBound!: (payload: { memberId: number; options: mediasoupClient.types.TransportOptions; }) => void;

  constructor(
    producerData: MemberData,
    producerState: MemberStateFromClient,
    socket: SignalingSocketWrapper,
  ) {
    // The socket is supposed to be disconnected so this class can implement reconnection logic.
    if (socket.status !== "disconnected") {
      throw new Error("socket must be disconnected when creating Space instance");
    }

    this.uuid = null;
    this.data = null;
    this._producerMember = new Member<ProducerTransport>(producerData, {
      ...producerState,
      // These are just placeholders until we receive the actual state from the server
      transportIsConnected: false,
    });
    this._producerMemberId = null;
    this._consumerMembers = new Map();
    this._socket = socket;
    this._transportFactory = new TransportFactory(new mediasoupDevice(), socket);
  }

  // Start connecting, will reconnect automatically if disconnected, stops if failed
  async init(
    onConnected: () => void,
    onDisconnected: () => void,
    onFailed: (error: { message: string }) => void,
  ) {
    // Store bound methods to ensure consistent references for adding/removing listeners
    this.onSocketConnectedBound = this.onSocketConnected.bind(this);
    this.onSocketDisconnectedBound = this.onSocketDisconnected.bind(this);
    this.onSocketFailedBound = this.onSocketFailed.bind(this);
    this.handleMemberJoinBound = this.handleMemberJoin.bind(this);
    this.handleMemberLeaveBound = this.handleMemberLeave.bind(this);
    this.handleMemberStateUpdateBound = this.handleMemberStateUpdate.bind(this);
    this.handleSpaceCloseBound = this.handleSpaceClose.bind(this);
    this.handleSpaceInitBound = this.handleSpaceInit.bind(this);
    this.handleTransportParamsBound = this.handleTransportParams.bind(this);

    // Start listening to socket events
    this._socket.onConnected(this.onSocketConnectedBound);
    this._socket.onDisconnected(this.onSocketDisconnectedBound);
    this._socket.onFailed(this.onSocketFailedBound);

    this._socket.onSpaceWideEvent("memberJoin", this.handleMemberJoinBound);
    this._socket.onSpaceWideEvent("memberLeave", this.handleMemberLeaveBound);
    this._socket.onSpaceWideEvent("memberStateUpdate", this.handleMemberStateUpdateBound);
    this._socket.onSpaceWideEvent("spaceClose", this.handleSpaceCloseBound);

    this._socket.onMemberEvent("spaceInit", this.handleSpaceInitBound);
    this._socket.onMemberEvent("transportParams", this.handleTransportParamsBound);

    // Set up user handlers and status variables
    this._connectedHandler = onConnected;
    this._disconnectedHandler = onDisconnected;
    this._failedHandler = onFailed;
    this._spaceInitReceived = false;

    this.connect();
  }

  async initTransportFactory(audioContext: AudioContext) {
    if (this._routerRtpCapabilities === null) {
      throw new Error("router RTP capabilities not set");
    }
    if (audioContext.state === "suspended") {
      throw new Error("audio context must be running");
    }

    await this._transportFactory.init(this._routerRtpCapabilities)
    this._transportFactory.assignAudioContext(audioContext);
  }

  cleanup() {
    // Clear user handlers and reset status variables
    this._connectedHandler = null;
    this._disconnectedHandler = null;
    this._failedHandler = null;
    this._spaceInitReceived = false;

    // Invalidate the snapshot cache
    this._cachedSnapshot = null;
    this._snapshotCacheValid = false;

    // Stop listening to socket events
    // Note: The handlers were bound in init(), so we need to reference them properly
    this._socket.offConnected(this.onSocketConnectedBound);
    this._socket.offDisconnected(this.onSocketDisconnectedBound);
    this._socket.offFailed(this.onSocketFailedBound);

    this._socket.offSpaceWideEvent("memberJoin", this.handleMemberJoinBound);
    this._socket.offSpaceWideEvent("memberLeave", this.handleMemberLeaveBound);
    this._socket.offSpaceWideEvent("memberStateUpdate", this.handleMemberStateUpdateBound);
    this._socket.offSpaceWideEvent("spaceClose", this.handleSpaceCloseBound);

    this._socket.offMemberEvent("spaceInit", this.handleSpaceInitBound);
    this._socket.offMemberEvent("transportParams", this.handleTransportParamsBound);

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

  subscribeSnapshotUpdates(handler: () => void): () => void {
    this._snapshotUpdateCallbacks.push(handler);
    return () => {
      this._snapshotUpdateCallbacks = this._snapshotUpdateCallbacks.filter(h => h !== handler);
    };
  }

  private connect() {
    this._socket.connect();
  }

  private onSocketConnected() {
    if (this._connectedHandler) {
      this._connectedHandler();
    }
  }

  private onSocketDisconnected() {
    console.log("Space socket disconnected");
    this._spaceInitReceived = false;
    if (this._disconnectedHandler) {
      this._disconnectedHandler();
      // Attempt reconnection
      this.connect();
    }
  }

  private onSocketFailed(error: { message: string }) {
    console.log("Space socket connection failed:", error.message);
    this._spaceInitReceived = false;
    if (this._failedHandler) {
      this._failedHandler(error);
      // No reconnection on failure
      this.cleanup();
    }
  }

  private notifySnapshotUpdate() {
    // Invalidate the snapshot cache when updates occur
    this._snapshotCacheValid = false;
    this._snapshotUpdateCallbacks.forEach(handler => handler());
  }

  getSnapshot(): SpaceSnapshot | null {
    if (!this._spaceInitReceived) {
      if (this._snapshotCacheValid) {
        this._cachedSnapshot = null;
        this._snapshotCacheValid = false;
      }
      return null;
    }

    if (!this._snapshotCacheValid) {
      this._cachedSnapshot = {
        uuid: this.uuid!,
        data: this.data!,
        members: [
          {
            id: this._producerMemberId!,
            data: this._producerMember.data,
            state: this._producerMember.state,
          },
          ...Array.from(this._consumerMembers.entries()).map(([id, member]) => ({
            id,
            data: member.data,
            state: member.state,
          })),
        ],
        producer: {
          id: this._producerMemberId!,
        },
      };
      this._snapshotCacheValid = true;
    }

    return this._cachedSnapshot;
  }

  setProducerTrack(track: MediaStreamTrack): void {
    const transport = this._producerMember._transport;
    if (transport === null) {
      throw new Error("producer transport not assigned");
    }
    transport._producer.setTrack(track);
  }

  getConsumerTrack(memberId: number): MediaStreamTrack {
    const transport = this._consumerMembers.get(memberId)?._transport;
    if (transport === null || transport === undefined) {
      throw new Error("consumer transport not assigned");
    }
    return transport._consumer.getTrack();
  }

  producerIsReady(): boolean {
    const transport = this._producerMember._transport;
    return transport !== null && transport.isReady();
  }

  consumerIsReady(memberId: number): boolean {
    const transport = this._consumerMembers.get(memberId)?._transport;
    return transport !== null && transport !== undefined && transport.isReady();
  }

  updateProducerMemberState(newState: Partial<MemberStateFromClient>) {
    this._producerMember.updateState(newState);
    this._socket.updateMemberState(newState);
  }

  onMemberJoin(handler: (memberId: number) => void) {
    this._memberJoinHandlers.push(handler);
  }

  onMemberLeave(handler: (memberId: number) => void) {
    this._memberLeaveHandlers.push(handler);
  }

  onMemberStateUpdate(handler: (memberId: number) => void) {
    this._memberStateUpdateHandlers.push(handler);
  }

  onSpaceClose(handler: () => void) {
    this._spaceCloseHandlers.push(handler);
  }

  onSpaceInit(handler: () => void) {
    this._spaceInitHandlers.push(handler);
  }

  onTransportParams(handler: (memberId: number) => void) {
    this._transportParamsHandlers.push(handler);
  }

  offMemberJoin(handler: (memberId: number) => void) {
    this._memberJoinHandlers = this._memberJoinHandlers.filter(h => h !== handler);
  }

  offMemberLeave(handler: (memberId: number) => void) {
    this._memberLeaveHandlers = this._memberLeaveHandlers.filter(h => h !== handler);
  }

  offMemberStateUpdate(handler: (memberId: number) => void) {
    this._memberStateUpdateHandlers = this._memberStateUpdateHandlers.filter(h => h !== handler);
  }

  offSpaceClose(handler: () => void) {
    this._spaceCloseHandlers = this._spaceCloseHandlers.filter(h => h !== handler);
  }

  offSpaceInit(handler: () => void) {
    this._spaceInitHandlers = this._spaceInitHandlers.filter(h => h !== handler);
  }

  offTransportParams(handler: (memberId: number) => void) {
    this._transportParamsHandlers = this._transportParamsHandlers.filter(h => h !== handler);
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
    this.notifySnapshotUpdate();
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
    this.notifySnapshotUpdate();
  }

  handleMemberStateUpdate(payload: { memberId: number, newState: MemberState }) {
    const { memberId, newState } = payload;
    if (memberId === this._producerMemberId) {
      // TODO: What else to do here? We don't need to update again since we already updated earlier.
      // We can maybe have a logic to sync local state with server acks.
      const newStateFromServer = { transportIsConnected: newState.transportIsConnected };
      this._producerMember.updateState(newStateFromServer);
    } else if (this._consumerMembers.has(memberId)) {
      const consumerMember = this._consumerMembers.get(memberId)!;
      consumerMember.updateState(newState);
    } else {
      // This should not happen
      console.warn("Received memberStateUpdate for a non-existing member:", memberId);
      return;
    }
    this._memberStateUpdateHandlers.forEach(handler => handler(memberId));
    this.notifySnapshotUpdate();
  }

  handleSpaceClose() {
    this.cleanup();
    this.notifySnapshotUpdate();
    this._spaceCloseHandlers.forEach(handler => handler());
  }

  handleSpaceInit(payload: { receivingMemberId: number, routerRtpCapabilities: mediasoupClient.types.RtpCapabilities,
    clientSideSpace: ClientSideSpace }) {
    const { receivingMemberId, routerRtpCapabilities, clientSideSpace } = payload;
    if (!this._spaceInitReceived) {
      console.log("Handling spaceInit:", payload);
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
          for (const handler of this._consumerMemberEventHandlers) {
            consumerMember.onEvent((event: MemberClientEventType) => {
              handler(id, event);
            });
          }
        }
      });
      this._spaceInitReceived = true;
      this._routerRtpCapabilities = routerRtpCapabilities;
    } else {
      // TODO: Resync logic (maybe add the option to pass a handler for this)
      return;
    }
    this._spaceInitHandlers.forEach(handler => handler());
    this.notifySnapshotUpdate();
  }

  handleTransportParams(payload: { memberId: number; options: mediasoupClient.types.TransportOptions; }) {
    const { memberId, options } = payload;
    if (memberId === this._producerMemberId) {
      // Handle producer transport params
      this._transportFactory.onceReady(() => {
        const transport = this._transportFactory.createProducer(options);
        this._producerMember.assignTransport(transport);
      });
    } else if (this._consumerMembers.has(memberId)) {
      // Handle consumer transport params
      this._transportFactory.onceReady(() => {
        const transport = this._transportFactory.createConsumer(options, memberId);
        this._consumerMembers.get(memberId)!.assignTransport(transport);
      });
    } else {
      // This should not happen
      console.warn("Received transportParams for a non-existing member:", memberId);
      return;
    }
    this._transportParamsHandlers.forEach(handler => handler(memberId));
    this.notifySnapshotUpdate();
  }
}
