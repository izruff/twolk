import { useRef, useSyncExternalStore } from 'react';
import { io } from 'socket.io-client';

import { SIGNALING_SERVER_URL } from '../constants/url';
import { Space, type SpaceSnapshot } from '../types/space';
import { SignalingSocketWrapper } from '../types/signaling.socket';
import type { MemberData, MemberStateFromClient } from '../types/member';


export function useSpace(
  spaceUuid: string,
  producerData: MemberData,
  producerState: MemberStateFromClient,
): [Space, SpaceSnapshot | null] {
  const spaceRef = useRef<Space | null>(null);
  const subscribeRef = useRef<((callback: () => void) => () => void) | null>(null);
  const getSnapshotRef = useRef<(() => SpaceSnapshot | null) | null>(null);

  if (!spaceRef.current) {
    const socket = new SignalingSocketWrapper(
      io(SIGNALING_SERVER_URL, { autoConnect: false }),
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
    subscribeRef.current!,
    getSnapshotRef.current!,
  );

  return [spaceRef.current, snapshot];
}
