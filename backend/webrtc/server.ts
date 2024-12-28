/*

Implementation for the WebSocket signaling server.
- Maintains connection with client and updates state changes in the space.
- Communicates with the coordinator on client join events.

In the future, there should be another service to allow scaling these
horizontally and manage communication between servers.

*/

import { Coordinator } from "./coordinator.ts";

import https from "node:https";
import { Server } from "socket.io";

interface Member {
  name: string,
}

interface ServerToClientEvents {
  // TODO
}

interface ClientToServerEvents {
  // TODO
}

interface InterServerEvents {
  // TODO
}

interface SocketData {
  spaceId: string,
  member: Member,
}

export function createWsSignalingServer(
  httpsOptions: https.ServerOptions,
  port: number,
  coordinator: Coordinator,
) {
  const server = https.createServer(httpsOptions);
  server.listen(port);

  const io = new Server<
    ServerToClientEvents, ClientToServerEvents, InterServerEvents, SocketData
  >(server);

  io.on("connection", async (socket) => {
    // TODO
  });

  return io;
}
