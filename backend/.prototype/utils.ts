export async function getPublicIpAddress(): Promise<string> {
  // TODO: Change this later to use a more reliable method
  const response = await fetch("https://api.ipify.org?format=json");
  const data = await response.json();
  return data.ip;
}
