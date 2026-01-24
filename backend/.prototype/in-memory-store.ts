import type { IStore } from "./store-port.ts";


/**
 * In-memory `IStore` adapter backed by a plain `Map`.
 *
 * This is used for the prototype which runs all coordinator-side services
 * in a single process. If used in production, consider making it thread-safe.
 */
export class InMemoryStore<K, V> implements IStore<K, V> {
  data: Map<K, V> = new Map();

  has(key: K): boolean {
    return this.data.has(key);
  }

  get(key: K): V | undefined {
    return this.data.get(key);
  }

  set(key: K, value: V): void {
    this.data.set(key, value);
  }

  delete(key: K): void {
    this.data.delete(key);
  }
}
