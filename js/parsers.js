/**
 * Undermania - Native MIDI (.mid) & MuseScore (.mscz / .mscx) Parsers
 * Plus Solfège (Do Re Mi Fa Sol La Si) and Fingering (1-5) Analysis Engine
 */

const SOLFEGE_SHARP = ["Do", "Do#", "Re", "Re#", "Mi", "Fa", "Fa#", "Sol", "Sol#", "La", "La#", "Si"];
const SOLFEGE_FLAT  = ["Do", "Reb", "Re", "Mib", "Mi", "Fa", "Solb", "Sol", "Lab", "La", "Sib", "Si"];

function getSolfegeLabel(midiPitch, mode = "sharp") {
  const pc = ((midiPitch % 12) + 12) % 12;
  return mode === "flat" ? SOLFEGE_FLAT[pc] : SOLFEGE_SHARP[pc];
}

function enrichNote(midiPitch, startSec, durationSec, hand, velocity = 90, measure = 1, finger = null) {
  const pc = ((midiPitch % 12) + 12) % 12;
  const octave = Math.floor(midiPitch / 12) - 1;
  return {
    midi: midiPitch,
    startTime: Number(startSec.toFixed(4)),
    duration: Number(Math.max(0.08, durationSec).toFixed(4)),
    hand: hand || (midiPitch >= 60 ? "right" : "left"),
    velocity: velocity || 90,
    measure: measure || 1,
    solfegeSharp: SOLFEGE_SHARP[pc],
    solfegeFlat: SOLFEGE_FLAT[pc],
    octave,
    isAccidental: [1, 3, 6, 8, 10].includes(pc),
    finger: finger,
    status: "pending", // "pending" | "hit" | "missed"
  };
}

function assignErgonomicFingering(notes) {
  for (const hand of ["right", "left"]) {
    const handNotes = notes.filter((n) => n.hand === hand);
    handNotes.sort((a, b) => a.startTime - b.startTime || a.midi - b.midi);
    let prevMidi = null;
    let prevFinger = 3;

    for (const n of handNotes) {
      if (n.finger >= 1 && n.finger <= 5) {
        prevMidi = n.midi;
        prevFinger = n.finger;
        continue;
      }
      let finger = 3;
      if (prevMidi !== null) {
        const diff = n.midi - prevMidi;
        if (diff === 0) {
          finger = prevFinger;
        } else if (hand === "right") {
          const step = diff > 0 ? 1 : -1;
          if (Math.abs(diff) >= 5) {
            finger = diff > 0 ? 5 : 1;
          } else {
            finger = prevFinger + step;
            if (finger > 5) finger = 1;
            if (finger < 1) finger = 5;
          }
        } else {
          const step = diff > 0 ? -1 : 1;
          if (Math.abs(diff) >= 5) {
            finger = diff > 0 ? 1 : 5;
          } else {
            finger = prevFinger + step;
            if (finger > 5) finger = 1;
            if (finger < 1) finger = 5;
          }
        }
      }
      n.finger = Math.max(1, Math.min(5, finger));
      prevMidi = n.midi;
      prevFinger = n.finger;
    }
  }
  return notes;
}

/**
 * Client-side Standard MIDI File (.mid / .midi) parser
 */
