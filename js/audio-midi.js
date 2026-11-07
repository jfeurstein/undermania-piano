/**
 * Undermania - Polyphonic Piano Audio Engine & Web MIDI Hardware Controller Manager
 */

class PianoAudioEngine {
  constructor() {
    this.ctx = null;
    this.activeVoices = new Map();
    this.muted = false;
    this.volume = 0.75;
  }

  ensureContext() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === "suspended") {
      this.ctx.resume();
    }
  }

  midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  noteOn(midi, velocity = 95, durationSec = null) {
    if (this.muted) return;
    this.ensureContext();
    this.noteOff(midi);

    const now = this.ctx.currentTime;
    const freq = this.midiToFreq(midi);
    const velGain = Math.max(0.1, Math.min(1, velocity / 127)) * 0.22 * this.volume;

    const masterGain = this.ctx.createGain();
    masterGain.gain.setValueAtTime(0.0001, now);
    masterGain.gain.exponentialRampToValueAtTime(velGain, now + 0.012);
    masterGain.gain.exponentialRampToValueAtTime(velGain * 0.45, now + 0.25);
    masterGain.gain.exponentialRampToValueAtTime(0.0001, now + 2.6);

    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(Math.min(9000, freq * 6.5), now);
    filter.frequency.exponentialRampToValueAtTime(Math.max(600, freq * 2.2), now + 1.4);

    // Rich piano-like harmonic partials
    const osc1 = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    const g2 = this.ctx.createGain();

    osc1.type = "triangle";
    osc1.frequency.setValueAtTime(freq, now);

    osc2.type = "sine";
    osc2.frequency.setValueAtTime(freq * 2, now);
    g2.gain.setValueAtTime(0.35, now);

    osc1.connect(filter);
    osc2.connect(g2);
    g2.connect(filter);
    filter.connect(masterGain);
    masterGain.connect(this.ctx.destination);

    osc1.start(now);
    osc2.start(now);

    const voice = { osc1, osc2, masterGain, timer: null };
    this.activeVoices.set(midi, voice);

    const autoStop = durationSec ? Math.min(2.4, Math.max(0.15, durationSec)) : 2.4;
    voice.timer = setTimeout(() => {
      this.noteOff(midi);
    }, autoStop * 1000);
  }

  noteOff(midi) {
    const voice = this.activeVoices.get(midi);
    if (!voice || !this.ctx) return;
    if (voice.timer) clearTimeout(voice.timer);
    const now = this.ctx.currentTime;
    try {
      voice.masterGain.gain.cancelScheduledValues(now);
      voice.masterGain.gain.setValueAtTime(Math.max(0.0001, voice.masterGain.gain.value), now);
      voice.masterGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
      voice.osc1.stop(now + 0.1);
      voice.osc2.stop(now + 0.1);
    } catch (_) {}
    this.activeVoices.delete(midi);
  }
}

class MidiHardwareManager {
  constructor({ onNoteOn, onNoteOff, onDevicesChanged }) {
    this.midiAccess = null;
    this.selectedInputId = "all";
    this.onNoteOn = onNoteOn;
    this.onNoteOff = onNoteOff;
    this.onDevicesChanged = onDevicesChanged;
    this.inputs = [];
  }

  async init() {
    if (!navigator.requestMIDIAccess) {
      this.onDevicesChanged([], false, "Web MIDI API no soportada en este navegador (usa teclado/ratón)");
      return false;
    }
    try {
      this.midiAccess = await navigator.requestMIDIAccess({ sysex: false });
      this.midiAccess.onstatechange = () => this.refreshInputs();
      this.refreshInputs();
      return true;
    } catch (err) {
      this.onDevicesChanged([], false, "Permiso MIDI denegado o sin controlador conectado");
      return false;
    }
  }

  refreshInputs() {
    if (!this.midiAccess) return;
    this.inputs = [];
    for (const input of this.midiAccess.inputs.values()) {
      this.inputs.push({
        id: input.id,
        name: input.name || `Teclado MIDI (${input.id})`,
        manufacturer: input.manufacturer || "",
      });
      input.onmidimessage = (event) => {
        if (this.selectedInputId !== "all" && input.id !== this.selectedInputId) return;
        this.handleMidiMessage(event);
      };
    }
    const connected = this.inputs.length > 0;
    const label = connected
      ? `${this.inputs.length} teclado(s) MIDI detectado(s)`
      : "Esperando conexión USB/MIDI...";
    this.onDevicesChanged(this.inputs, connected, label);
  }

  setInputDevice(id) {
    this.selectedInputId = id;
  }

  handleMidiMessage(event) {
    const [status, data1, data2] = event.data;
    const command = status & 0xf0;
    if (command === 0x90 && data2 > 0) {
      this.onNoteOn(data1, data2, "midi");
    } else if (command === 0x80 || (command === 0x90 && data2 === 0)) {
      this.onNoteOff(data1, "midi");
    }
  }
}

window.UndermaniaAudioMidi = {
  PianoAudioEngine,
  MidiHardwareManager,
};
