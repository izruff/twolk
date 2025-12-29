export const SSL_KEY_PATH = "../../certs/ssl/key.pem";
export const SSL_CERTS_PATH = "../../certs/ssl/cert.pem";

export const SFU_WORKER_PORT_RANGE = { min: 10000, max: 11000 };

export const SPACE_HTTP_PORT = 8000;

// Origin of the web frontend, used for CORS / Socket.IO allow-listing.
// TODO: This is the dev origin; production would read it from config.
export const WEB_ORIGIN = "http://localhost:5173";
