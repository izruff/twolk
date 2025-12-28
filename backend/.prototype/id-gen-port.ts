/*

ID generator port. Stateful: `next()` returns a fresh id each call.

Current adapter: ProcessCounterIdGenerator (in-process monotonic counter,
wrapped at MAX_SAFE_INTEGER). Future possibilities: a Redis-INCR-backed
adapter for cluster uniqueness, or a Snowflake-style adapter that
embeds a node bit and a timestamp.

*/

export interface IIdGenerator {
  next(): number;
}
