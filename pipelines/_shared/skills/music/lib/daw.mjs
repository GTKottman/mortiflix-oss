// How to bring a MIDI pack into the owner's DAW: the steps written into every cue sheet. `daw` is the owner's choice in
// setup ($MFX_DAW); without one, the steps are general. Menu names are the DAWs' own; where a DAW has several ways in,
// the plainest one is given.

const STEPS = {
  ableton: ['Set the tempo in the Control Bar first.', 'Drag the per-channel files (or a section folder\'s clips) from the browser or your file manager into the Arrangement View, one track each, starting at bar 1.'],
  fl: ['File › Import › MIDI file, and pick the arrangement file (or a single channel\'s file).', 'Check the tempo in the toolbar, then give each channel its instrument in the Channel Rack.'],
  logic: ['File › Import › MIDI File, and pick the arrangement file: Logic makes a track per channel.', 'Check the tempo in the control bar, then give each track its instrument.'],
  reaper: ['Insert › Media file…, and pick the arrangement file; when REAPER asks, expand the MIDI tracks to new tracks and import the tempo map.', 'Put the edit cursor at the start of the project first, so bar 1 lands at bar 1.'],
  bitwig: ['Set the tempo in the transport first.', 'Drag the per-channel files (or a section folder\'s clips) from the browser or your file manager onto the Arranger, one track each, at bar 1.'],
  cubase: ['File › Import › MIDI File, and pick the arrangement file: Cubase makes a track per channel.', 'Check the tempo in the transport, then give each track its instrument.'],
  studioone: ['Drag the arrangement file from the browser or your file manager into the arrangement at bar 1.', 'Check the tempo in the transport, then give each track its instrument.'],
  garageband: ['Drag the arrangement file into the tracks area at bar 1: GarageBand makes a software-instrument track per channel.', 'Set the tempo in the LCD, then pick each track\'s instrument in the Library.'],
  protools: ['File › Import › MIDI…, pick the arrangement file, import it to new tracks at the session start.', 'Check the tempo in the Conductor ruler, then route each track to its instrument.'],
};

const GENERAL = ['Set your project\'s tempo and time signature to the ones above.', 'Import the arrangement file (one track per channel) or the per-channel files, with bar 1 at the start of your project.'];

export function importSteps(daw) {
  return [...(STEPS[daw] || GENERAL),
    'Channel 10 is drums in General MIDI numbers (36 kick, 38 snare, 42 closed hat…): map them to your drum kit.',
    'The section clips in sections/ start at their own bar 1: drop them anywhere, or loop them.'];
}

export const DAW_NAMES = {
  ableton: 'Ableton Live', fl: 'FL Studio', logic: 'Logic Pro', reaper: 'REAPER', bitwig: 'Bitwig Studio',
  cubase: 'Cubase', studioone: 'Studio One', garageband: 'GarageBand', protools: 'Pro Tools',
};
