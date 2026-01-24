import http from "node:http";
import https from "node:https";


/**
 * PEM-encoded certificate material used to create HTTPS servers.
 */
export interface TlsOptions {
  key: string;
  cert: string;
}


/**
 * Creates an HTTP or HTTPS server from optional TLS options.
 *
 * Configuration decides whether `tlsOptions` is present. Callers receive a
 * plain `http.Server` type because `https.Server` is compatible with the same
 * lifecycle methods used by the prototype.
 */
export function createNodeHttpServer(
  tlsOptions: TlsOptions | null,
  requestListener?: http.RequestListener,
): http.Server {
  return tlsOptions !== null
    ? https.createServer(tlsOptions, requestListener)
    : http.createServer(requestListener);
}
