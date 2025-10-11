import { getEnv } from "../utils/env";

export const REST_API_BASE_URL = getEnv('REST_API_BASE_URL', "http://localhost:8000/v1");
export const SIGNALING_SERVER_URL = getEnv('SIGNALING_SERVER_URL', "https://localhost:3000");
