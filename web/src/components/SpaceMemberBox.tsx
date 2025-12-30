import { useRef, useEffect } from "react";
import { Box, Text } from "@mantine/core";
import { IconMicrophoneOff } from "@tabler/icons-react";

import type { MemberData } from "../types/member";


interface SpaceMemberBoxProps {
  data: MemberData;
  isSelf: boolean;
  isMuted: boolean;
  analyzer: AnalyserNode | null;
}

// Ring thickness, in px, grows from BASE up to MAX as the member's audio
// gets louder. The ring is drawn outside the box so it never changes layout.
const BASE_BORDER_WIDTH = 2;
const MAX_BORDER_WIDTH = 9;
const BOX_RADIUS = 20;

export function SpaceMemberBox({ data, isSelf, isMuted, analyzer }: SpaceMemberBoxProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const borderRingRef = useRef<HTMLDivElement>(null);
  const animationIdRef = useRef<number | null>(null);

  useEffect(() => {
    const setRingWidth = (width: number) => {
      if (!borderRingRef.current) return;
      borderRingRef.current.style.borderWidth = `${width}px`;
      borderRingRef.current.style.inset = `-${width}px`;
      borderRingRef.current.style.borderRadius = `${BOX_RADIUS + width}px`;
    };

    const resetBorderRing = () => {
      setRingWidth(BASE_BORDER_WIDTH);
    };

    if (!analyzer) {
      resetBorderRing();
      return;
    }

    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const bufferLength = analyzer.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const draw = () => {
      analyzer.getByteFrequencyData(dataArray);

      ctx.fillStyle = isSelf ? '#e0f7fa' : '#f5f5f5';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const barWidth = canvas.width / bufferLength * 2.5;
      let barHeight;
      let x = 0;
      let sum = 0;

      ctx.fillStyle = isSelf ? '#00bcd4' : '#999';

      for (let i = 0; i < bufferLength; i++) {
        sum += dataArray[i];
        barHeight = (dataArray[i] / 255) * canvas.height;
        ctx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);
        x += barWidth + 1;
      }

      // Mean frequency magnitude (0..255); saturate at a fairly low value so
      // ordinary speech, not just shouting, lights up the border.
      const level = Math.min(1, (sum / bufferLength) / 48);
      const width = BASE_BORDER_WIDTH + level * (MAX_BORDER_WIDTH - BASE_BORDER_WIDTH);
      setRingWidth(width);

      animationIdRef.current = requestAnimationFrame(draw);
    };

    animationIdRef.current = requestAnimationFrame(draw);

    return () => {
      if (animationIdRef.current !== null) {
        cancelAnimationFrame(animationIdRef.current);
      }
      resetBorderRing();
    };
  }, [analyzer, canvasRef, isSelf]);

  return (
    <Box
      style={{
        borderRadius: BOX_RADIUS,
        background: isSelf ? '#e0f7fa' : '#f5f5f5',
        boxSizing: 'border-box',
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
        overflow: 'visible',
      }}
    >
      <Box
        ref={borderRingRef}
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: `-${BASE_BORDER_WIDTH}px`,
          border: `${BASE_BORDER_WIDTH}px solid ${isSelf ? '#00bcd4' : '#ddd'}`,
          borderRadius: BOX_RADIUS + BASE_BORDER_WIDTH,
          boxSizing: 'border-box',
          pointerEvents: 'none',
          zIndex: 20,
        }}
      />
      <canvas
        ref={canvasRef}
        width={200}
        height={150}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          borderRadius: BOX_RADIUS,
        }}
      />
      {isMuted && (
        <IconMicrophoneOff
          size={20}
          style={{
            position: 'absolute',
            bottom: 12,
            left: 12,
            color: isSelf ? '#00bcd4' : '#999',
          }}
        />
      )}
      <Text
        size="md"
        fw={isSelf ? 700 : 500}
        color={isSelf ? 'cyan.7' : 'dark'}
        style={{ position: 'absolute', bottom: 16, right: 18, zIndex: 10 }}
      >
        {data.name}
      </Text>
    </Box>
  );
}
