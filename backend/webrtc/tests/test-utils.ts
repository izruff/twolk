/*

Test helpers shared across the vitest suites.

*/

// Waits for `cond` to return truthy, or throws after `timeoutMs`. Polls
// on microtask boundaries — enough for the bus-publish/ack chain that
// most of this codebase runs on.
export async function waitFor(
  cond: () => boolean | undefined | null,
  timeoutMs: number = 1000,
): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timeout");
    }
    await new Promise((r) => setTimeout(r, 1));
  }
}

// Wait one macrotask, which flushes everything the bus chain has queued
// so far. Often enough on its own when the sequence is bounded.
export async function flushAsync(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}
