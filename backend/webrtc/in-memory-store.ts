/*

In-memory IStore adapter. Backed by a plain Map. Used by the default
composition root; tests can either reuse this or build a fake with the
same shape if they want introspection.

*/

import type { IStore } from "./store-port.ts";


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
