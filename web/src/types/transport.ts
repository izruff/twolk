import mediasoupClient from 'mediasoup-client';

import { SignalingSocketWrapper } from './signaling.socket';
import { Producer } from './producer';
import { Consumer } from './consumer';
import { getRandomUUID } from '../utils/random';
import { createSilentTrack } from '../utils/media';


export abstract class Transport {
  _mediasoupTransport: mediasoupClient.types.Transport;

  onceReadyHandlers: (() => void)[] = [];

  constructor(mediasoupTransport: mediasoupClient.types.Transport) {
    this._mediasoupTransport = mediasoupTransport;
  }

  abstract isReady(): boolean;

  onceReady(handler: () => void) {
    if (this.isReady()) {
      handler();
      return;
    }
    this.onceReadyHandlers.push(handler);
  }

  notifyReady() {
    this.onceReadyHandlers.forEach((handler) => {
      handler();
    });
    this.onceReadyHandlers = [];
  }
}


export class ProducerTransport extends Transport {
  _producer: Producer;

  constructor(mediasoupTransport: mediasoupClient.types.Transport, producer: Producer) {
    super(mediasoupTransport);
    this._producer = producer;
  }

  isReady(): boolean {
    return this._producer._mediasoupProducer !== null;
  }

  assignMediasoupProducer(mediasoupProducer: mediasoupClient.types.Producer) {
    this._producer.assignMediasoupProducer(mediasoupProducer);
    this.notifyReady();
  }
}


export class ConsumerTransport extends Transport {
  _consumer: Consumer;

  constructor(mediasoupTransport: mediasoupClient.types.Transport, consumer: Consumer) {
    super(mediasoupTransport);
    this._consumer = consumer;
  }

  isReady(): boolean {
    return this._consumer._mediasoupConsumer !== null;
  }

  assignMediasoupConsumer(mediasoupConsumer: mediasoupClient.types.Consumer) {
    this._consumer.assignMediasoupConsumer(mediasoupConsumer);
    this.notifyReady();
  }
}


export class TransportFactory {
  _mediasoupDevice: mediasoupClient.Device;
  _socket: SignalingSocketWrapper;

  _audioContext: AudioContext | null = null;

  _isReady: boolean = false;
  _onceReadyHandlers: (() => void)[] = [];
  
  constructor(mediasoupDevice: mediasoupClient.Device, socket: SignalingSocketWrapper) {
    this._mediasoupDevice = mediasoupDevice;
    this._socket = socket;
  }

  async init(routerRtpCapabilities: mediasoupClient.types.RtpCapabilities) {
    await this._mediasoupDevice.load({ routerRtpCapabilities });
    console.log("Mediasoup device loaded with RTP capabilities:", this._mediasoupDevice.rtpCapabilities);
    if (!this._isReady && this._audioContext !== null) {
      this._isReady = true;
      this.notifyReady();
    }
  }

  assignAudioContext(audioContext: AudioContext) {
    if (audioContext.state === "suspended") {
      throw new Error("audio context must be running");
    }
    this._audioContext = audioContext;
    if (!this._isReady && this._mediasoupDevice.loaded) {
      this._isReady = true;
      this.notifyReady();
    }
  }

  isReady(): boolean {
    return this._isReady;
  }

  onceReady(handler: () => void) {
    if (this.isReady()) {
      handler();
      return;
    }
    this._onceReadyHandlers.push(handler);
  }

  notifyReady() {
    this._onceReadyHandlers.forEach((handler) => {
      handler();
    });
    this._onceReadyHandlers = [];
  }

