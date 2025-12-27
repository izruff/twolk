/*

Store port. A minimal key/value interface that the coordinator-side
services and the signaling server use for spaces and members.

The shape is deliberately Redis-friendly (`get`, `set`, `delete`, `has`)
so a future Redis adapter can drop in. The current adapter is
in-memory and synchronous; if/when a Redis adapter shows up, this
interface will likely change to return Promises and the callers will
need to grow `await` points. We accept that future migration cost in
exchange for keeping the present code simple.

*/

export interface IStore<K, V> {
  has(key: K): boolean;
  get(key: K): V | undefined;
  set(key: K, value: V): void;
  delete(key: K): void;
}
