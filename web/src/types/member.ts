import { Transport } from './transport';


export interface MemberData {
  name: string;
}

export interface MemberState {
  isMuted: boolean;
}

export type MemberClientEventType = "stateUpdated" | "transportAssigned";


export class Member<TTransport extends Transport> {
  data: MemberData;
  state: MemberState;

  _transport: TTransport | null;

  _onEvent: ((event: MemberClientEventType) => void)[];

  constructor(data: MemberData, initialState: MemberState) {
    this.data = data;
    this.state = initialState;
    this._transport = null;
    this._onEvent = [];
  }

  onEvent(handler: (event: MemberClientEventType) => void) {
    this._onEvent.push(handler);
  }

  offEvent(handler: (event: MemberClientEventType) => void) {
    this._onEvent = this._onEvent.filter(h => h !== handler);
  }

  emitEvent(event: MemberClientEventType) {
    this._onEvent.forEach((handler) => {
      handler(event);
    });
  }

  updateState(newState: Partial<MemberState>) {
    this.state = { ...this.state, ...newState };
    this.emitEvent("stateUpdated");
  }

  assignTransport(transport: TTransport) {
    this._transport = transport;
    this.emitEvent("transportAssigned");
  }
}
