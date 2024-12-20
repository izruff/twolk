import { useState } from 'react';
import { Box, Grid, Stack, Text, Button, Group, Modal, ActionIcon } from '@mantine/core';
import { IconMicrophone, IconMicrophoneOff, IconShare, IconSettings } from '@tabler/icons-react';

const speakers = [
  { id: '1', name: 'You', isSelf: true },
  { id: '2', name: 'Alice', isSelf: false },
  { id: '3', name: 'Bob', isSelf: false },
  { id: '4', name: 'Charlie', isSelf: false },
  { id: '5', name: 'Dana', isSelf: false },
];

function SpacePage() {
  const [muted, setMuted] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <Box style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Stack justify="center" align="center" style={{ flex: 1, width: '100%' }}>
        <Grid gutter="xl" style={{ width: '100%', maxWidth: 900 }}>
          {speakers.map((speaker) => (
            <Grid.Col span={12 / Math.min(speakers.length, 4)} key={speaker.id}>
              <Box
                style={{
                  borderRadius: 20,
                  background: speaker.isSelf ? '#e0f7fa' : '#f5f5f5',
                  border: speaker.isSelf ? '2px solid #00bcd4' : '1px solid #ddd',
                  aspectRatio: '1.3/1',
                  minHeight: 120,
                  minWidth: 140,
                  maxWidth: 220,
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'flex-end',
                  alignItems: 'flex-end',
                  padding: 24,
                  position: 'relative',
                  boxShadow: speaker.isSelf ? '0 0 0 2px #00bcd4' : 'none',
                }}
              >
                <Text
                  size="md"
                  fw={speaker.isSelf ? 700 : 500}
                  color={speaker.isSelf ? 'cyan.7' : 'dark'}
                  style={{ position: 'absolute', bottom: 16, right: 18 }}
                >
                  {speaker.name}
                </Text>
              </Box>
            </Grid.Col>
          ))}
        </Grid>
      </Stack>
      <Box style={{ width: '100%', padding: 24, borderTop: '1px solid #eee', background: '#fff', position: 'sticky', bottom: 0 }}>
        <Group justify="center" gap="xl">
          <ActionIcon
            size="xl"
            variant={muted ? 'light' : 'filled'}
            color={muted ? 'gray' : 'cyan'}
            onClick={() => setMuted((m) => !m)}
            aria-label={muted ? 'Unmute' : 'Mute'}
          >
            {muted ? <IconMicrophoneOff size={28} /> : <IconMicrophone size={28} />}
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