function parseMidiArrayBuffer(buffer, filename = "Pieza.mid") {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== "MThd") {
    throw new Error("Archivo MIDI inválido: no se encontró la cabecera MThd.");
  }

  const hdrLen = view.getUint32(4, false);
  const numTracks = view.getUint16(10, false);
  const division = view.getUint16(12, false);
  const ticksPerBeat = (division & 0x8000) === 0 ? division : 480;

  let offset = 8 + hdrLen;
  let tempoMpqn = 500000; // 120 BPM
  let timeSigNum = 4;
  let timeSigDen = 4;
  const rawNotes = [];

  for (let t = 0; t < numTracks; t++) {
    if (offset + 8 > bytes.length) break;
    const chunkId = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    const chunkLen = view.getUint32(offset + 4, false);
    const trackEnd = Math.min(bytes.length, offset + 8 + chunkLen);
    let pos = offset + 8;
    offset = trackEnd;

    if (chunkId !== "MTrk") continue;

    let absTick = 0;
    let runningStatus = 0;
    const active = new Map();

    while (pos < trackEnd) {
      let delta = 0;
      while (pos < trackEnd) {
        const b = bytes[pos++];
        delta = (delta << 7) | (b & 0x7f);
        if ((b & 0x80) === 0) break;
      }
      absTick += delta;
      if (pos >= trackEnd) break;

      let status = bytes[pos];
      if (status < 0x80) {
        status = runningStatus;
      } else {
        pos++;
        if (status < 0xf0) runningStatus = status;
      }

      const msgType = status & 0xf0;
      const channel = status & 0x0f;

      if (msgType === 0x90 || msgType === 0x80) {
        const pitch = bytes[pos++];
        const vel = bytes[pos++];
        const key = `${channel}:${pitch}`;
        if (msgType === 0x90 && vel > 0) {
          active.set(key, { tick: absTick, vel });
        } else if (active.has(key)) {
          const st = active.get(key);
          active.delete(key);
          rawNotes.push({
            startTick: st.tick,
            durTick: Math.max(1, absTick - st.tick),
            pitch,
            vel: st.vel,
            track: t,
            channel,
          });
        }
      } else if (msgType === 0xa0 || msgType === 0xb0 || msgType === 0xe0) {
        pos += 2;
      } else if (msgType === 0xc0 || msgType === 0xd0) {
        pos += 1;
      } else if (status === 0xff) {
        const metaType = bytes[pos++];
        let metaLen = 0;
        while (pos < trackEnd) {
          const b = bytes[pos++];
          metaLen = (metaLen << 7) | (b & 0x7f);
          if ((b & 0x80) === 0) break;
        }
        if (metaType === 0x51 && metaLen === 3) {
          tempoMpqn = (bytes[pos] << 16) | (bytes[pos + 1] << 8) | bytes[pos + 2];
        } else if (metaType === 0x58 && metaLen >= 2) {
          timeSigNum = bytes[pos];
          timeSigDen = Math.pow(2, bytes[pos + 1]);
        }
        pos += metaLen;
      } else if (status === 0xf0 || status === 0xf7) {
        let sysexLen = 0;
        while (pos < trackEnd) {
          const b = bytes[pos++];
          sysexLen = (sysexLen << 7) | (b & 0x7f);
          if ((b & 0x80) === 0) break;
        }
        pos += sysexLen;
      }
    }
  }

  const bpm = tempoMpqn > 0 ? Math.round(60000000 / tempoMpqn) : 120;
  const secPerTick = tempoMpqn / 1000000 / ticksPerBeat;
  const beatsPerMeasure = timeSigNum * (4 / timeSigDen);
  const distinctTracks = [...new Set(rawNotes.map((r) => r.track))].sort((a, b) => a - b);

  const notes = rawNotes.map((r) => {
    const startSec = r.startTick * secPerTick;
    const durSec = Math.max(0.08, r.durTick * secPerTick);
    const beatPos = r.startTick / ticksPerBeat;
    const measure = Math.floor(beatPos / beatsPerMeasure) + 1;
    let hand = "right";
    if (distinctTracks.length >= 2) {
      hand = r.track === distinctTracks[0] ? "right" : "left";
    } else if (r.channel > 0) {
      hand = r.channel === 1 ? "left" : "right";
    } else {
      hand = r.pitch >= 60 ? "right" : "left";
    }
    return enrichNote(r.pitch, startSec, durSec, hand, r.vel, measure);
  });

  notes.sort((a, b) => a.startTime - b.startTime || a.midi - b.midi);
  assignErgonomicFingering(notes);
  const duration = notes.reduce((acc, n) => Math.max(acc, n.startTime + n.duration), 8);

  return {
    title: filename.replace(/\.(mid|midi)$/i, "").replace(/[_-]/g, " "),
    composer: "Archivo MIDI Estándar",
    format: "MIDI (.mid)",
    bpm,
    timeSignature: `${timeSigNum}/${timeSigDen}`,
    beatsPerMeasure,
    duration: Number(duration.toFixed(2)),
    notes,
  };
}

/**
 * Parse MuseScore XML (.mscx) string in browser
 */
