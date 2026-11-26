/**
 * Nagham Studio — Real Scale/Maqam-Aware Auto-Tune Engine (WSOLA Pitch Correction)
 * + First-Peak Parabolic Pitch Detection & Key/Maqam Scale Definitions
 */

export const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
export const NOTE_NAMES_AR = [
  'دو (C)', 'دو# (C#)', 'ري (D)', 'مي♭ (Eb)', 'مي (E)', 'فا (F)',
  'فا# (F#)', 'صول (G)', 'لا♭ (Ab)', 'لا (A)', 'سي♭ (Bb)', 'سي (B)',
];

export const SCALES = {
  minor: {
    id: 'minor',
    name: 'نهاوند / Minor',
    intervals: [0, 2, 3, 5, 7, 8, 10],
    chords: [
      { degree: 0, quality: 'min', label: 'i' },
      { degree: 3, quality: 'maj', label: 'III' },
      { degree: 5, quality: 'min', label: 'iv' },
      { degree: 7, quality: 'min', label: 'v' },
      { degree: 7, quality: 'maj', label: 'V' },
      { degree: 8, quality: 'maj', label: 'VI' },
      { degree: 10, quality: 'maj', label: 'VII' },
    ],
    defaultProg: [0, 5, 2, 6],
  },
  major: {
    id: 'major',
    name: 'عجم / Major',
    intervals: [0, 2, 4, 5, 7, 9, 11],
    chords: [
      { degree: 0, quality: 'maj', label: 'I' },
      { degree: 2, quality: 'min', label: 'ii' },
      { degree: 4, quality: 'min', label: 'iii' },
      { degree: 5, quality: 'maj', label: 'IV' },
      { degree: 7, quality: 'maj', label: 'V' },
      { degree: 9, quality: 'min', label: 'vi' },
    ],
    defaultProg: [0, 4, 5, 3],
  },
  hijaz: {
    id: 'hijaz',
    name: 'حجاز شرقي (Hijaz)',
    intervals: [0, 1, 4, 5, 7, 8, 10],
    chords: [
      { degree: 0, quality: 'maj', label: 'I (حجاز)' },
      { degree: 1, quality: 'maj', label: 'bII' },
      { degree: 5, quality: 'min', label: 'iv' },
      { degree: 7, quality: 'dim', label: 'v°' },
      { degree: 8, quality: 'maj', label: 'bVI' },
      { degree: 10, quality: 'min', label: 'bvii' },
    ],
    defaultProg: [0, 1, 2, 0],
  },
  kurd: {
    id: 'kurd',
    name: 'كرد (Kurd / Phrygian)',
    intervals: [0, 1, 3, 5, 7, 8, 10],
    chords: [
      { degree: 0, quality: 'min', label: 'i (كرد)' },
      { degree: 1, quality: 'maj', label: 'bII' },
      { degree: 3, quality: 'maj', label: 'bIII' },
      { degree: 5, quality: 'min', label: 'iv' },
      { degree: 8, quality: 'maj', label: 'bVI' },
      { degree: 10, quality: 'min', label: 'bvii' },
    ],
    defaultProg: [0, 1, 2, 1],
  },
  bayati: {
    id: 'bayati',
    name: 'بياتي / دوري (Bayati Feel)',
    intervals: [0, 2, 3, 5, 7, 9, 10],
    chords: [
      { degree: 0, quality: 'min', label: 'i' },
      { degree: 3, quality: 'maj', label: 'bIII' },
      { degree: 5, quality: 'maj', label: 'IV' },
      { degree: 7, quality: 'min', label: 'v' },
      { degree: 10, quality: 'maj', label: 'bVII' },
    ],
    defaultProg: [0, 4, 2, 0],
  },
};

