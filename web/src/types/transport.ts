import mediasoupClient from 'mediasoup-client';

import { SignalingSocketWrapper } from './signaling.socket';
import { Producer } from './producer';
import { Consumer } from './consumer';
import { getRandomUUID } from '../utils/random';


export class Transport {
  _mediasoupTransport: mediasoupClient.types.Transport;

  constructor(mediasoupTransport: mediasoupClient.types.Transport) {
    this._mediasoupTransport = mediasoupTransport;
  }
}


export class ProducerTransport extends Transport {
  _producer: Producer;

  constructor(mediasoupTransport: mediasoupClient.types.Transport, producer: Producer) {
    super(mediasoupTransport);
    this._producer = producer;
  }

  assignMediasoupProducer(mediasoupProducer: mediasoupClient.types.Producer) {
    this._producer.assignMediasoupProducer(mediasoupProducer);
  }
}


export class ConsumerTransport extends Transport {
  _consumer: Consumer;

  constructor(mediasoupTransport: mediasoupClient.types.Transport, consumer: Consumer) {
    super(mediasoupTransport);
    this._consumer = consumer;
  }

  assignMediasoupConsumer(mediasoupConsumer: mediasoupClient.types.Consumer) {
    this._consumer.assignMediasoupConsumer(mediasoupConsumer);
  }
}


export class TransportFactory {
  _mediasoupDevice: mediasoupClient.Device;
  _socket: SignalingSocketWrapper;
  
  constructor(mediasoupDevice: mediasoupClient.Device, socket: SignalingSocketWrapper) {
    this._mediasoupDevice = mediasoupDevice;
    this._socket = socket;
  }

  createProducer(options: mediasoupClient.types.TransportOptions): ProducerTransport {
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
    mediasoupTransport.produce(options).then((mediasoupProducer) => {
      transport.assignMediasoupProducer(mediasoupProducer);
    }).catch((err: Error) => {
      console.error("Failed to produce:", err);
    });

    return transport;
  }

  createConsumer(options: mediasoupClient.types.TransportOptions, sourceMemberId: number): ConsumerTransport {
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
