import { Socket } from "socket.io-client";

// We can just use Socket directly, but this wrapper will be useful when we
// move away from socket.io in the future.
// TODO: Many of the methods here do not preserve types perfectly, but this
// might be too complicated. If it ain't broke, don't fix it :)
export class SocketWrapper<T extends Socket> {
  protected _socket: T;

  constructor(socket: T) {
    this._socket = socket;
  }

  get socket(): T {
    return this._socket;
  }

  replaceSocket(next: T): void {
    this._socket = next;
  }

  connect(): void {
    this._socket.connect();
  }

  disconnect(): void {
    this._socket.disconnect();
  }

  on<E extends Parameters<T["on"]>[0]>(
    event: E,
    listener: Parameters<T["on"]>[1],
  ): this {
    this._socket.on(event as never, listener as never);
    return this;
  }

  once<E extends Parameters<T["once"]>[0]>(
    event: E,
    listener: Parameters<T["once"]>[1],
  ): this {
    this._socket.once(event as never, listener as never);
    return this;
  }

  // TODO: Need a nicer way to write the type definitions
  onceWithCondition<E extends Parameters<T["on"]>[0], L extends Parameters<T["on"]>[1]>(
    event: E,
    predicate: (...args: Parameters<L>) => boolean,
    listener: L,
  ): this {
    const handler = (...args: Parameters<L>) => {
      if (!predicate(...args)) {
        return;
      }

      this.off(event, handler as never);
      listener(...args);
    };

    this.on(event, handler as never);
    return this;
  }

  off<E extends Parameters<T["off"]>[0]>(
    event: E,
    listener?: Parameters<T["off"]>[1],
  ): this {
    this._socket.off(event as never, listener as never);
    return this;
  }

  // This one was my code; the other was AI
  emit<S extends Parameters<T["emit"]>>(
    event: S[0],
    ...args: S extends [any, ...infer Rest] ? Rest : never
  ): T {
    return this._socket.emit(event, ...args) as T;
  }
}
