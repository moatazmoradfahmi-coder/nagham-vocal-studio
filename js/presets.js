/**
 * Nagham Studio — Vocal FX Presets, Mastering Presets, Metronome & Default DSP Parameters
 */

export const DEFAULT_MIX_STATE = {
  metronome: {
    enabled: false,       // Live metronome ON / MUTE toggle
    bpm: 100,             // 50 - 180 BPM
    beatsPerBar: 4,       // 4 (4/4), 3 (3/4), 6 (6/8)
    volume: 0.65,         // 0.0 - 1.0
  },
  backing: {
    volume: -2.0,     // dB (-60 to +6)
    pan: 0,           // -1 to 1
    muted: false,
    solo: false,
    offsetSec: 0,     // Start offset in seconds
  },
  vocal: {
    volume: 1.5,      // dB (-60 to +6)
    pan: 0,           // -1 to 1
    muted: false,
    solo: false,
    fxEnabled: true,
    syncOffsetMs: 0,  // Latency compensation (-250 to +250 ms)
    duckingDb: 2.0,   // Auto-ducking of backing track during singing (0 to 6 dB)
  },
  vocalFx: {
    // Per-module switches
    eqEnabled: true,
    compEnabled: true,
    reverbEnabled: true,
    delayEnabled: true,

    // High-Pass & Noise Gate
    hpfFreq: 85,          // Hz (20 - 300)
    gateThreshold: -52,   // dB (-80 = off, -60 to -20)

    // 4-Band Vocal EQ
    eqLow: -1.5,          // 100 Hz Low Shelf (-12 to +12 dB)
    eqWarmth: 1.0,        // 380 Hz Peaking (-12 to +12 dB)
    eqPresence: 2.5,      // 3200 Hz Peaking (-12 to +12 dB)
    eqAir: 3.0,           // 10000 Hz High Shelf (-12 to +12 dB)

    // De-Esser & Warmth
    deEsser: 25,          // 0 - 100% (attenuation around 6.8 kHz)
    warmth: 18,           // 0 - 100% (analog tube saturation)

    // Compressor
    compThreshold: -20,   // dB (-45 to 0)
    compRatio: 4.0,       // 1 to 16
    compAttack: 10,       // ms (1 to 80)
    compRelease: 160,     // ms (30 to 600)
    compMakeup: 3.0,      // dB (0 to 15)

    // Stereo Doubler / Chorus
    doublerMix: 14,       // 0 - 100%

    // Convolution Reverb
    reverbType: 'studio', // 'room' | 'studio' | 'hall' | 'cathedral' | 'plate'
    reverbMix: 20,        // 0 - 100%
    reverbDecay: 1.6,     // seconds (0.4 to 5.0)
    reverbPreDelay: 22,   // ms (0 to 120)

    // Stereo Delay / Echo
    delayMix: 10,         // 0 - 100%
    delayTimeMs: 320,     // ms (60 to 800)
    delayFeedback: 28,    // 0 - 75%
    delayToneHz: 3200,    // Low-pass filter on echoes (800 - 10000 Hz)

    // Creative FX: Vocal Harmony / Pitch Shift Layer
    harmonyEnabled: false,
    harmonyInterval: 7,   // Semitones: -12, -5, +3, +4, +7, +12
    harmonyMix: 28,       // 0 - 100%

    // Creative FX: Flanger / Phaser Modulation
    modEnabled: false,
    modType: 'flanger',   // 'flanger' | 'phaser'
    modRate: 0.6,         // Hz (0.1 - 5.0)
    modDepth: 45,         // 0 - 100%
    modMix: 30,           // 0 - 100%

    // Creative FX: Telephone / Radio / Megaphone Lo-Fi Filter
    lofiEnabled: false,
    lofiStyle: 'radio',   // 'telephone' | 'radio' | 'megaphone'
    lofiMix: 75,          // 0 - 100%

    // Creative FX: Vocal Drive / Overdrive Grit
    driveEnabled: false,
    driveAmount: 25,      // 0 - 100%
  },
  master: {
    enabled: true,
    eqLow: 0.8,           // 80 Hz (-6 to +6 dB)
    eqMid: 0.0,           // 1200 Hz (-6 to +6 dB)
    eqHigh: 1.0,          // 11000 Hz (-6 to +6 dB)
    stereoWidth: 108,     // % (0 = mono, 100 = normal, 150 = wide)
    glueAmount: 35,       // 0 - 100% (Master bus compression)
    limiterDrive: 2.5,    // dB (0 to 12 dB)
    limiterCeiling: -0.3, // dBFS (-3.0 to -0.1)
    masterVolume: 0.0,    // dB (-24 to +6)
  },
};

const CREATIVE_OFF = {
  eqEnabled: true,
  compEnabled: true,
  reverbEnabled: true,
  delayEnabled: true,
  harmonyEnabled: false,
  harmonyInterval: 7,
  harmonyMix: 25,
  modEnabled: false,
  modType: 'flanger',
  modRate: 0.6,
  modDepth: 40,
  modMix: 25,
  lofiEnabled: false,
  lofiStyle: 'radio',
  lofiMix: 75,
  driveEnabled: false,
  driveAmount: 20,
};