export const AUTOTUNE_SCALES = {
  chromatic: { id: 'chromatic', name: 'كروماتيك (كل النغمات الـ 12)', intervals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  minor:     { id: 'minor',     name: 'نهاوند (Minor)',              intervals: SCALES.minor.intervals },
  major:     { id: 'major',     name: 'عجم (Major)',                 intervals: SCALES.major.intervals },
  hijaz:     { id: 'hijaz',     name: 'حجاز شرقي (Hijaz)',           intervals: SCALES.hijaz.intervals },
  kurd:      { id: 'kurd',      name: 'كرد (Kurd)',                  intervals: SCALES.kurd.intervals },
  bayati:    { id: 'bayati',    name: 'بياتي / دوري (Bayati)',       intervals: SCALES.bayati.intervals },
};

function clampVal(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

/**
 * Detect fundamental frequency (Hz) in a frame of mono audio using normalized
 * autocorrelation with first-peak selection (YIN/McLeod rule) & parabolic refinement.
 */
export function detectFramePitchHz(samples, sampleRate) {
  const n = samples.length;
  let rms = 0;
  for (let i = 0; i < n; i++) rms += samples[i] * samples[i];
  rms = Math.sqrt(rms / n);
  if (rms < 0.012) return null;

  // Vocal fundamental range: ~80 Hz (E2) to ~900 Hz (A5)
  const minLag = Math.max(16, Math.floor(sampleRate / 900));
  const maxLag = Math.min(Math.floor(n / 2), Math.floor(sampleRate / 80));

  const corrs = new Float32Array(maxLag + 1);
  let bestCorr = 0;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let num = 0;
    let denA = 0;
    let denB = 0;
    const limit = n - lag;
    for (let i = 0; i < limit; i += 2) {
      const a = samples[i];
      const b = samples[i + lag];
      num += a * b;
      denA += a * a;
      denB += b * b;
    }
    const denom = Math.sqrt(denA * denB);
    const corr = denom > 1e-8 ? num / denom : 0;
    corrs[lag] = corr;
    if (corr > bestCorr) bestCorr = corr;
  }

  if (bestCorr < 0.54) return null;

  // Pick the FIRST local maximum >= 88% of bestCorr to prevent subharmonic/octave-drop errors
  const threshold = bestCorr * 0.88;
  let bestLag = -1;
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (corrs[lag] >= threshold && corrs[lag] >= corrs[lag - 1] && corrs[lag] >= corrs[lag + 1]) {
      bestLag = lag;
      break;
    }
  }
  if (bestLag <= 0) {
    for (let lag = minLag; lag <= maxLag; lag++) {
      if (corrs[lag] === bestCorr) { bestLag = lag; break; }
    }
  }

  // Parabolic interpolation for sub-sample frequency precision
  if (bestLag > minLag && bestLag < maxLag) {
    const y0 = corrs[bestLag - 1];
    const y1 = corrs[bestLag];
    const y2 = corrs[bestLag + 1];
    const denom = 2 * (y0 - 2 * y1 + y2);
    if (Math.abs(denom) > 1e-6) {
      bestLag += (y0 - y2) / denom;
    }
  }

  return bestLag > 0 ? sampleRate / bestLag : null;
}

/**
 * Find the nearest allowed MIDI note in a given (rootPc, scaleIntervals) to a continuous MIDI float.
 */
export function snapMidiToScale(continuousMidi, rootPc, scaleIntervals) {
  const baseOct = Math.floor(continuousMidi / 12) * 12;
  let bestNote = Math.round(continuousMidi);
  let bestDist = Infinity;

  for (let octShift = -12; octShift <= 12; octShift += 12) {
    for (let i = 0; i < scaleIntervals.length; i++) {
      const candidate = baseOct + octShift + ((rootPc + scaleIntervals[i]) % 12);
      const dist = Math.abs(candidate - continuousMidi);
      if (dist < bestDist) {
        bestDist = dist;
        bestNote = candidate;
      }
    }
  }
  return bestNote;
}

/**
 * Auto-detect best (rootPc, scaleId) from a vocal Float32Array.
 */
