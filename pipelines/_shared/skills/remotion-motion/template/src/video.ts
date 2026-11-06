import { loadFont } from '@remotion/google-fonts/Inter';

// The video's format and look, from the brief and design/LOOK.md. Every scene reads from here.
export const video = {
  width: 1920,
  height: 1080,
  fps: 30,
  seconds: 10,
};

// Kinetograph reads no system fonts: every family the video uses is loaded (a Google font here, or a file in
// public/ with @font-face / FontFace). Text in a family that isn't loaded is drawn in a fallback and warned about.
const { fontFamily } = loadFont();

export const look = {
  background: '#0f172a',
  ink: '#f8fafc',
  muted: '#94a3b8',
  accent: '#f97316',
  font: fontFamily,
  safe: 0.05, // title-safe margin, as a fraction of the frame
};
