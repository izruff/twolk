import { type Consumer as MediasoupConsumer } from "mediasoup-client/types";

export class Consumer {
  _mediasoupConsumer: MediasoupConsumer | null;

  constructor() {
    this._mediasoupConsumer = null;
  }

  assignMediasoupConsumer(mediasoupConsumer: MediasoupConsumer) {
    this._mediasoupConsumer = mediasoupConsumer;
    // TODO: Handle consumer events here
  }

  getTrack(): MediaStreamTrack {
    if (this._mediasoupConsumer === null || this._mediasoupConsumer.track.kind !== "audio") {
      throw new Error("mediasoup consumer not assigned");
    }

    return this._mediasoupConsumer.track;
  }
}