function parseMscxString(xmlText, filename = "Partitura.mscz") {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "application/xml");

  let title = filename.replace(/\.(mscz|mscx)$/i, "").replace(/[_-]/g, " ");
  let composer = "Partitura MuseScore (.mscz)";

  doc.querySelectorAll("metaTag").forEach((tag) => {
    const name = tag.getAttribute("name");
    if (name === "workTitle" && tag.textContent.trim()) title = tag.textContent.trim();
    if (name === "composer" && tag.textContent.trim()) composer = tag.textContent.trim();
  });

  let bpm = 108;
  const tempoNode = doc.querySelector("Tempo > tempo");
  if (tempoNode && tempoNode.textContent) {
    const val = parseFloat(tempoNode.textContent);
    if (!isNaN(val) && val > 0) bpm = Math.round(val * 60);
  }

  let sigN = 4;
  let sigD = 4;
  const nNode = doc.querySelector("TimeSig > sigN");
  const dNode = doc.querySelector("TimeSig > sigD");
  if (nNode && nNode.textContent) sigN = parseInt(nNode.textContent, 10) || 4;
  if (dNode && dNode.textContent) sigD = parseInt(dNode.textContent, 10) || 4;

  const beatsPerMeasure = sigN * (4 / sigD);
  const durMap = {
    whole: 4.0,
    half: 2.0,
    quarter: 1.0,
    eighth: 0.5,
    "16th": 0.25,
    "32nd": 0.125,
    measure: beatsPerMeasure,
  };

  const secPerBeat = 60 / Math.max(20, bpm);
  const notes = [];
  const allStaves = Array.from(doc.querySelectorAll("Staff")).filter(
    (s) => s.querySelectorAll(":scope > Measure").length > 0
  );

  allStaves.forEach((staff, sIdx) => {
    const staffId = staff.getAttribute("id") || String(sIdx + 1);
    const defaultHand = staffId === "1" ? "right" : "left";
    let curBeat = 0;

    const measures = Array.from(staff.querySelectorAll(":scope > Measure"));
    measures.forEach((measure, mIdx) => {
      const mNum = mIdx + 1;
      const voices = Array.from(measure.querySelectorAll(":scope > voice"));
      const containers = voices.length > 0 ? voices : [measure];
      const measureStart = curBeat;
      let maxBeat = curBeat;

      containers.forEach((container) => {
        let vBeat = measureStart;
        Array.from(container.children).forEach((child) => {
          if (child.tagName === "Chord" || child.tagName === "Rest") {
            const dtNode = child.querySelector("durationType");
            const dt = dtNode ? dtNode.textContent.trim() : "quarter";
            let beats = durMap[dt] ?? 1.0;
            const dotsNode = child.querySelector("dots");
            if (dotsNode && dotsNode.textContent) {
              const dots = parseInt(dotsNode.textContent, 10);
              if (dots === 1) beats *= 1.5;
              if (dots === 2) beats *= 1.75;
            }

            if (child.tagName === "Chord") {
              child.querySelectorAll("Note").forEach((noteEl) => {
                const pitchEl = noteEl.querySelector("pitch");
                if (pitchEl && pitchEl.textContent) {
                  const midiPitch = parseInt(pitchEl.textContent, 10);
                  let finger = null;
                  const fEl = noteEl.querySelector("Fingering > text");
                  if (fEl && /^[1-5]$/.test(fEl.textContent.trim())) {
                    finger = parseInt(fEl.textContent.trim(), 10);
                  }
                  const hand = allStaves.length > 1 ? defaultHand : midiPitch >= 60 ? "right" : "left";
                  notes.push(
                    enrichNote(
                      midiPitch,
                      vBeat * secPerBeat,
                      beats * secPerBeat,
                      hand,
                      90,
                      mNum,
                      finger
                    )
                  );
                }
              });
            }
            vBeat += beats;
          }
        });
        if (vBeat > maxBeat) maxBeat = vBeat;
      });
      curBeat = maxBeat;
    });
  });

  notes.sort((a, b) => a.startTime - b.startTime || a.midi - b.midi);
  assignErgonomicFingering(notes);
  const duration = notes.reduce((acc, n) => Math.max(acc, n.startTime + n.duration), 8);

  return {
    title,
    composer,
    format: "MuseScore (.mscz)",
    bpm,
    timeSignature: `${sigN}/${sigD}`,
    beatsPerMeasure,
    duration: Number(duration.toFixed(2)),
    notes,
  };
}

/**
 * Extract .mscx from a .mscz ZIP archive in browser using DecompressionStream
 */
