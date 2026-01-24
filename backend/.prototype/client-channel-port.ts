/**
 * Client channel port used by `SignalingServer`.
 *
 * A client channel represents one bidirectional client-to-signaling-server
 * connection. It exposes only the operations the signaling layer needs:
 * inbound handlers, outbound events, an opaque auth payload, and connection
 * lifecycle hooks.
 *
 * The acceptor handles incoming client connections. It creates channels
 * from an underlying network adapter and hands them to registered handlers.
 */

/** Event map marker used by client-channel implementations. */
export type EventMap = object;

/** Function type for one event handler. */
export type EventHandler = (...args: any[]) => any;

/** Handler type for one event key. */
export type EventHandlerFor<T, K extends keyof T> =
  T[K] extends EventHandler ? T[K] : never;

/** Argument tuple for one event key. */
export type EventArgs<T, K extends keyof T> =
  T[K] extends (...args: infer A) => any ? A : never;


/** Client connection used by `MemberSession`. */
export interface IClientChannel<C2S extends EventMap, S2C extends EventMap> {
  /** Adapter-specific connection ID. */
  readonly id: string;

  /** Opaque auth payload supplied by the client during connection setup. */
  readonly auth: unknown;

  /** Registers a handler for a client-to-server event. */
  on<K extends keyof C2S>(event: K, handler: EventHandlerFor<C2S, K>): void;

  /** Removes a handler for a client-to-server event. */
  off<K extends keyof C2S>(event: K, handler: EventHandlerFor<C2S, K>): void;

  /** Sends a server-to-client event. */
  emit<K extends keyof S2C>(event: K, ...args: EventArgs<S2C, K>): void;

  /** Registers a handler for either-side connection close. */
  onClose(handler: () => void): void;

  /** Actively terminates the underlying connection. */
  close(): void;
}


/** Accepts client channels from a concrete network adapter. */
export interface IClientChannelAcceptor<C2S extends EventMap, S2C extends EventMap> {
  /**
   * Registers the handler called once per incoming channel.
   *
   * TODO: Support multiple subscribers or reject duplicate registration
   * explicitly. Current adapters keep only one handler.
   */
  onChannel(handler: (channel: IClientChannel<C2S, S2C>) => void): void;

  /** Starts accepting new channels. */
  start(): void;

  /** Stops accepting new channels. */
  stop(): void;
}
