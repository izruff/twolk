/**
 * Socket.IO implementation of the client-channel port.
 *
 * Socket.IO-specific types and casts stay in this adapter. The signaling
 * server interacts only with `IClientChannel` and `IClientChannelAcceptor`.
 * The acceptor owns the Node HTTP server because binding the port is part of
 * starting the network adapter.
 */

import type { Socket as BaseSocket, Server as BaseServer } from "socket.io";
import type http from "node:http";

import type {
  IClientChannel, IClientChannelAcceptor, EventMap,
  EventArgs, EventHandlerFor,
} from "./client-channel-port.ts";


/** Wraps one Socket.IO socket as an `IClientChannel`. */
export class SocketIoChannel<C2S extends EventMap, S2C extends EventMap>
  implements IClientChannel<C2S, S2C> {
  socket: BaseSocket<any, any>

  constructor(socket: BaseSocket<any, any>) {
    this.socket = socket;
  }

  /** Socket.IO connection ID. */
  get id(): string {
    return this.socket.id;
  }

  /** Socket.IO auth payload supplied during the handshake. */
  get auth(): unknown {
    return this.socket.handshake.auth;
  }

  /** Registers a client-to-server event handler. */
  on<K extends keyof C2S>(event: K, handler: EventHandlerFor<C2S, K>): void {
    this.socket.on(event as any, handler as any);
  }

  /** Removes a client-to-server event handler. */
  off<K extends keyof C2S>(event: K, handler: EventHandlerFor<C2S, K>): void {
    this.socket.off(event as any, handler as any);
  }

  /** Sends a server-to-client event over Socket.IO. */
  emit<K extends keyof S2C>(event: K, ...args: EventArgs<S2C, K>): void {
    (this.socket.emit as any)(event, ...args);
  }

  /** Registers a close handler for Socket.IO disconnect. */
  onClose(handler: () => void): void {
    this.socket.on("disconnect" as any, handler);
  }

  /** Disconnects the Socket.IO socket. */
  close(): void {
    this.socket.disconnect(true);
  }
}


/** Accepts Socket.IO connections and exposes them as client channels. */
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

  /** Registers the channel handler used for future Socket.IO connections. */
  onChannel(handler: (channel: IClientChannel<C2S, S2C>) => void): void {
    this._channelHandler = handler;
  }

  /** Starts listening for Socket.IO connections on the configured port. */
  start(): void {
    this.io.on("connection", (socket: BaseSocket<any, any>) => {
      if (this._channelHandler !== null) {
        this._channelHandler(new SocketIoChannel<C2S, S2C>(socket));
      }
      // TODO: Close or reject sockets that arrive before a handler is set.
    });
    this.httpServer.listen(this.port);
  }

  /** Stops the underlying HTTP server. */
  stop(): void {
    this.httpServer.close();
  }
}
