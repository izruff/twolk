import { Box, Stack, Text } from '@mantine/core';

interface CenteredMessageProps {
  title: string;
  detail?: string;
}

// Full-height centered message, used for the SpacePage's loading / ended /
// not-found states.
export function CenteredMessage({ title, detail }: CenteredMessageProps) {
  return (
    <Box
      style={{
        minHeight: '100vh',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      <Stack align="center" gap="xs">
        <Text size="xl" fw={600}>{title}</Text>
        {detail && <Text c="dimmed">{detail}</Text>}
      </Stack>
    </Box>
  );
}
