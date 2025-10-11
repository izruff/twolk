export function createSilentTrack(audioContext: AudioContext): MediaStreamTrack {
  const gain = audioContext.createGain();
  gain.gain.value = 0;

  const dst = audioContext.createMediaStreamDestination();
  gain.connect(dst);

  const track = dst.stream.getAudioTracks()[0];

  return track;
}
