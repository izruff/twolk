/*

Protocol selection helper.

In development the backend speaks plain HTTP; in production it speaks
HTTPS. The composition root decides which by reading ENVIRONMENT and
passing TlsOptions (or null) down to each server, so the http/https
branch lives in exactly one place.

*/

import http from "node:http";
import https from "node:https";


export interface TlsOptions {
  key: string;
  cert: string;
}


// Creates an http or https server depending on whether TLS options are
// given. https.Server is a subtype of http.Server, so callers treat the
// result uniformly.
export function createNodeHttpServer(
  tlsOptions: TlsOptions | null,
  requestListener?: http.RequestListener,
): http.Server {
  return tlsOptions !== null
    ? https.createServer(tlsOptions, requestListener)
    : http.createServer(requestListener);
}
