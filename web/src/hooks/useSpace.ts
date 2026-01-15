import { useRef, useSyncExternalStore } from 'react';
import { io } from 'socket.io-client';

import { Space, type SpaceSnapshot } from '../types/space';
import { SignalingSocketWrapper } from '../types/signaling.socket';
import type { MemberData, MemberStateFromClient } from '../types/member';


// serverUrl is null until the try-join response arrives; the Space object
// is not created until a non-null URL is provided.
export function useSpace(
  spaceUuid: string,
  serverUrl: string | null,
  producerData: MemberData,
  producerState: MemberStateFromClient,
): [Space | null, SpaceSnapshot | null] {
  const spaceRef = useRef<Space | null>(null);
  const subscribeRef = useRef<((callback: () => void) => () => void) | null>(null);
  const getSnapshotRef = useRef<(() => SpaceSnapshot | null) | null>(null);

  if (!spaceRef.current && serverUrl !== null) {
    const socket = new SignalingSocketWrapper(
      io(serverUrl, { autoConnect: false }),
      spaceUuid,
      producerData,
      producerState
    );
    spaceRef.current = new Space(producerData, producerState, socket);

    // Store the bound methods to prevent creating new references on each render
    subscribeRef.current = spaceRef.current.subscribeSnapshotUpdates.bind(spaceRef.current);
    getSnapshotRef.current = spaceRef.current.getSnapshot.bind(spaceRef.current);
  }

  const snapshot = useSyncExternalStore(
    subscribeRef.current ?? (() => () => {}),
    getSnapshotRef.current ?? (() => null),
  );

  return [spaceRef.current, snapshot];
}
