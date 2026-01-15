import { getEnv } from "../utils/env";

// HTTP in development, HTTPS in production. Must match ENVIRONMENT in the
// backend .env (both dev or both prod). Socket.IO upgrades http->ws and
// https->wss automatically.
const isProduction = getEnv('VITE_ENVIRONMENT', 'development') === 'production';
const protocol = isProduction ? 'https' : 'http';

const REST_API_HOST = getEnv('VITE_REST_API_HOST', 'localhost:8000');

export const REST_API_BASE_URL = `${protocol}://${REST_API_HOST}`;
