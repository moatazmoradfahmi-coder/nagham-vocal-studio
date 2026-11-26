/**
 * Nagham Studio — Smart Pitch Analyzer, Chord Composer & Multi-Instrument Arranger
 *
 * 1. Detects sung vocal pitch contour (Autocorrelation / YIN-inspired)
 * 2. Identifies Root Key & Musical Scale / Arabic Maqam (Minor, Major, Hijaz, Kurd, Bayati)
 * 3. Composes bar-by-bar harmonious chord progressions matching the vocal melody
 * 4. Synthesizes rich stereo multi-instrument backing arrangements (Piano, Guitar,
 *    Oriental Oud, Strings, Bass, Synth) + Rhythms (Maqsum, Saidi, Pop, Lo-Fi, Trap, Acoustic)
 */

import { createReverbIR, clamp } from './audio-engine.js';
import { NOTE_NAMES, NOTE_NAMES_AR, SCALES, detectFramePitchHz } from './autotune.js';

export { NOTE_NAMES, NOTE_NAMES_AR, SCALES, detectFramePitchHz };

export const CHORD_QUALITIES = {
  maj: { suffix: '', intervals: [0, 4, 7] },
  min: { suffix: 'm', intervals: [0, 3, 7] },
  maj7: { suffix: 'maj7', intervals: [0, 4, 7, 11] },
  min7: { suffix: 'm7', intervals: [0, 3, 7, 10] },
  dom7: { suffix: '7', intervals: [0, 4, 7, 10] },
  sus2: { suffix: 'sus2', intervals: [0, 2, 7] },
  dim: { suffix: 'dim', intervals: [0, 3, 6] },
};

export const RHYTHM_STYLES = [
  { id: 'none', name: 'بدون إيقاع (كوردات فقط)' },
  { id: 'maqsum', name: 'مقسوم شرقي (دربكة ورق)' },
  { id: 'saidi', name: 'سعيدي / بلدي شرقي' },
  { id: 'pop', name: 'بوب عصري (Pop Groove)' },
  { id: 'lofi', name: 'لو-فاي / هيب هوب هادئ' },
  { id: 'trap', name: 'تراب / راب (Trap 808)' },
  { id: 'acoustic', name: 'أكوستيك هادئ (Kick & Shaker)' },
];

export const PLAY_STYLES = [
  { id: 'ballad', name: 'هادئ ورومانسي (Ballad)' },
  { id: 'arpeggio', name: 'أربيجيو متدفق (Arpeggio)' },
  { id: 'groove', name: 'إيقاعي حيوي (Rhythmic Groove)' },
  { id: 'oriental', name: 'طربي شرقي (Oriental Feel)' },
];

export function formatChordName(rootPc, quality) {
  const note = NOTE_NAMES[((rootPc % 12) + 12) % 12];
  const q = CHORD_QUALITIES[quality] || CHORD_QUALITIES.maj;
  return `${note}${q.suffix}`;
}

export function getChordMidiNotes(rootPc, quality, baseOctaveMidi = 48) {
  const q = CHORD_QUALITIES[quality] || CHORD_QUALITIES.maj;
  let rootMidi = baseOctaveMidi + (((rootPc % 12) + 12) % 12);
  if (rootMidi > 57) rootMidi -= 12;
  return q.intervals.map((iv) => rootMidi + iv);
}

/**
 * Analyze a recorded vocal AudioBuffer to detect Root Key, Scale/Maqam,
 * and compose a bar-by-bar harmonious chord progression.
 */
