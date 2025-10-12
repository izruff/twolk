import os from "node:os";

let cachedAnnouncedIp: string | null = null;

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

export async function getPublicIpAddress(): Promise<string> {
  if (cachedAnnouncedIp !== null) {
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
