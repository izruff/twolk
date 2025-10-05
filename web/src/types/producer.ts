import { type Producer as MediasoupProducer } from "mediasoup-client/types";

export class Producer {
  _mediasoupProducer: MediasoupProducer | null;

  constructor() {
    this._mediasoupProducer = null;
  }

  assignMediasoupProducer(mediasoupProducer: MediasoupProducer) {
    this._mediasoupProducer = mediasoupProducer;
    // TODO: Handle producer events here
  }
}
