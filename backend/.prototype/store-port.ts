/**
 * Minimal key/value store port used by coordinator-side services and the
 * signaling server.
 *
 * The functions here are synchronous since coordination happens in a single
 * thread. In reality, a Redis adapter would likely need async methods and
 * handle more complexities like error handling and thread safety.
 */
export interface IStore<K, V> {
  /** Returns true when the key exists in the store. */
  has(key: K): boolean;

  /** Returns the value for a key, or undefined when the key is absent. */
  get(key: K): V | undefined;

  /** Writes or replaces the value for a key. */
  set(key: K, value: V): void;

  /** Removes a key if it exists. */
  delete(key: K): void;
}
