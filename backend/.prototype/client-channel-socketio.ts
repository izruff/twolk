/*

Socket.IO adapter for the client-channel port. All Socket.IO-specific
type acrobatics live here; the rest of the backend sees only
`IClientChannel` and `IClientChannelAcceptor`.

The acceptor owns the underlying Node server too, since binding to the
port is part of "start accepting." The composition root (`app.ts`)
decides whether that server is http or https and only has to call
`acceptor.start()`.

*/

import type { Socket as BaseSocket, Server as BaseServer } from "socket.io";
import type http from "node:http";

import type {
  IClientChannel, IClientChannelAcceptor, EventMap,
} from "./client-channel-port.ts";


export class SocketIoChannel<C2S extends EventMap, S2C extends EventMap>
  implements IClientChannel<C2S, S2C> {
  socket: BaseSocket<any, any>

  constructor(socket: BaseSocket<any, any>) {
    this.socket = socket;
  }

  get id(): string {
    return this.socket.id;
  }

  get auth(): unknown {
    return this.socket.handshake.auth;
  }

  on<K extends keyof C2S>(event: K, handler: C2S[K]): void {
    this.socket.on(event as any, handler as any);
  }

  off<K extends keyof C2S>(event: K, handler: C2S[K]): void {
    this.socket.off(event as any, handler as any);
  }

  emit<K extends keyof S2C>(event: K, ...args: Parameters<S2C[K]>): void {
    (this.socket.emit as any)(event, ...args);
  }

  onClose(handler: () => void): void {
    this.socket.on("disconnect" as any, handler);
  }

  close(): void {
    this.socket.disconnect(true);
  }
}


export class SocketIoChannelAcceptor<C2S extends EventMap, S2C extends EventMap>
  implements IClientChannelAcceptor<C2S, S2C> {
  io: BaseServer<any, any>
  httpServer: http.Server
  port: number

  _channelHandler: ((channel: IClientChannel<C2S, S2C>) => void) | null = null

  constructor(io: BaseServer<any, any>, httpServer: http.Server, port: number) {
    this.io = io;
    this.httpServer = httpServer;
    this.port = port;
  }

  onChannel(handler: (channel: IClientChannel<C2S, S2C>) => void): void {
    this._channelHandler = handler;
  }

  start(): void {
    this.io.on("connection", (socket: BaseSocket<any, any>) => {
      if (this._channelHandler !== null) {
        this._channelHandler(new SocketIoChannel<C2S, S2C>(socket));
      }
    });
    this.httpServer.listen(this.port);
  }

  stop(): void {
    this.httpServer.close();
  }
}
