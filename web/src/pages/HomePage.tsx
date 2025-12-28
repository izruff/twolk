import { useState } from 'react';
import {
  Card, Button, Stack, Group, ActionIcon, Box, Flex, Modal, TextInput, Menu
} from '@mantine/core';
import { IconSettings, IconHistory, IconBrandGithub, IconExternalLink } from '@tabler/icons-react';
import { useForm } from '@mantine/form';

interface CreateFormValues {
  spaceName: string;
  spaceDescription: string;
}

interface ArchiveFormValues {
  archiveId: string,
}

// Dummy recent spaces data
const recentSpaces = [
  { name: 'Design Team', description: 'Collaboration for UI/UX' },
  { name: 'Dev Standup', description: 'Daily developer sync' },
  { name: 'Marketing', description: 'Campaign planning' },
  { name: 'Support', description: 'Customer support chat' },
  { name: 'Archive 2025', description: 'Old project files' },
];

function HomePage() {
  const [colorScheme, setColorScheme] = useState<'light' | 'dark'>('light');
  const handleToggleColorScheme = () => {
    setColorScheme(prev => (prev === 'light' ? 'dark' : 'light'));
  };
  const [createOpen, setCreateOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [archiveLoading, setArchiveLoading] = useState(false);

  const handleRecentSpaceClick = (space: { name: string; description: string }) => {
    // TODO: Implement navigation or action
    console.log('Clicked space:', space);
  };

  const form = useForm({
    initialValues: {
      spaceName: '',
      spaceDescription: '',
    } as CreateFormValues,
    validate: {
      spaceName: value => value.trim().length < 2 ? 'Space name must be at least 2 characters' : null,
    },
  });

  const archiveForm = useForm({
    initialValues: {
      archiveId: '',
    } as ArchiveFormValues,
  });

  const handleCreateSubmit = async (values: CreateFormValues) => {
    // TODO
    setLoading(true);
    console.log(values);
    setTimeout(() => {
      setCreateOpen(false);
      form.reset();
      setLoading(false);
    }, 2000);
  };

  const handleArchiveSubmit = async (values: ArchiveFormValues) => {
    // TODO
    setArchiveLoading(true);
    console.log(values);
    setTimeout(() => {
      setJoinOpen(false);
      archiveForm.reset();
      setArchiveLoading(false);
    }, 2000);
  };

  return (
    <Box style={{ minHeight: '100vh', position: 'relative' }}>
      <Group justify="flex-end" p="md" style={{ position: 'absolute', top: 0, right: 0, width: '100%' }}>
        <ActionIcon
          component="a"
          href="https://github.com/izruff/twolk"
          target="_blank"
          variant="subtle"
          size="lg"
          aria-label="GitHub"
        >
          <IconBrandGithub />
        </ActionIcon>
        <Menu position="bottom-end" shadow="md" width={200}>
          <Menu.Target>
            <ActionIcon variant="subtle" size="lg" aria-label="History">
              <IconHistory />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Label>Recent Spaces</Menu.Label>
            {recentSpaces.slice(0, 5).map((space, idx) => (
              <Menu.Item key={idx} onClick={() => handleRecentSpaceClick(space)}>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <span style={{ fontWeight: 500 }}>{space.name}</span>
                  <span style={{ fontSize: 13, color: '#888' }}>{space.description}</span>
                </div>
              </Menu.Item>
            ))}
            <Menu.Divider />
            <Menu.Item component="a" href="#">
              <Group gap={8}>
                <IconExternalLink size={16} />
                <span>Show entire history...</span>
              </Group>
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
        <Menu position="bottom-end" shadow="md" width={260}>
          <Menu.Target>
            <ActionIcon variant="subtle" size="lg" aria-label="Settings">
              <IconSettings />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Label>Settings</Menu.Label>
            <Menu.Item onClick={handleToggleColorScheme}>
              {colorScheme === 'light' ? 'Switch to Dark Mode' : 'Switch to Light Mode'}
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Group>
      <Flex align="center" justify="center" style={{ height: '100vh' }}>
        <Card shadow="md" padding="xl" radius="md" withBorder style={{ minWidth: 350 }}>
          <Stack gap="xl" align="center">
            <Stack gap="xl" align="center">
              <Button onClick={() => setCreateOpen(true)} size="xl" style={{ width: 220, fontSize: 20 }}>
                Create Space
              </Button>
              <Button onClick={() => setJoinOpen(true)} size="xl" variant="outline" style={{ width: 220, fontSize: 20 }}>
                Find Archive
              </Button>
            </Stack>
          </Stack>
        </Card>
      </Flex>
        <Modal opened={joinOpen} onClose={() => setJoinOpen(false)} title="Find Archive" centered>
          <form onSubmit={archiveForm.onSubmit(handleArchiveSubmit)}>
            <Stack gap="md">
              <TextInput
                label="Archive ID"
                description="Enter the Archive ID to find."
                placeholder="Archive ID"
                {...archiveForm.getInputProps('archiveId')}
                required
              />
              <Button type="submit" loading={archiveLoading} fullWidth>
                Find
              </Button>
            </Stack>
          </form>
        </Modal>
  <Modal opened={createOpen} onClose={() => setCreateOpen(false)} title="Create Space" centered>
        <form onSubmit={form.onSubmit(handleCreateSubmit)}>
          <Stack gap="md">
            <TextInput
              label="Space Name"
              description="A name for your space."
              placeholder="Enter space name"
              {...form.getInputProps('spaceName')}
              required
            />
            <TextInput
              label="Space Description"
              description="Describe your space (optional)."
              placeholder="Enter space description"
              {...form.getInputProps('spaceDescription')}
            />
            <div style={{ fontSize: 13, color: '#888', marginBottom: 8, textAlign: 'center' }}>
              By creating a space, you agree to follow the community guidelines and understand that spaces may be monitored for safety and compliance.
            </div>
            <Button type="submit" loading={loading} fullWidth>
              Create
            </Button>
          </Stack>
        </form>
      </Modal>
      {/* Join Room modal will be implemented later */}
    </Box>
  );
}

export default HomePage;
