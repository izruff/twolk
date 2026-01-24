import os from "node:os";

/** Cached announced IP used for all subsequent WebRTC transports. */
let cachedAnnouncedIp: string | null = null;

/**
 * Returns the first non-internal IPv4 address for local fallback.
 *
 * This is only a best-effort value for development and local networks. It can
 * be wrong on hosts with multiple interfaces or NAT.
 */
function getLocalIpAddress(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] ?? []) {
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }
  return "127.0.0.1";
}

/**
 * Resolves the IP address announced in mediasoup ICE candidates.
 *
 * Resolution order is cached value, `ANNOUNCED_IP`, public IP lookup, then a
 * local interface fallback. The result is process-global so every WebRTC
 * transport advertises the same address.
 *
 * TODO: Move this to configuration so transport creation never depends on a
 * live external HTTP request.
 */
export async function getPublicIpAddress(): Promise<string> {
  if (cachedAnnouncedIp !== null) {
    return cachedAnnouncedIp;
  }
  if (process.env.ANNOUNCED_IP) {
    cachedAnnouncedIp = process.env.ANNOUNCED_IP;
    return cachedAnnouncedIp;
  }
  try {
    const response = await fetch("https://api.ipify.org?format=json");
    const data = await response.json();
    cachedAnnouncedIp = data.ip;
  } catch (err) {
    cachedAnnouncedIp = getLocalIpAddress();
    console.warn(
      `Failed to fetch public IP, falling back to local IP ${cachedAnnouncedIp}:`,
      err);
  }
  return cachedAnnouncedIp!;
}
