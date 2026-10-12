// Read by every `npx remotion still|render` run from this folder.
import { Config } from '@remotion/cli/config';

// Without this, H.264 comes out full-range (yuvj420p, untagged), which the final pass refuses and some players show
// washed out. BT.709 gives standard yuv420p with proper color tags.
Config.setColorSpace('bt709');