async function parseMsczArrayBuffer(buffer, filename = "Partitura.mscz") {
  // First try backend endpoint if available
  try {
    const resp = await fetch("/api/parse", {
      method: "POST",
      headers: { "X-Filename": filename },
      body: buffer,
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data.ok && data.song) {
        data.song.notes.forEach((n) => (n.status = "pending"));
        return data.song;
      }
    }
  } catch (_) {
    // Fallback to client-side ZIP extraction below
  }

  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let offset = 0;

  while (offset + 30 < bytes.length) {
    const sig = view.getUint32(offset, true);
    if (sig !== 0x04034b50) break; // Local file header signature
    const compression = view.getUint16(offset + 8, true);
    const compSize = view.getUint32(offset + 18, true);
    const nameLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);
    const entryName = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLen));
    const dataStart = offset + 30 + nameLen + extraLen;
    const compData = bytes.subarray(dataStart, dataStart + compSize);

    if (entryName.toLowerCase().endsWith(".mscx")) {
      let xmlText = "";
      if (compression === 0) {
        xmlText = new TextDecoder().decode(compData);
      } else if (compression === 8 && typeof DecompressionStream !== "undefined") {
        const ds = new DecompressionStream("deflate-raw");
        const writer = ds.writable.getWriter();
        writer.write(compData);
        writer.close();
        const decompressed = await new Response(ds.readable).arrayBuffer();
        xmlText = new TextDecoder().decode(decompressed);
      }
      if (xmlText) {
        return parseMscxString(xmlText, filename);
      }
    }
    offset = dataStart + compSize;
  }

  throw new Error("No se pudo descomprimir el archivo .mscz.");
}

/**
 * Built-in Conservatory Pieces for immediate practice
 */