export const VOCAL_PRESETS = [
  {
    id: 'clean_studio',
    name: 'استوديو نظيف',
    subtitle: 'Clean Studio',
    description: 'وضوح احترافي، توازن دقيق، ولمسة صدى طبيعية',
    fx: {
      ...CREATIVE_OFF,
      hpfFreq: 85,
      gateThreshold: -52,
      eqLow: -1.5,
      eqWarmth: 1.0,
      eqPresence: 2.5,
      eqAir: 3.0,
      deEsser: 25,
      warmth: 18,
      compThreshold: -20,
      compRatio: 4.0,
      compAttack: 10,
      compRelease: 160,
      compMakeup: 3.0,
      doublerMix: 12,
      reverbType: 'studio',
      reverbMix: 18,
      reverbDecay: 1.5,
      reverbPreDelay: 22,
      delayMix: 8,
      delayTimeMs: 310,
      delayFeedback: 24,
      delayToneHz: 3200,
    },
  },
  {
    id: 'oriental_tarab',
    name: 'طرب شرقي',
    subtitle: 'Oriental Tarab',
    description: 'دفء عميق مع صدى قاعة فخم وديلاي ناعم للعُرَب',
    fx: {
      ...CREATIVE_OFF,
      hpfFreq: 75,
      gateThreshold: -55,
      eqLow: 0.5,
      eqWarmth: 2.5,
      eqPresence: 2.0,
      eqAir: 2.5,
      deEsser: 30,
      warmth: 32,
      compThreshold: -18,
      compRatio: 3.2,
      compAttack: 15,
      compRelease: 220,
      compMakeup: 2.5,
      doublerMix: 18,
      reverbType: 'hall',
      reverbMix: 34,
      reverbDecay: 2.9,
      reverbPreDelay: 35,
      delayMix: 22,
      delayTimeMs: 390,
      delayFeedback: 36,
      delayToneHz: 2400,
    },
  },
  {
    id: 'rap_punch',
    name: 'راب وهيب هوب',
    subtitle: 'Punchy Rap',
    description: 'حضور قوي ومباشر مع ضغط حاد ولمسة أوفر درايف خفيفة',
    fx: {
      ...CREATIVE_OFF,
      hpfFreq: 105,
      gateThreshold: -46,
      eqLow: -2.5,
      eqWarmth: 0.5,
      eqPresence: 4.5,
      eqAir: 3.5,
      deEsser: 40,
      warmth: 28,
      compThreshold: -24,
      compRatio: 6.0,
      compAttack: 4,
      compRelease: 95,
      compMakeup: 5.5,
      doublerMix: 8,
      reverbType: 'room',
      reverbMix: 9,
      reverbDecay: 0.7,
      reverbPreDelay: 10,
      delayMix: 14,
      delayTimeMs: 250,
      delayFeedback: 22,
      delayToneHz: 2600,
      driveEnabled: true,
      driveAmount: 18,
    },
  },
  {
    id: 'modern_pop',
    name: 'بوب عصري',
    subtitle: 'Modern Pop',
    description: 'لمعان عالي في الترددات العليا وتوسيع ستيريو جذاب',
    fx: {
      ...CREATIVE_OFF,
      hpfFreq: 95,
      gateThreshold: -50,
      eqLow: -2.0,
      eqWarmth: -0.5,
      eqPresence: 3.2,
      eqAir: 5.0,
      deEsser: 45,
      warmth: 22,
      compThreshold: -22,
      compRatio: 4.8,
      compAttack: 8,
      compRelease: 130,
      compMakeup: 4.2,
      doublerMix: 30,
      reverbType: 'plate',
      reverbMix: 24,
      reverbDecay: 1.9,
      reverbPreDelay: 28,
      delayMix: 18,
      delayTimeMs: 300,
      delayFeedback: 32,
      delayToneHz: 4200,
    },
  },
  {
    id: 'harmony_choir',
    name: 'هارموني وكورال',
    subtitle: 'Harmony Choir',
    description: 'صوت غناء ممتلئ مع طبقة هارموني متناغمة وصدى قاعة واسع',
    fx: {
      ...CREATIVE_OFF,
      hpfFreq: 85,
      gateThreshold: -52,
      eqLow: -1.0,
      eqWarmth: 1.2,
      eqPresence: 2.8,
      eqAir: 3.8,
      deEsser: 35,
      warmth: 24,
      compThreshold: -21,
      compRatio: 4.2,
      compAttack: 10,
      compRelease: 170,
      compMakeup: 3.5,
      doublerMix: 28,
      reverbType: 'hall',
      reverbMix: 30,
      reverbDecay: 2.5,
      reverbPreDelay: 30,
      delayMix: 12,
      delayTimeMs: 340,
      delayFeedback: 26,
      delayToneHz: 3400,
      harmonyEnabled: true,
      harmonyInterval: 7,
      harmonyMix: 34,
      modEnabled: true,
      modType: 'phaser',
      modRate: 0.35,
      modDepth: 28,
      modMix: 16,
    },
  },
  {
    id: 'vintage_lofi',
    name: 'راديو / لو-فاي',
    subtitle: 'Vintage Radio',
    description: 'تأثير راديو وتليفون كلاسيكي دافئ مع صدى خفيف',
    fx: {
      ...CREATIVE_OFF,
      hpfFreq: 160,
      gateThreshold: -50,
      eqLow: -4.0,
      eqWarmth: 2.0,
      eqPresence: 3.0,
      eqAir: -3.5,
      deEsser: 20,
      warmth: 45,
      compThreshold: -24,
      compRatio: 5.5,
      compAttack: 5,
      compRelease: 110,
      compMakeup: 4.5,
      doublerMix: 6,
      reverbType: 'room',
      reverbMix: 16,
      reverbDecay: 1.0,
      reverbPreDelay: 12,
      delayMix: 18,
      delayTimeMs: 280,
      delayFeedback: 30,
      delayToneHz: 1800,
      lofiEnabled: true,
      lofiStyle: 'radio',
      lofiMix: 85,
      driveEnabled: true,
      driveAmount: 24,
    },
  },
  {
    id: 'broadcast_radio',
    name: 'إذاعي / بودكاست',
    subtitle: 'Warm Broadcast',
    description: 'صوت قريب ودافئ ومضغوط بوضوح فائق بدون صدى',
    fx: {
      ...CREATIVE_OFF,
      reverbEnabled: false,
      delayEnabled: false,
      hpfFreq: 70,
      gateThreshold: -44,
      eqLow: 2.5,
      eqWarmth: 2.0,
      eqPresence: 2.2,
      eqAir: 1.5,
      deEsser: 35,
      warmth: 25,
      compThreshold: -23,
      compRatio: 5.0,
      compAttack: 6,
      compRelease: 120,
      compMakeup: 4.5,
      doublerMix: 0,
      reverbType: 'room',
      reverbMix: 0,
      reverbDecay: 0.5,
      reverbPreDelay: 0,
      delayMix: 0,
      delayTimeMs: 250,
      delayFeedback: 0,
      delayToneHz: 3000,
    },
  },
  {
    id: 'flat_raw',
    name: 'خام (بدون فلاتر)',
    subtitle: 'Flat / Raw',
    description: 'الصوت الأصلي المسجل بدون أي تعديل أو مؤثرات',
    fx: {
      ...CREATIVE_OFF,
      eqEnabled: false,
      compEnabled: false,
      reverbEnabled: false,
      delayEnabled: false,
      hpfFreq: 20,
      gateThreshold: -80,
      eqLow: 0,
      eqWarmth: 0,
      eqPresence: 0,
      eqAir: 0,
      deEsser: 0,
      warmth: 0,
      compThreshold: 0,
      compRatio: 1.0,
      compAttack: 10,
      compRelease: 150,
      compMakeup: 0,
      doublerMix: 0,
      reverbType: 'studio',
      reverbMix: 0,
      reverbDecay: 1.2,
      reverbPreDelay: 15,
      delayMix: 0,
      delayTimeMs: 300,
      delayFeedback: 0,
      delayToneHz: 3200,
    },
  },
];