  createProducer(options: mediasoupClient.types.TransportOptions): ProducerTransport {
    if (!this.isReady()) {
      throw new Error("transport factory not ready");
    }

    const mediasoupTransport = this._mediasoupDevice.createSendTransport(options);

    mediasoupTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
      // Notify the server
      const cId = getRandomUUID();
      this._socket.emit("transportProducerConnect", { dtlsParameters }, cId);

      // Wait for server to acknowledge
      const ackPromise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("timeout waiting for transportProducerConnectAck"));
        }, 5000);

        this._socket.onceWithCondition("transportProducerConnectAck",
          (ackCId: string) => ackCId === cId,
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          (_ackCId: string) => {
            resolve();
            clearTimeout(timeout);
          });
      });
      ackPromise.then(callback).catch(errback);
    });

    mediasoupTransport.on('produce', ({ kind, rtpParameters }, callback, errback) => {
      // Notify the server
      const cId = getRandomUUID();
      this._socket.emit("transportProducerProduce", { kind, rtpParameters }, cId);

      // Wait for server to acknowledge
      const ackPromise = new Promise<{ id: string }>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("timeout waiting for transportProducerProduceAck"));
        }, 5000);

        this._socket.onceWithCondition("transportProducerProduceAck",
          (ackCId: string) => ackCId === cId,
          (_ackCId: string, producerId: string) => {
            resolve({ id: producerId });
            clearTimeout(timeout);
          });
      });
      ackPromise.then(callback).catch(errback);
    });

    const transport = new ProducerTransport(mediasoupTransport, new Producer());

    // Emit a signal to produce
    mediasoupTransport.produce({ track: createSilentTrack(this._audioContext!) }).then((mediasoupProducer) => {
      transport.assignMediasoupProducer(mediasoupProducer);
    }).catch((err: Error) => {
      console.error("Failed to produce:", err);
    });

    return transport;
  }

  createConsumer(options: mediasoupClient.types.TransportOptions, sourceMemberId: number): ConsumerTransport {
    if (!this.isReady()) {
      throw new Error("transport factory not ready");
    }

    const mediasoupTransport = this._mediasoupDevice.createRecvTransport(options);

    mediasoupTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
      // Notify the server
      const cId = getRandomUUID();
      this._socket.emit("transportConsumerConnect", { dtlsParameters, sourceMemberId }, cId);

      // Wait for server to acknowledge
      const ackPromise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("timeout waiting for transportConsumerConnectAck"));
        }, 5000);

        this._socket.onceWithCondition("transportConsumerConnectAck",
          (ackCId: string) => ackCId === cId,
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          (_ackCId: string) => {
            resolve();
            clearTimeout(timeout);
          });
      });
      ackPromise.then(callback).catch(errback);
    });

    const transport = new ConsumerTransport(mediasoupTransport, new Consumer());

    // Server needs to have its transport consume first
    const cId = getRandomUUID();
    console.log("Emitting transportConsumerConsume:", {
      rtpCapabilities: this._mediasoupDevice.rtpCapabilities,
      sourceMemberId,
    })
    this._socket.emit("transportConsumerConsume", {
      rtpCapabilities: this._mediasoupDevice.rtpCapabilities,
      sourceMemberId,
    }, cId);

    // Wait for server to acknowledge, then emit a signal to consume
    const ackPromise = new Promise<mediasoupClient.types.ConsumerOptions>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("timeout waiting for transportConsumerConsumeAck"));
      }, 5000);

      this._socket.onceWithCondition("transportConsumerConsumeAck",
        (ackCId: string) => ackCId === cId,
        (_ackCId: string, consumerId: string, producerId: string,
          kind: mediasoupClient.types.MediaKind,
          rtpParameters: mediasoupClient.types.RtpParameters) => {
            resolve({ id: consumerId, producerId, kind, rtpParameters });
            clearTimeout(timeout);
          });
    });
    ackPromise.then((options) => {
      // Emit a signal to consume
      return mediasoupTransport.consume(options)
    }).then((mediasoupConsumer) => {
      // Need to tell the server to resume the consumer
      // https://mediasoup.org/documentation/v3/mediasoup/api/#transport-consume
      const resumeCId = getRandomUUID();
      this._socket.emit("transportConsumerResume", { sourceMemberId }, resumeCId);

      // Wait for server to acknowledge
      const resumeAckPromise = new Promise<mediasoupClient.types.Consumer>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("timeout waiting for transportConsumerResumeAck"));
        }, 5000);

        this._socket.onceWithCondition("transportConsumerResumeAck",
          (ackCId: string) => ackCId === resumeCId,
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          (_ackCId: string) => {
            resolve(mediasoupConsumer);
            clearTimeout(timeout);
          });
      });
      return resumeAckPromise;
    }).then((mediasoupConsumer) => {
      transport.assignMediasoupConsumer(mediasoupConsumer);
    }).catch((err: Error) => {
      console.error("Failed to consume:", err);
    });

    return transport;
  }
}