function getBuiltInRepertoire() {
  // 1. Beethoven - Himno a la Alegría (Ode to Joy)
  const beat1 = 60 / 108;
  const odeNotesRaw = [
    // Right Hand
    [0, 1, 64, "right", 1, 3], [1, 1, 64, "right", 1, 3], [2, 1, 65, "right", 1, 4], [3, 1, 67, "right", 1, 5],
    [4, 1, 67, "right", 2, 5], [5, 1, 65, "right", 2, 4], [6, 1, 64, "right", 2, 3], [7, 1, 62, "right", 2, 2],
    [8, 1, 60, "right", 3, 1], [9, 1, 60, "right", 3, 1], [10, 1, 62, "right", 3, 2], [11, 1, 64, "right", 3, 3],
    [12, 1.5, 64, "right", 4, 3], [13.5, 0.5, 62, "right", 4, 2], [14, 2, 62, "right", 4, 2],
    [16, 1, 64, "right", 5, 3], [17, 1, 64, "right", 5, 3], [18, 1, 65, "right", 5, 4], [19, 1, 67, "right", 5, 5],
    [20, 1, 67, "right", 6, 5], [21, 1, 65, "right", 6, 4], [22, 1, 64, "right", 6, 3], [23, 1, 62, "right", 6, 2],
    [24, 1, 60, "right", 7, 1], [25, 1, 60, "right", 7, 1], [26, 1, 62, "right", 7, 2], [27, 1, 64, "right", 7, 3],
    [28, 1.5, 62, "right", 8, 2], [29.5, 0.5, 60, "right", 8, 1], [30, 2, 60, "right", 8, 1],
    // Left Hand
    [0, 2, 48, "left", 1, 5], [2, 2, 55, "left", 1, 1],
    [4, 2, 55, "left", 2, 1], [6, 2, 43, "left", 2, 5],
    [8, 2, 48, "left", 3, 5], [10, 2, 52, "left", 3, 3],
    [12, 2, 55, "left", 4, 1], [14, 2, 43, "left", 4, 5],
    [16, 2, 48, "left", 5, 5], [18, 2, 55, "left", 5, 1],
    [20, 2, 55, "left", 6, 1], [22, 2, 43, "left", 6, 5],
    [24, 2, 48, "left", 7, 5], [26, 2, 52, "left", 7, 3],
    [28, 2, 43, "left", 8, 5], [30, 2, 48, "left", 8, 5],
  ];
  const odeNotes = odeNotesRaw.map(([b, d, m, h, meas, f]) =>
    enrichNote(m, b * beat1, d * beat1, h, 92, meas, f)
  );
  odeNotes.sort((a, b) => a.startTime - b.startTime || a.midi - b.midi);

  // 2. Bach - Minuet in G Major (con Sostenidos Fa#)
  const beat2 = 60 / 100;
  const bachNotesRaw = [
    // Right Hand (includes Fa# = 66, 78)
    [0, 1, 74, "right", 1, 5], [1, 0.5, 67, "right", 1, 1], [1.5, 0.5, 69, "right", 1, 2], [2, 0.5, 71, "right", 1, 3], [2.5, 0.5, 72, "right", 1, 4],
    [3, 1, 74, "right", 2, 5], [4, 1, 67, "right", 2, 1], [5, 1, 67, "right", 2, 1],
    [6, 1, 76, "right", 3, 3], [7, 0.5, 72, "right", 3, 1], [7.5, 0.5, 74, "right", 3, 2], [8, 0.5, 76, "right", 3, 3], [8.5, 0.5, 78, "right", 3, 4],
    [9, 1, 79, "right", 4, 5], [10, 1, 67, "right", 4, 1], [11, 1, 67, "right", 4, 1],
    // Left Hand
    [0, 2, 55, "left", 1, 3], [2, 1, 57, "left", 1, 2],
    [3, 1.5, 59, "left", 2, 1], [4.5, 1.5, 55, "left", 2, 3],
    [6, 2, 60, "left", 3, 1], [8, 1, 59, "left", 3, 2],
    [9, 1.5, 57, "left", 4, 3], [10.5, 1.5, 55, "left", 4, 4],
  ];
  const bachNotes = bachNotesRaw.map(([b, d, m, h, meas, f]) =>
    enrichNote(m, b * beat2, d * beat2, h, 90, meas, f)
  );
  bachNotes.sort((a, b) => a.startTime - b.startTime || a.midi - b.midi);

  // 3. Estudio Cromático & Arpegios Universitarios (con Bemoles y Sostenidos)
  const beat3 = 60 / 96;
  const studyRaw = [
    [0, 1, 60, "right", 1, 1], [1, 1, 63, "right", 1, 2], [2, 1, 66, "right", 1, 3], [3, 1, 68, "right", 1, 4],
    [4, 1, 70, "right", 2, 5], [5, 1, 68, "right", 2, 4], [6, 1, 66, "right", 2, 3], [7, 1, 63, "right", 2, 2],
    [8, 2, 61, "right", 3, 2], [10, 2, 65, "right", 3, 4],
    [12, 4, 60, "right", 4, 1],
    [0, 2, 48, "left", 1, 5], [2, 2, 51, "left", 1, 3],
    [4, 2, 54, "left", 2, 2], [6, 2, 56, "left", 2, 1],
    [8, 2, 49, "left", 3, 4], [10, 2, 44, "left", 3, 5],
    [12, 4, 48, "left", 4, 5],
  ];
  const studyNotes = studyRaw.map(([b, d, m, h, meas, f]) =>
    enrichNote(m, b * beat3, d * beat3, h, 90, meas, f)
  );
  studyNotes.sort((a, b) => a.startTime - b.startTime || a.midi - b.midi);

  return [
    {
      id: "ode_to_joy",
      title: "Himno a la Alegría (Op. 125)",
      composer: "Ludwig van Beethoven",
      format: "MIDI (.mid)",
      bpm: 108,
      timeSignature: "4/4",
      beatsPerMeasure: 4,
      duration: Number((32 * beat1).toFixed(2)),
      notes: odeNotes,
    },
    {
      id: "bach_minuet",
      title: "Minuet en Sol Mayor (BWV Anh. 114)",
      composer: "Johann Sebastian Bach",
      format: "MuseScore (.mscz)",
      bpm: 100,
      timeSignature: "3/4",
      beatsPerMeasure: 3,
      duration: Number((12 * beat2).toFixed(2)),
      notes: bachNotes,
    },
    {
      id: "chromatic_etude",
      title: "Estudio de Alteraciones (# / b) Op. Univ.",
      composer: "Conservatorio Undermania",
      format: "Partitura (.mscz)",
      bpm: 96,
      timeSignature: "4/4",
      beatsPerMeasure: 4,
      duration: Number((16 * beat3).toFixed(2)),
      notes: studyNotes,
    },
  ];
}

window.UndermaniaParsers = {
  getSolfegeLabel,
  parseMidiArrayBuffer,
  parseMsczArrayBuffer,
  parseMscxString,
  getBuiltInRepertoire,
};