export function analyzeVocalAndComposeChords(vocalBuffer, {
  bpm = 100,
  beatsPerBar = 4,
  preferredScaleId = 'auto',
  preferredRoot = -1,
} = {}) {
  const sr = vocalBuffer.sampleRate;
  const data = vocalBuffer.getChannelData(0);
  const barSec = (60 / clamp(bpm, 50, 200)) * beatsPerBar;
  const numBars = Math.max(4, Math.ceil(vocalBuffer.duration / barSec));

  const frameSize = Math.min(2048, Math.floor(sr * 0.055));
  const hopSize = Math.floor(sr * 0.045);

  const globalChroma = new Float32Array(12);
  const barChromas = Array.from({ length: numBars }, () => new Float32Array(12));
  let voicedFrames = 0;

  for (let pos = 0; pos + frameSize < data.length; pos += hopSize) {
    const frame = data.subarray(pos, pos + frameSize);
    const hz = detectFramePitchHz(frame, sr);
    if (!hz) continue;

    const midi = 69 + 12 * Math.log2(hz / 440);
    const pc = ((Math.round(midi) % 12) + 12) % 12;
    const barIdx = Math.min(numBars - 1, Math.floor((pos / sr) / barSec));

    globalChroma[pc] += 1;
    barChromas[barIdx][pc] += 1;
    voicedFrames++;
  }

  // Fallback if recording was very quiet or unpitched
  if (voicedFrames < 4) {
    const root = preferredRoot >= 0 ? preferredRoot : 2; // D
    const scaleId = preferredScaleId !== 'auto' && SCALES[preferredScaleId] ? preferredScaleId : 'minor';
    const prog = buildDefaultProgression(root, scaleId, numBars);
    return {
      rootPc: root,
      scaleId,
      confidence: 0,
      voicedFrames,
      barSec,
      chords: prog,
    };
  }

  // Score every (root, scale) pair against the global pitch-class histogram
  const candidateScales = preferredScaleId !== 'auto' && SCALES[preferredScaleId]
    ? [SCALES[preferredScaleId]]
    : Object.values(SCALES);

  const candidateRoots = preferredRoot >= 0
    ? [preferredRoot]
    : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

  let bestRoot = 0;
  let bestScale = candidateScales[0];
  let bestScore = -Infinity;

  for (const scale of candidateScales) {
    for (const root of candidateRoots) {
      const inScale = new Set(scale.intervals.map((iv) => (root + iv) % 12));
      let score = 0;
      for (let pc = 0; pc < 12; pc++) {
        if (inScale.has(pc)) {
          // Slight emphasis on Tonic (0) and Dominant (7)
          const rel = (pc - root + 12) % 12;
          const weight = rel === 0 ? 1.35 : rel === 7 ? 1.15 : 1.0;
          score += globalChroma[pc] * weight;
        } else {
          score -= globalChroma[pc] * 1.45;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestRoot = root;
        bestScale = scale;
      }
    }
  }

  const totalWeight = globalChroma.reduce((a, b) => a + b, 0) || 1;
  const confidence = clamp(bestScore / (totalWeight * 1.1), 0, 1);

  // Choose the best harmonious chord for each bar
  const chords = [];
  let prevChordKey = '';

  for (let b = 0; b < numBars; b++) {
    const chroma = barChromas[b];
    const barEnergy = chroma.reduce((a, v) => a + v, 0);

    if (barEnergy < 1.5) {
      // Silent bar -> use musical default progression cadence
      const defIdx = bestScale.defaultProg[b % bestScale.defaultProg.length];
      const cDef = bestScale.chords[defIdx % bestScale.chords.length];
      const cRoot = (bestRoot + cDef.degree) % 12;
      chords.push({
        bar: b + 1,
        rootPc: cRoot,
        quality: cDef.quality,
        name: formatChordName(cRoot, cDef.quality),
      });
      prevChordKey = `${cRoot}_${cDef.quality}`;
      continue;
    }

    let bestChord = bestScale.chords[0];
    let bestChordScore = -Infinity;

    for (const cand of bestScale.chords) {
      const cRoot = (bestRoot + cand.degree) % 12;
      const q = CHORD_QUALITIES[cand.quality] || CHORD_QUALITIES.maj;
      const chordTones = q.intervals.map((iv) => (cRoot + iv) % 12);

      let score = 0;
      for (let pc = 0; pc < 12; pc++) {
        if (chroma[pc] === 0) continue;
        if (pc === chordTones[0]) score += chroma[pc] * 2.2;      // Root match
        else if (pc === chordTones[1]) score += chroma[pc] * 1.9; // 3rd match
        else if (pc === chordTones[2]) score += chroma[pc] * 1.6; // 5th match
        else score -= chroma[pc] * 0.45;
      }

      // Encourage resolution to Tonic on first and last bars
      if ((b === 0 || b === numBars - 1) && cand.degree === 0) {
        score += barEnergy * 0.65;
      }
      // Slight penalty for repeating the exact same chord twice in a row (for musical movement)
      const key = `${cRoot}_${cand.quality}`;
      if (key === prevChordKey && b < numBars - 1) {
        score -= barEnergy * 0.35;
      }

      if (score > bestChordScore) {
        bestChordScore = score;
        bestChord = cand;
      }
    }

    const chosenRoot = (bestRoot + bestChord.degree) % 12;
    prevChordKey = `${chosenRoot}_${bestChord.quality}`;
    chords.push({
      bar: b + 1,
      rootPc: chosenRoot,
      quality: bestChord.quality,
      name: formatChordName(chosenRoot, bestChord.quality),
    });
  }

  return {
    rootPc: bestRoot,
    scaleId: bestScale.id,
    confidence,
    voicedFrames,
    barSec,
    chords,
  };
}

/**
 * Generate a musical default chord progression for a given Key, Scale, and bar count.
 */
export function buildDefaultProgression(rootPc = 2, scaleId = 'hijaz', numBars = 8) {
  const scale = SCALES[scaleId] || SCALES.minor;
  const chords = [];
  for (let b = 0; b < numBars; b++) {
    const idx = scale.defaultProg[b % scale.defaultProg.length];
    const cDef = scale.chords[idx % scale.chords.length];
    const cRoot = (rootPc + cDef.degree) % 12;
    chords.push({
      bar: b + 1,
      rootPc: cRoot,
      quality: cDef.quality,
      name: formatChordName(cRoot, cDef.quality),
    });
  }
  return chords;
}

/**
 * Render a complete studio-quality multi-instrument + rhythm backing AudioBuffer
 * following the composed chord progression.
 */
export async function renderComposedArrangement({
  chords,
  bpm = 100,
  beatsPerBar = 4,
  playStyle = 'ballad',
  rhythmStyle = 'maqsum',
  rhythmVolume = 0.72,
  instruments = {
    piano: { enabled: true, volume: 0.75 },
    guitar: { enabled: false, volume: 0.65 },
    oud: { enabled: true, volume: 0.70 },
    strings: { enabled: true, volume: 0.55 },
    bass: { enabled: true, volume: 0.78 },
    synth: { enabled: false, volume: 0.55 },
  },
}) {
  const sr = 44100;
  const beatSec = 60 / clamp(bpm, 50, 200);
  const barSec = beatSec * beatsPerBar;
  const totalSec = chords.length * barSec + 1.8; // Ring-out tail
  const off = new OfflineAudioContext(2, Math.ceil(sr * totalSec), sr);

  // Master Arrangement Bus + Warm Studio Reverb
  const bus = off.createGain();
  bus.gain.value = 0.78;
  const busComp = off.createDynamicsCompressor();
  busComp.threshold.value = -14;
  busComp.ratio.value = 2.6;
  busComp.attack.value = 0.015;
  busComp.release.value = 0.18;

  const rev = off.createConvolver();
  rev.buffer = createReverbIR(off, 'studio', 1.8);
  const revSend = off.createGain();
  revSend.gain.value = 0.28;

  bus.connect(busComp);
  busComp.connect(off.destination);
  revSend.connect(rev);
  rev.connect(busComp);

  const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

  // =========================================================================
  // Instrument Synthesizers
  // =========================================================================

  // 1. Grand / Electric Piano
  const playPianoNote = (time, midi, dur, vol, panVal = 0) => {
    const f = midiToFreq(midi);
    const osc1 = off.createOscillator();
    const osc2 = off.createOscillator();
    const osc3 = off.createOscillator();
    osc1.type = 'triangle';
    osc2.type = 'sine';
    osc3.type = 'sine';
    osc1.frequency.setValueAtTime(f, time);
    osc2.frequency.setValueAtTime(f * 2, time);
    osc3.frequency.setValueAtTime(f * 3, time);

    const g2 = off.createGain(); g2.gain.value = 0.34;
    const g3 = off.createGain(); g3.gain.value = 0.12;

    const lp = off.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(Math.min(5800, f * 9), time);
    lp.frequency.exponentialRampToValueAtTime(Math.max(420, f * 2.2), time + dur);

    const env = off.createGain();
    env.gain.setValueAtTime(0.0008, time);
    env.gain.linearRampToValueAtTime(vol, time + 0.01);
    env.gain.exponentialRampToValueAtTime(vol * 0.42, time + Math.min(0.35, dur * 0.4));
    env.gain.exponentialRampToValueAtTime(0.0008, time + dur);

    const pan = off.createStereoPanner();
    pan.pan.value = panVal;

    osc1.connect(lp);
    osc2.connect(g2); g2.connect(lp);
    osc3.connect(g3); g3.connect(lp);
    lp.connect(env);
    env.connect(pan);
    pan.connect(bus);
    pan.connect(revSend);

    osc1.start(time); osc2.start(time); osc3.start(time);
    osc1.stop(time + dur + 0.05); osc2.stop(time + dur + 0.05); osc3.stop(time + dur + 0.05);
  };

  // 2. Acoustic Guitar (Bright Plucked Harmonics with strum feel)
  const playGuitarNote = (time, midi, dur, vol, panVal = 0) => {
    const f = midiToFreq(midi);
    const osc1 = off.createOscillator();
    const osc2 = off.createOscillator();
    osc1.type = 'sawtooth';
    osc2.type = 'triangle';
    osc1.frequency.setValueAtTime(f, time);
    osc2.frequency.setValueAtTime(f * 2, time);
    osc2.detune.value = 3;

    const bp = off.createBiquadFilter();
    bp.type = 'lowpass';
    bp.frequency.setValueAtTime(4200, time);
    bp.frequency.exponentialRampToValueAtTime(680, time + Math.min(1.1, dur));
    bp.Q.value = 1.4;

    const env = off.createGain();
    env.gain.setValueAtTime(0.001, time);
    env.gain.linearRampToValueAtTime(vol, time + 0.006);
    env.gain.exponentialRampToValueAtTime(0.001, time + dur);

    const mix2 = off.createGain(); mix2.gain.value = 0.25;
    const pan = off.createStereoPanner(); pan.pan.value = panVal;

    osc1.connect(bp);
    osc2.connect(mix2); mix2.connect(bp);
    bp.connect(env);
    env.connect(pan);
    pan.connect(bus);
    pan.connect(revSend);

    osc1.start(time); osc2.start(time);
    osc1.stop(time + dur + 0.05); osc2.stop(time + dur + 0.05);
  };

  // 3. Oriental Oud (Warm Woody Double-String Resonance)
  const playOudNote = (time, midi, dur, vol, panVal = 0.2) => {
    const f = midiToFreq(midi);
    const oscA = off.createOscillator();
    const oscB = off.createOscillator();
    oscA.type = 'sawtooth';
    oscB.type = 'triangle';
    oscA.frequency.setValueAtTime(f, time);
    oscB.frequency.setValueAtTime(f, time);
    oscB.detune.value = -7; // Characteristic double-course chorus

    // Woody body resonance filter
    const body = off.createBiquadFilter();
    body.type = 'peaking';
    body.frequency.value = 440;
    body.Q.value = 2.0;
    body.gain.value = 5.5;

    const lp = off.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2600, time);
    lp.frequency.exponentialRampToValueAtTime(480, time + dur);

    const env = off.createGain();
    env.gain.setValueAtTime(0.001, time);
    env.gain.linearRampToValueAtTime(vol, time + 0.009);
    env.gain.exponentialRampToValueAtTime(0.001, time + dur);

    const pan = off.createStereoPanner();
    pan.pan.value = panVal;

    oscA.connect(body);
    oscB.connect(body);
    body.connect(lp);
    lp.connect(env);
    env.connect(pan);
    pan.connect(bus);
    pan.connect(revSend);

    oscA.start(time); oscB.start(time);
    oscA.stop(time + dur + 0.05); oscB.stop(time + dur + 0.05);
  };

  // 4. Lush Cinematic Strings Pad
  const playStringsChord = (time, midis, dur, vol) => {
    midis.forEach((m, idx) => {
      [-9, 9].forEach((det) => {
        const osc = off.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(midiToFreq(m + 12), time);
        osc.detune.value = det;

        const lp = off.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 1850;
        lp.Q.value = 0.7;

        const env = off.createGain();
        const voiceVol = vol / (midis.length * 2.4);
        env.gain.setValueAtTime(0.0005, time);
        env.gain.linearRampToValueAtTime(voiceVol, time + Math.min(0.45, dur * 0.25));
        env.gain.setValueAtTime(voiceVol, time + Math.max(0.1, dur - 0.35));
        env.gain.exponentialRampToValueAtTime(0.0005, time + dur + 0.15);

        const pan = off.createStereoPanner();
        pan.pan.value = (idx - (midis.length - 1) / 2) * 0.36 + (det > 0 ? 0.12 : -0.12);

        osc.connect(lp);
        lp.connect(env);
        env.connect(pan);
        pan.connect(bus);
        pan.connect(revSend);

        osc.start(time);
        osc.stop(time + dur + 0.2);
      });
    });
  };

  // 5. Deep Warm Bass
  const playBassNote = (time, midi, dur, vol) => {
    const f = midiToFreq(midi);
    const osc1 = off.createOscillator();
    const osc2 = off.createOscillator();
    osc1.type = 'sine';
    osc2.type = 'triangle';
    osc1.frequency.setValueAtTime(f, time);
    osc2.frequency.setValueAtTime(f, time);

    const lp = off.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 340;

    const env = off.createGain();
    env.gain.setValueAtTime(0.001, time);
    env.gain.linearRampToValueAtTime(vol, time + 0.018);
    env.gain.exponentialRampToValueAtTime(vol * 0.65, time + dur * 0.5);
    env.gain.exponentialRampToValueAtTime(0.001, time + dur);

    const g2 = off.createGain(); g2.gain.value = 0.45;
    osc1.connect(env);
    osc2.connect(lp); lp.connect(g2); g2.connect(env);
    env.connect(bus);

    osc1.start(time); osc2.start(time);
    osc1.stop(time + dur + 0.05); osc2.stop(time + dur + 0.05);
  };

  // 6. Modern Warm Synth Pad / Pluck
  const playSynthChord = (time, midis, dur, vol) => {
    midis.forEach((m, idx) => {
      const osc = off.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(midiToFreq(m), time);
      osc.detune.value = idx % 2 === 0 ? -6 : 6;

      const lp = off.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(2400, time);
      lp.frequency.exponentialRampToValueAtTime(850, time + dur);
      lp.Q.value = 1.8;

      const env = off.createGain();
      const voiceVol = vol / (midis.length * 1.4);
      env.gain.setValueAtTime(0.001, time);
      env.gain.linearRampToValueAtTime(voiceVol, time + 0.04);
      env.gain.exponentialRampToValueAtTime(0.001, time + dur);

      const pan = off.createStereoPanner();
      pan.pan.value = (idx - (midis.length - 1) / 2) * 0.35;

      osc.connect(lp);
      lp.connect(env);
      env.connect(pan);
      pan.connect(bus);
      pan.connect(revSend);

      osc.start(time);
      osc.stop(time + dur + 0.08);
    });
  };

  // =========================================================================
  // Drum & Percussion Synthesizers
  // =========================================================================
  const makeNoiseBuf = (durSec) => {
    const len = Math.max(64, Math.floor(sr * durSec));
    const buf = off.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (len * 0.28));
    }
    return buf;
  };

  const playKick = (time, vol = 0.65, lowHz = 44, dur = 0.28) => {
    const osc = off.createOscillator();
    const g = off.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(145, time);
    osc.frequency.exponentialRampToValueAtTime(lowHz, time + 0.11);
    g.gain.setValueAtTime(vol, time);
    g.gain.exponentialRampToValueAtTime(0.001, time + dur);
    osc.connect(g);
    g.connect(bus);
    osc.start(time);
    osc.stop(time + dur + 0.02);
  };

  const playDoum = (time, vol = 0.62) => {
    // Deep resonant Darbuka Doum
    const osc = off.createOscillator();
    const g = off.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(155, time);
    osc.frequency.exponentialRampToValueAtTime(76, time + 0.16);
    g.gain.setValueAtTime(vol, time);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.28);
    osc.connect(g);
    g.connect(bus);
    g.connect(revSend);
    osc.start(time);
    osc.stop(time + 0.3);
  };

  const playTek = (time, vol = 0.24, freq = 2300, decay = 0.075) => {
    const src = off.createBufferSource();
    src.buffer = makeNoiseBuf(decay);
    const bp = off.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = 2.0;
    const g = off.createGain();
    g.gain.value = vol;
    src.connect(bp); bp.connect(g);
    g.connect(bus); g.connect(revSend);
    src.start(time);
  };

  const playSnare = (time, vol = 0.34) => {
    playTek(time, vol, 1450, 0.14);
    const osc = off.createOscillator();
    const g = off.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(210, time);
    osc.frequency.exponentialRampToValueAtTime(115, time + 0.08);
    g.gain.setValueAtTime(vol * 0.55, time);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.11);
    osc.connect(g); g.connect(bus);
    osc.start(time); osc.stop(time + 0.12);
  };

  const playHat = (time, vol = 0.11, open = false) => {
    playTek(time, vol, 7800, open ? 0.16 : 0.04);
  };

  // =========================================================================
  // Schedule Chords, Instruments & Rhythm Bar by Bar
  // =========================================================================
  const eighth = beatSec / 2;
  const totalEighths = beatsPerBar * 2;

  chords.forEach((chord, barIdx) => {
    const t0 = barIdx * barSec;
    const chordNotes = getChordMidiNotes(chord.rootPc, chord.quality, 48);
    const bassMidi = 36 + (((chord.rootPc % 12) + 12) % 12);
    const bassFixed = bassMidi > 45 ? bassMidi - 12 : bassMidi;

    // --- PIANO ---
    if (instruments.piano?.enabled && instruments.piano.volume > 0.01) {
      const v = instruments.piano.volume * 0.28;
      if (playStyle === 'arpeggio') {
        const arpSeq = [...chordNotes, chordNotes[0] + 12, ...chordNotes.slice().reverse()];
        for (let s = 0; s < totalEighths; s++) {
          const note = arpSeq[s % arpSeq.length];
          playPianoNote(t0 + s * eighth, note, eighth * 2.2, v, (s % 2 === 0 ? -0.25 : 0.25));
        }
      } else if (playStyle === 'groove') {
        for (let b = 0; b < beatsPerBar; b++) {
          const vel = b === 0 ? v : v * 0.72;
          chordNotes.forEach((n, idx) => {
            playPianoNote(t0 + b * beatSec + idx * 0.01, n, beatSec * 0.85, vel / chordNotes.length * 1.8, (idx - 1) * 0.2);
          });
        }
      } else {
        // Ballad or Oriental warm spread chord on beat 1 and gentle re-touch halfway
        chordNotes.forEach((n, idx) => {
          playPianoNote(t0 + idx * 0.022, n, barSec * 0.95, v * 0.85, (idx - 1) * 0.25);
        });
        if (beatsPerBar >= 4) {
          chordNotes.slice(1).forEach((n, idx) => {
            playPianoNote(t0 + beatSec * 2 + idx * 0.018, n + 12, beatSec * 1.9, v * 0.48, (idx % 2 === 0 ? -0.3 : 0.3));
          });
        }
      }
    }

    // --- ACOUSTIC GUITAR ---
    if (instruments.guitar?.enabled && instruments.guitar.volume > 0.01) {
      const v = instruments.guitar.volume * 0.24;
      const gNotes = [chordNotes[0], chordNotes[2], chordNotes[0] + 12, chordNotes[1] + 12];
      if (playStyle === 'arpeggio' || playStyle === 'ballad') {
        for (let s = 0; s < totalEighths; s++) {
          const note = gNotes[s % gNotes.length];
          playGuitarNote(t0 + s * eighth, note, eighth * 2.6, v * (s === 0 ? 1 : 0.78), -0.32);
        }
      } else {
        // Rhythmic strumming pattern
        const strumSlots = beatsPerBar === 3 ? [0, 2, 3, 4] : [0, 2, 3, 5, 6];
        strumSlots.forEach((slot) => {
          if (slot >= totalEighths) return;
          const down = slot % 2 === 0;
          const ordered = down ? gNotes : gNotes.slice().reverse();
          ordered.forEach((n, idx) => {
            playGuitarNote(t0 + slot * eighth + idx * 0.014, n, eighth * 2.1, v * (down ? 0.72 : 0.52), -0.28);
          });
        });
      }
    }

    // --- ORIENTAL OUD ---
    if (instruments.oud?.enabled && instruments.oud.volume > 0.01) {
      const v = instruments.oud.volume * 0.28;
      const oudNotes = [chordNotes[0] + 12, chordNotes[1] + 12, chordNotes[2] + 12, chordNotes[0] + 24];
      const pattern = playStyle === 'oriental'
        ? [0, 1, 2, 3, 2, 1, 2, 0]
        : [0, 2, 1, 2, 3, 2, 1, 0];
      for (let s = 0; s < totalEighths; s++) {
        if (playStyle === 'ballad' && s % 2 === 1 && s !== totalEighths - 1) continue;
        const note = oudNotes[pattern[s % pattern.length] % oudNotes.length];
        playOudNote(t0 + s * eighth, note, eighth * 2.1, v * (s === 0 ? 1.0 : 0.78), 0.34);
      }
    }

    // --- STRINGS PAD ---
    if (instruments.strings?.enabled && instruments.strings.volume > 0.01) {
      playStringsChord(t0, chordNotes, barSec, instruments.strings.volume * 0.32);
    }

    // --- BASS ---
    if (instruments.bass?.enabled && instruments.bass.volume > 0.01) {
      const v = instruments.bass.volume * 0.38;
      if (playStyle === 'groove' || playStyle === 'oriental') {
        playBassNote(t0, bassFixed, beatSec * 1.4, v);
        if (beatsPerBar >= 4) {
          playBassNote(t0 + beatSec * 1.5, bassFixed + 7, beatSec * 0.5, v * 0.72);
          playBassNote(t0 + beatSec * 2, bassFixed, beatSec * 1.5, v * 0.9);
          playBassNote(t0 + beatSec * 3.5, bassFixed + 7, beatSec * 0.45, v * 0.7);
        }
      } else {
        playBassNote(t0, bassFixed, barSec * 0.92, v);
      }
    }

    // --- MODERN SYNTH ---
    if (instruments.synth?.enabled && instruments.synth.volume > 0.01) {
      const v = instruments.synth.volume * 0.25;
      if (playStyle === 'groove') {
        playSynthChord(t0, chordNotes, beatSec * 1.8, v);
        if (beatsPerBar >= 4) playSynthChord(t0 + beatSec * 2, chordNotes, beatSec * 1.8, v * 0.85);
      } else {
        playSynthChord(t0, chordNotes, barSec * 0.95, v);
      }
    }

    // --- RHYTHM / DRUMS ---
    if (rhythmStyle !== 'none' && rhythmVolume > 0.01) {
      const rv = rhythmVolume;
      if (rhythmStyle === 'maqsum') {
        // Classic Maqsum: Doum - Tek - - Tek - Doum - Tek -
        playDoum(t0, 0.72 * rv);
        playTek(t0 + eighth * 1, 0.28 * rv, 2250, 0.07);
        playTek(t0 + eighth * 3, 0.26 * rv, 2400, 0.075);
        if (totalEighths >= 6) playDoum(t0 + eighth * 4, 0.65 * rv);
        if (totalEighths >= 7) playTek(t0 + eighth * 6, 0.30 * rv, 2100, 0.08);
        if (totalEighths >= 8) playTek(t0 + eighth * 7, 0.16 * rv, 5400, 0.04);
      } else if (rhythmStyle === 'saidi') {
        // Saidi: Doum - Tek - - Doum - Doum - Tek -
        playDoum(t0, 0.75 * rv);
        playTek(t0 + eighth * 1, 0.26 * rv, 2200, 0.07);
        playDoum(t0 + eighth * 3, 0.68 * rv);
        if (totalEighths >= 6) playDoum(t0 + eighth * 4, 0.74 * rv);
        if (totalEighths >= 7) playTek(t0 + eighth * 6, 0.30 * rv, 2300, 0.08);
        if (totalEighths >= 8) playTek(t0 + eighth * 7, 0.14 * rv, 5600, 0.04);
      } else if (rhythmStyle === 'pop') {
        playKick(t0, 0.72 * rv);
        if (totalEighths >= 6) playKick(t0 + eighth * 4, 0.66 * rv);
        if (totalEighths >= 4) playSnare(t0 + eighth * 2, 0.36 * rv);
        if (totalEighths >= 8) playSnare(t0 + eighth * 6, 0.36 * rv);
        for (let s = 0; s < totalEighths; s++) {
          playHat(t0 + s * eighth, (s % 2 === 0 ? 0.12 : 0.07) * rv);
        }
      } else if (rhythmStyle === 'lofi') {
        playKick(t0, 0.68 * rv, 48, 0.25);
        if (totalEighths >= 5) playKick(t0 + eighth * 3.5, 0.56 * rv, 48, 0.22);
        if (totalEighths >= 4) playSnare(t0 + eighth * 2, 0.28 * rv);
        if (totalEighths >= 8) playSnare(t0 + eighth * 6, 0.28 * rv);
        for (let s = 0; s < totalEighths; s++) {
          playHat(t0 + s * eighth + (s % 2 === 1 ? 0.015 : 0), 0.075 * rv);
        }
      } else if (rhythmStyle === 'trap') {
        playKick(t0, 0.80 * rv, 36, 0.42);
        if (totalEighths >= 6) playKick(t0 + eighth * 5, 0.70 * rv, 36, 0.35);
        if (totalEighths >= 5) playSnare(t0 + eighth * 4, 0.40 * rv);
        // Fast trap hi-hats (16ths)
        for (let h = 0; h < totalEighths * 2; h++) {
          const accent = h % 4 === 0 ? 0.11 : 0.06;
          playHat(t0 + h * (eighth / 2), accent * rv);
        }
      } else if (rhythmStyle === 'acoustic') {
        playKick(t0, 0.55 * rv, 52, 0.22);
        if (totalEighths >= 6) playKick(t0 + eighth * 4, 0.48 * rv, 52, 0.20);
        for (let s = 0; s < totalEighths; s++) {
          playTek(t0 + s * eighth, (s % 2 === 0 ? 0.11 : 0.06) * rv, 6200, 0.045);
        }
      }
    }
  });

  return await off.startRendering();
}