export function detectKeyAndScaleFromSamples(samples, sampleRate, preferredScaleId = 'auto', preferredRoot = -1) {
  const chroma = new Float32Array(12);
  const frameSize = 2048;
  const hop = 2048;
  let voiced = 0;

  for (let pos = 0; pos + frameSize < samples.length; pos += hop) {
    const hz = detectFramePitchHz(samples.subarray(pos, pos + frameSize), sampleRate);
    if (!hz) continue;
    const midi = 69 + 12 * Math.log2(hz / 440);
    const pc = ((Math.round(midi) % 12) + 12) % 12;
    chroma[pc] += 1;
    voiced++;
  }

  if (voiced < 3) {
    return {
      rootPc: preferredRoot >= 0 ? preferredRoot : 0,
      scaleId: preferredScaleId !== 'auto' && AUTOTUNE_SCALES[preferredScaleId] ? preferredScaleId : 'chromatic',
    };
  }

  if (preferredScaleId === 'chromatic') {
    return { rootPc: preferredRoot >= 0 ? preferredRoot : 0, scaleId: 'chromatic' };
  }

  const candScales = preferredScaleId !== 'auto' && SCALES[preferredScaleId]
    ? [SCALES[preferredScaleId]]
    : Object.values(SCALES);
  const candRoots = preferredRoot >= 0 ? [preferredRoot] : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

  let bestRoot = 0;
  let bestScale = candScales[0];
  let bestScore = -Infinity;

  for (const sc of candScales) {
    for (const root of candRoots) {
      const allowed = new Set(sc.intervals.map((iv) => (root + iv) % 12));
      let score = 0;
      for (let pc = 0; pc < 12; pc++) {
        if (allowed.has(pc)) {
          const rel = (pc - root + 12) % 12;
          score += chroma[pc] * (rel === 0 ? 1.3 : rel === 7 ? 1.15 : 1.0);
        } else {
          score -= chroma[pc] * 1.4;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestRoot = root;
        bestScale = sc;
      }
    }
  }

  return { rootPc: bestRoot, scaleId: bestScale.id };
}

/**
 * Apply real Scale/Maqam-Aware Auto-Tune to a vocal AudioBuffer using
 * per-grain pitch detection + smooth retune speed + phase-coherent WSOLA synthesis.
 *
 * Returns { buffer, stats: { rootPc, scaleId, avgCentsCorrected, voicedFrames, contour } }
 */
export function applyAutoTuneToBuffer(ctx, srcBuffer, {
  key = -1,              // -1 = Auto-detect, 0..11 = C..B
  scale = 'auto',        // 'auto' | 'chromatic' | 'minor' | 'major' | 'hijaz' | 'kurd' | 'bayati'
  retuneSpeed = 65,      // 0 (slow natural) to 100 (instant hard-tune)
  strength = 85,         // 0 to 100% correction amount
} = {}) {
  if (!srcBuffer) return null;

  const sr = srcBuffer.sampleRate;
  const len = srcBuffer.length;
  const input = srcBuffer.getChannelData(0);

  // Resolve key & scale
  let usedRootPc = key;
  let usedScaleId = scale;
  if (usedRootPc < 0 || usedScaleId === 'auto') {
    const det = detectKeyAndScaleFromSamples(input, sr, usedScaleId, usedRootPc);
    if (usedRootPc < 0) usedRootPc = det.rootPc;
    if (usedScaleId === 'auto') usedScaleId = det.scaleId;
  }
  const scaleObj = AUTOTUNE_SCALES[usedScaleId] || AUTOTUNE_SCALES.chromatic;
  const intervals = scaleObj.intervals;

  const strengthFactor = clampVal(strength, 0, 100) / 100;
  // Exponential retune smoothing alpha: speed 100 -> 0.98 (instant snap), speed 50 -> 0.42, speed 10 -> 0.14
  const speedNorm = clampVal(retuneSpeed, 0, 100) / 100;
  const smoothAlpha = 0.08 + Math.pow(speedNorm, 1.55) * 0.90;

  const out = ctx.createBuffer(srcBuffer.numberOfChannels, len, sr);
  const outL = out.getChannelData(0);
  const outR = out.numberOfChannels > 1 ? out.getChannelData(1) : null;

  const grainSize = 2048;
  const hop = 1024; // 2x Hann overlap = exact 1.0 unity gain
  const win = new Float32Array(grainSize);
  for (let i = 0; i < grainSize; i++) {
    win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (grainSize - 1)));
  }

  const readSample = (pos) => {
    const i0 = Math.floor(pos);
    if (i0 < 0 || i0 + 1 >= len) return 0;
    const frac = pos - i0;
    return input[i0] * (1 - frac) + input[i0 + 1] * frac;
  };

  const searchRadius = Math.min(260, Math.floor(sr / 150));
  const matchLen = 256;

  let smoothShiftSemis = 0;
  let totalAbsCents = 0;
  let voicedFrames = 0;
  const contour = [];

  for (let outStart = 0; outStart < len; outStart += hop) {
    const endFrame = Math.min(len, outStart + grainSize);
    const frame = input.subarray(outStart, endFrame);

    let pitchFactor = 1.0;

    if (frame.length >= 1024) {
      const hz = detectFramePitchHz(frame, sr);
      if (hz) {
        const rawMidi = 69 + 12 * Math.log2(hz / 440);
        const snappedMidi = snapMidiToScale(rawMidi, usedRootPc, intervals);
        let errSemis = snappedMidi - rawMidi;

        // Guard against wild jumps (> 2.5 semitones usually means transient/breath)
        if (Math.abs(errSemis) <= 2.5) {
          const desiredShift = errSemis * strengthFactor;
          smoothShiftSemis += smoothAlpha * (desiredShift - smoothShiftSemis);
          pitchFactor = Math.pow(2, smoothShiftSemis / 12);

          totalAbsCents += Math.abs(smoothShiftSemis * 100);
          voicedFrames++;
          contour.push({
            t: outStart / sr,
            rawMidi,
            tunedMidi: rawMidi + smoothShiftSemis,
          });
        } else {
          smoothShiftSemis *= 0.6;
        }
      } else {
        // Unvoiced consonant/silence -> relax shift smoothly to 0 so consonants stay crisp
        smoothShiftSemis *= 0.45;
      }
    }

    // WSOLA phase alignment when pitch correction is active
    let bestOffset = 0;
    const isShifting = Math.abs(pitchFactor - 1.0) > 0.0025;

    if (outStart > 0 && isShifting) {
      let bestScore = -Infinity;
      const maxSearch = Math.min(searchRadius, Math.floor(len - outStart - grainSize * pitchFactor));
      const minSearch = Math.max(-searchRadius, -outStart);

      for (let d = minSearch; d <= maxSearch; d += 4) {
        let corr = 0;
        for (let m = 0; m < matchLen; m += 4) {
          const dstIdx = outStart + m;
          if (dstIdx >= len) break;
          corr += outL[dstIdx] * readSample(outStart + d + m * pitchFactor);
        }
        if (corr > bestScore) {
          bestScore = corr;
          bestOffset = d;
        }
      }
      const refineStart = Math.max(minSearch, bestOffset - 3);
      const refineEnd = Math.min(maxSearch, bestOffset + 3);
      for (let d = refineStart; d <= refineEnd; d++) {
        let corr = 0;
        for (let m = 0; m < matchLen; m += 2) {
          const dstIdx = outStart + m;
          if (dstIdx >= len) break;
          corr += outL[dstIdx] * readSample(outStart + d + m * pitchFactor);
        }
        if (corr > bestScore) {
          bestScore = corr;
          bestOffset = d;
        }
      }
    }

    const baseSrc = outStart + bestOffset;
    for (let i = 0; i < grainSize; i++) {
      const dstIdx = outStart + i;
      if (dstIdx >= len) break;
      const s = isShifting
        ? readSample(baseSrc + i * pitchFactor) * win[i]
        : input[dstIdx] * win[i];
      outL[dstIdx] += s;
      if (outR) outR[dstIdx] += s;
    }
  }

  return {
    buffer: out,
    stats: {
      rootPc: usedRootPc,
      scaleId: usedScaleId,
      avgCentsCorrected: voicedFrames > 0 ? totalAbsCents / voicedFrames : 0,
      voicedFrames,
      contour,
    },
  };
}