export const MASTER_PRESETS = [
  {
    id: 'balanced_commercial',
    name: 'تجاري متوازن',
    master: {
      enabled: true,
      eqLow: 0.8,
      eqMid: 0.0,
      eqHigh: 1.0,
      stereoWidth: 108,
      glueAmount: 35,
      limiterDrive: 2.5,
      limiterCeiling: -0.3,
    },
  },
  {
    id: 'warm_analog',
    name: 'دافئ وممتلئ',
    master: {
      enabled: true,
      eqLow: 2.0,
      eqMid: 0.5,
      eqHigh: 0.4,
      stereoWidth: 104,
      glueAmount: 48,
      limiterDrive: 3.0,
      limiterCeiling: -0.5,
    },
  },
  {
    id: 'bright_loud',
    name: 'قوي وساطع',
    master: {
      enabled: true,
      eqLow: 1.2,
      eqMid: -0.4,
      eqHigh: 2.2,
      stereoWidth: 120,
      glueAmount: 55,
      limiterDrive: 5.0,
      limiterCeiling: -0.2,
    },
  },
  {
    id: 'natural_gentle',
    name: 'طبيعي وهادئ',
    master: {
      enabled: true,
      eqLow: 0.2,
      eqMid: 0.0,
      eqHigh: 0.3,
      stereoWidth: 100,
      glueAmount: 18,
      limiterDrive: 1.0,
      limiterCeiling: -1.0,
    },
  },
];

export const DEMO_BEATS = [
  {
    id: 'oriental_groove',
    name: 'إيقاع شرقي معاصر',
    bpm: 96,
    durationSec: 20,
    key: 'حجاز (D Hijaz)',
  },
  {
    id: 'lofi_chill',
    name: 'لو-فاي هادئ (Lo-Fi)',
    bpm: 82,
    durationSec: 20,
    key: 'A Minor',
  },
  {
    id: 'pop_ballad',
    name: 'بوب رومانسي (Pop)',
    bpm: 108,
    durationSec: 20,
    key: 'C Minor',
  },
];
