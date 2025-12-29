import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { Box, Grid, Stack, Text, Button, Group, Modal, ActionIcon } from '@mantine/core';
import { IconMicrophone, IconMicrophoneOff, IconShare, IconSettings } from '@tabler/icons-react';

import { SpaceMemberBox } from '../components/SpaceMemberBox';
import { CenteredMessage } from '../components/CenteredMessage';
import { useSpace } from '../hooks/useSpace';
import { REST_API_BASE_URL } from '../constants/url';

import type { MemberClientEventType } from '../types/member';


// Whether the space can be joined, derived from GET /space before connecting.
type AccessState = 'loading' | 'available' | 'ended' | 'missing' | 'error';


function SpacePage() {
  const [shareOpen, setShareOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const audioContextRef = useRef<AudioContext>(new AudioContext());
  const audioContextResumeResolverRef = useRef<(() => void) | null>(null);

  const [producerAnalyzer, setProducerAnalyzer] = useState<AnalyserNode | null>(null);
  const [consumerAnalyzers, setConsumerAnalyzers] = useState<Map<number, AnalyserNode>>(new Map());
  const consumerAudioRefs = useRef<Map<number, HTMLAudioElement>>(new Map());

  const [userMediaTrack, setUserMediaTrack] = useState<MediaStreamTrack | null>(null);

  const spaceUuid = useParams().id!;

  const [accessState, setAccessState] = useState<AccessState>('loading');

  const [space, snapshot] = useSpace(
    spaceUuid,
    { name: 'You' },
    { isMuted: false },
  );

  // Expose internals for e2e testing.
  if (typeof window !== 'undefined') {
    // @ts-expect-error attaching debug handle
    window.__twolkDebug = {
      space,
      snapshot,
      audioContext: audioContextRef.current,
      producerAnalyzer,
      consumerAnalyzers,
      consumerAudioRefs: consumerAudioRefs.current,
      userMediaTrack,
    };
  }

  function setUpAnalyzer(track: MediaStreamTrack) {
    const analyzer = audioContextRef.current.createAnalyser();
    analyzer.fftSize = 2048;
    const source = audioContextRef.current.createMediaStreamSource(new MediaStream([track]));
    source.connect(analyzer);
    return analyzer;
  }

  // Check the space exists and hasn't ended before connecting.
  useEffect(() => {
    let cancelled = false;
    fetch(`${REST_API_BASE_URL}/space?uuid=${encodeURIComponent(spaceUuid)}`)
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 404) { setAccessState('missing'); return; }
        if (!res.ok) { setAccessState('error'); return; }
        const body = await res.json();
        if (cancelled) return;
        setAccessState(body.status === 'ended' ? 'ended' : 'available');
      })
      .catch(() => { if (!cancelled) setAccessState('error'); });
    return () => { cancelled = true; };
  }, [spaceUuid]);

  // Preparing the space (only once we know it is joinable)
  useEffect(() => {
    if (accessState !== 'available') return;

    space.init(
      () => { console.log("connected") },
      () => { console.log("disconnected") },
      ({ message }) => { console.error("failed:", message); },
    );

    const producerHandler = (event: MemberClientEventType) => {
      if (event === "stateUpdated") {
        // Ideally we can sync snapshot with local state to ensure consistency
        // Ignore for now; we just use our local state and warn if inconsistent
        // TODO
      } else if (event === "transportReady") {
        // Nothing to do right now; track will be set by another useEffect
      } else {
        console.warn("Unknown producer member event:", event);
      }
    };
    space.onProducerMemberEvent(producerHandler);

    const consumerHandler = (memberId: number, event: MemberClientEventType) => {
      if (event === "stateUpdated") {
        // Already handled by snapshot
      } else if (event === "transportReady") {
        const track = space.getConsumerTrack(memberId);

        // Chrome won't pull RTP data into the Web Audio graph for a remote
        // MediaStreamTrack unless the track is also attached to an
        // HTMLMediaElement. Attach to a hidden audio element so the pipeline
        // actually flows.
        const stream = new MediaStream([track]);
        const existingAudio = consumerAudioRefs.current.get(memberId);
        if (existingAudio !== undefined) {
          existingAudio.pause();
          existingAudio.srcObject = null;
        }
        const audio = new Audio();
        audio.autoplay = true;
        audio.srcObject = stream;
        audio.play().catch((err) => {
          console.error("Failed to play consumer audio:", err);
        });
        consumerAudioRefs.current.set(memberId, audio);

        const analyzer = setUpAnalyzer(track);
        setConsumerAnalyzers((prev) => {
          const next = new Map(prev);
          next.set(memberId, analyzer);
          return next;
        });
      } else {
        console.warn("Unknown consumer member event:", event);
      }
    };
    space.onConsumerMemberEvent(consumerHandler);

    const spaceInitHandler = () => {
      const audioContextResumePromise = new Promise<void>((resolve) => {
        if (audioContextRef.current.state === "running") {
          resolve();
        } else {
          audioContextResumeResolverRef.current = resolve;
        }
      });
      audioContextResumePromise
        .then(() => {
          console.log("Audio context resumed; preparing to initialize transport factory");
          return space.initTransportFactory(audioContextRef.current);
        })
        .then(() => {
          console.log("Transport factory initialized for space");
        })
        .catch((error) => {
          // TODO: How to handle this?
          console.error("Failed to initialize transport factory for space:", error);
        });
    };
    space.onSpaceInit(spaceInitHandler);

    return () => {
      space.offProducerMemberEvent(producerHandler);
      space.offConsumerMemberEvent(consumerHandler);
      space.offSpaceInit(spaceInitHandler);
      space.cleanup();
      consumerAudioRefs.current.forEach((audio) => {
        audio.pause();
        audio.srcObject = null;
      });
      consumerAudioRefs.current.clear();
    };
  }, [space, accessState]);

  // Wait for user interaction to resume audio context
  useEffect(() => {
    const handleInteraction = () => {
      if (audioContextRef.current.state === "suspended") {
        audioContextRef.current.resume().then(() => {
          console.log("Audio context resumed");
          if (audioContextResumeResolverRef.current) {
            audioContextResumeResolverRef.current();
            audioContextResumeResolverRef.current = null;
          }
        });
      }
      window.removeEventListener('click', handleInteraction);
    };
    window.addEventListener('click', handleInteraction);
    return () => {
      window.removeEventListener('click', handleInteraction);
    };
  }, []);

  // Requesting for user media (only once the space is joinable)
  useEffect(() => {
    if (accessState !== 'available') return;
    navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      .then((stream) => {
        const audioTrack = stream.getAudioTracks()[0];
        audioTrack.enabled = true;  // TODO
        setUserMediaTrack(audioTrack);
        setProducerAnalyzer(setUpAnalyzer(audioTrack));
        console.log("Analyzer for user media set up");
      })
      .catch((err) => {
        console.error("Failed to get user media:", err);
      });
  }, [accessState]);

  // Set producer track once user media is ready
  useEffect(() => {
    if (!space || !userMediaTrack) return;
    if (space.producerIsReady()) {
      space.setProducerTrack(userMediaTrack);
    } else {
      const handler = (event: MemberClientEventType) => {
        if (event === "transportReady") {
          space.setProducerTrack(userMediaTrack);
          space.offProducerMemberEvent(handler);
        }
      };
      space.onProducerMemberEvent(handler);
    }
  }, [space, userMediaTrack]);

  if (accessState === 'loading') {
    return <CenteredMessage title="Loading…" />;
  }
  if (accessState === 'missing') {
    return <CenteredMessage title="Space not found" detail="This space does not exist." />;
  }
  if (accessState === 'ended') {
    return <CenteredMessage title="This space has ended" detail="It is no longer available to join." />;
  }
  if (accessState === 'error') {
    return <CenteredMessage title="Couldn't load this space" detail="Please try again." />;
  }

  // accessState === 'available' — connecting to the signaling server.
  if (snapshot === null) {
    return <CenteredMessage title="Connecting…" />;
  }

  const selfMuted = snapshot.members.find(
    (m) => m.id === snapshot.producer.id,
  )?.state.isMuted ?? false;

  // Muting stops audio from going out (track.enabled = false) and tells the
  // server so other members' member boxes reflect it.
  const toggleMute = () => {
    const newMuted = !selfMuted;
    if (userMediaTrack) {
      userMediaTrack.enabled = !newMuted;
    }
    space.updateProducerMemberState({ isMuted: newMuted });
  };

  return (
    <Box style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Stack justify="center" align="center" style={{ flex: 1, width: '100%' }}>
        <Grid gutter="xl" style={{ width: '100%', maxWidth: 900 }}>
          {snapshot.members.map(({ id, data, state }) => (
            <Grid.Col span={12 / Math.min(snapshot.members.length, 4)} key={id}>
              <SpaceMemberBox
                data={data}
                isSelf={id === snapshot.producer.id}
                isMuted={state.isMuted}
                analyzer={
                  id === snapshot.producer.id
                    ? producerAnalyzer
                    : consumerAnalyzers.get(id) ?? null
                }
              />
            </Grid.Col>
          ))}
        </Grid>
      </Stack>
      <Box style={{ width: '100%', padding: 24, borderTop: '1px solid #eee', background: '#fff', position: 'sticky', bottom: 0 }}>
        <Group justify="center" gap="xl">
          <ActionIcon
            size="xl"
            variant={selfMuted ? 'light' : 'filled'}
            color={selfMuted ? 'gray' : 'cyan'}
            onClick={toggleMute}
            aria-label={selfMuted ? 'Unmute' : 'Mute'}
          >
            {selfMuted ? <IconMicrophoneOff size={28} /> : <IconMicrophone size={28} />}
          </ActionIcon>
          <Button leftSection={<IconShare size={20} />} size="md" onClick={() => setShareOpen(true)}>
            Share
          </Button>
          <Button leftSection={<IconSettings size={20} />} size="md" variant="outline" onClick={() => setSettingsOpen(true)}>
            Settings
          </Button>
        </Group>
      </Box>
      <Modal opened={shareOpen} onClose={() => setShareOpen(false)} title="Share Space" centered>
        <Text>Share this space with others. (Content TBD)</Text>
      </Modal>
      <Modal opened={settingsOpen} onClose={() => setSettingsOpen(false)} title="Space Settings" centered>
        <Text>Settings for this space. (Content TBD)</Text>
      </Modal>
    </Box>
  );
}

export default SpacePage;
