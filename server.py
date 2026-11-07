#!/usr/bin/env python3
"""
Undermania - Conservatory Piano & MIDI/MSCZ Studio Server
Serves the Undermania application and provides native binary .mid and .mscz parsing endpoints.
"""

import http.server
import io
import json
import os
import socketserver
import struct
import sys
import xml.etree.ElementTree as ET
import zipfile

PORT = int(os.environ.get("PORT", 8080))
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

SOLFEGE_SHARP = ["Do", "Do#", "Re", "Re#", "Mi", "Fa", "Fa#", "Sol", "Sol#", "La", "La#", "Si"]
SOLFEGE_FLAT = ["Do", "Reb", "Re", "Mib", "Mi", "Fa", "Solb", "Sol", "Lab", "La", "Sib", "Si"]


def assign_fingering(notes: list) -> list:
    """Assign ergonomic piano fingering (1 to 5) per hand based on melodic contour."""
    for hand in ("right", "left"):
        hand_notes = [n for n in notes if n["hand"] == hand]
        hand_notes.sort(key=lambda x: (x["startTime"], x["midi"]))
        prev_midi = None
        prev_finger = 3
        for n in hand_notes:
            if n.get("finger") in (1, 2, 3, 4, 5):
                prev_midi = n["midi"]
                prev_finger = n["finger"]
                continue
            if prev_midi is None:
                finger = 3 if hand == "right" else 3
            else:
                diff = n["midi"] - prev_midi
                if diff == 0:
                    finger = prev_finger
                elif hand == "right":
                    step = 1 if diff > 0 else -1
                    if abs(diff) >= 5:
                        finger = 5 if diff > 0 else 1
                    else:
                        finger = prev_finger + step
                        if finger > 5:
                            finger = 1
                        elif finger < 1:
                            finger = 5
                else:
                    step = -1 if diff > 0 else 1
                    if abs(diff) >= 5:
                        finger = 1 if diff > 0 else 5
                    else:
                        finger = prev_finger + step
                        if finger > 5:
                            finger = 1
                        elif finger < 1:
                            finger = 5
            n["finger"] = max(1, min(5, finger))
            prev_midi = n["midi"]
            prev_finger = n["finger"]
    return notes


def enrich_note(midi_pitch: int, start_sec: float, duration_sec: float, hand: str, velocity: int = 90, measure: int = 1, finger: int = None) -> dict:
    pc = midi_pitch % 12
    octave = (midi_pitch // 12) - 1
    return {
        "midi": midi_pitch,
        "startTime": round(start_sec, 4),
        "duration": round(max(0.08, duration_sec), 4),
        "hand": hand,
        "velocity": velocity,
        "measure": measure,
        "solfegeSharp": SOLFEGE_SHARP[pc],
        "solfegeFlat": SOLFEGE_FLAT[pc],
        "octave": octave,
        "isAccidental": pc in (1, 3, 6, 8, 10),
        "AccidentalType": "sharp" if pc in (1, 6, 8) else ("flat" if pc in (3, 10) else "natural"),
        "finger": finger,
    }


def parse_midi_bytes(data: bytes, filename: str = "song.mid") -> dict:
    """Parse a Standard MIDI File (.mid / .midi) into Undermania song JSON."""
    if data[:4] != b"MThd":
        raise ValueError("Archivo MIDI inválido: falta cabecera MThd")

    hdr_len, fmt, num_tracks, division = struct.unpack(">IHHH", data[4:14])
    ticks_per_beat = division if (division & 0x8000) == 0 else 480
    offset = 8 + hdr_len

    tempo_mpqn = 500_000  # default 120 BPM
    time_sig_num = 4
    time_sig_den = 4
    raw_notes = []
    track_names = []

    for track_idx in range(num_tracks):
        if offset + 8 > len(data):
            break
        chunk_type = data[offset:offset + 4]
        chunk_len = struct.unpack(">I", data[offset + 4:offset + 8])[0]
        track_data = data[offset + 8:offset + 8 + chunk_len]
        offset += 8 + chunk_len

        if chunk_type != b"MTrk":
            continue

        pos = 0
        abs_tick = 0
        running_status = 0
        active = {}

        while pos < len(track_data):
            delta = 0
            while pos < len(track_data):
                b = track_data[pos]
                pos += 1
                delta = (delta << 7) | (b & 0x7F)
                if not (b & 0x80):
                    break
            abs_tick += delta
            if pos >= len(track_data):
                break

            status = track_data[pos]
            if status < 0x80:
                status = running_status
            else:
                pos += 1
                if status < 0xF0:
                    running_status = status

            msg_type = status & 0xF0
            channel = status & 0x0F

            if msg_type == 0x90 or msg_type == 0x80:
                pitch = track_data[pos]
                vel = track_data[pos + 1]
                pos += 2
                key = (channel, pitch)
                if msg_type == 0x90 and vel > 0:
                    active[key] = (abs_tick, vel)
                else:
                    if key in active:
                        st_tick, st_vel = active.pop(key)
                        raw_notes.append((st_tick, abs_tick - st_tick, pitch, st_vel, track_idx, channel))
            elif msg_type in (0xA0, 0xB0, 0xE0):
                pos += 2
            elif msg_type in (0xC0, 0xD0):
                pos += 1
            elif status == 0xFF:
                meta_type = track_data[pos]
                pos += 1
                meta_len = 0
                while pos < len(track_data):
                    b = track_data[pos]
                    pos += 1
                    meta_len = (meta_len << 7) | (b & 0x7F)
                    if not (b & 0x80):
                        break
                meta_bytes = track_data[pos:pos + meta_len]
                pos += meta_len
                if meta_type == 0x51 and len(meta_bytes) == 3:
                    tempo_mpqn = (meta_bytes[0] << 16) | (meta_bytes[1] << 8) | meta_bytes[2]
                elif meta_type == 0x58 and len(meta_bytes) >= 2:
                    time_sig_num = meta_bytes[0]
                    time_sig_den = 2 ** meta_bytes[1]
                elif meta_type == 0x03:
                    try:
                        track_names.append(meta_bytes.decode("utf-8", errors="ignore").strip())
                    except Exception:
                        pass
            elif status in (0xF0, 0xF7):
                sysex_len = 0
                while pos < len(track_data):
                    b = track_data[pos]
                    pos += 1
                    sysex_len = (sysex_len << 7) | (b & 0x7F)
                    if not (b & 0x80):
                        break
                pos += sysex_len

    bpm = round(60_000_000 / tempo_mpqn) if tempo_mpqn > 0 else 120
    sec_per_tick = (tempo_mpqn / 1_000_000.0) / ticks_per_beat
    beats_per_measure = time_sig_num * (4.0 / time_sig_den)

    distinct_tracks = sorted(list({n[4] for n in raw_notes}))
    notes_out = []
    for st_tick, dur_tick, pitch, vel, t_idx, ch in raw_notes:
        start_sec = st_tick * sec_per_tick
        dur_sec = max(0.08, dur_tick * sec_per_tick)
        beat_pos = st_tick / float(ticks_per_beat)
        measure = int(beat_pos // beats_per_measure) + 1
        if len(distinct_tracks) >= 2:
            hand = "right" if t_idx == distinct_tracks[0] else "left"
        elif ch > 0:
            hand = "left" if ch == 1 else "right"
        else:
            hand = "right" if pitch >= 60 else "left"
        notes_out.append(enrich_note(pitch, start_sec, dur_sec, hand, vel, measure))

    notes_out.sort(key=lambda x: (x["startTime"], x["midi"]))
    assign_fingering(notes_out)
    total_duration = max((n["startTime"] + n["duration"] for n in notes_out), default=8.0)

    return {
        "title": os.path.splitext(os.path.basename(filename))[0].replace("_", " ").title(),
        "composer": "Archivo MIDI Importado",
        "format": "MIDI (.mid)",
        "bpm": bpm,
        "timeSignature": f"{time_sig_num}/{time_sig_den}",
        "beatsPerMeasure": beats_per_measure,
        "duration": round(total_duration, 2),
        "notes": notes_out,
    }


def parse_mscx_xml(xml_text: str, filename: str = "score.mscz") -> dict:
    """Parse MuseScore XML (.mscx) into Undermania song JSON."""
    root = ET.fromstring(xml_text)
    title = os.path.splitext(os.path.basename(filename))[0].replace("_", " ").title()
    composer = "Partitura MuseScore"

    for meta in root.findall(".//metaTag"):
        name = meta.attrib.get("name", "")
        if name == "workTitle" and meta.text:
            title = meta.text.strip()
        elif name == "composer" and meta.text:
            composer = meta.text.strip()

    bpm = 108
    tempo_el = root.find(".//Tempo/tempo")
    if tempo_el is not None and tempo_el.text:
        try:
            bpm = int(round(float(tempo_el.text) * 60))
        except ValueError:
            pass

    sig_n = 4
    sig_d = 4
    ts_n = root.find(".//TimeSig/sigN")
    ts_d = root.find(".//TimeSig/sigD")
    if ts_n is not None and ts_n.text:
        sig_n = int(ts_n.text)
    if ts_d is not None and ts_d.text:
        sig_d = int(ts_d.text)

    dur_map = {
        "whole": 4.0,
        "half": 2.0,
        "quarter": 1.0,
        "eighth": 0.5,
        "16th": 0.25,
        "32nd": 0.125,
        "measure": float(sig_n) * (4.0 / sig_d),
    }

    sec_per_beat = 60.0 / max(20, bpm)
    notes_out = []

    staves = [s for s in root.findall(".//Score/Staff") if s.find("Measure") is not None]
    if not staves:
        staves = [s for s in root.findall(".//Staff") if s.find("Measure") is not None]

    for s_idx, staff in enumerate(staves):
        staff_id = staff.attrib.get("id", str(s_idx + 1))
        default_hand = "right" if staff_id == "1" else "left"
        cur_beat = 0.0

        for m_idx, measure in enumerate(staff.findall("Measure")):
            m_num = m_idx + 1
            voices = measure.findall("voice")
            containers = voices if voices else [measure]
            measure_start_beat = cur_beat
            max_voice_beat = cur_beat

            for v_idx, container in enumerate(containers):
                v_beat = measure_start_beat
                for child in container:
                    tag = child.tag
                    if tag in ("Chord", "Rest"):
                        dtype_el = child.find("durationType")
                        dtype = dtype_el.text.strip() if (dtype_el is not None and dtype_el.text) else "quarter"
                        beats = dur_map.get(dtype, 1.0)
                        dots_el = child.find("dots")
                        if dots_el is not None and dots_el.text:
                            try:
                                d_count = int(dots_el.text)
                                if d_count == 1:
                                    beats *= 1.5
                                elif d_count == 2:
                                    beats *= 1.75
                            except ValueError:
                                pass

                        if tag == "Chord":
                            for note_el in child.findall("Note"):
                                pitch_el = note_el.find("pitch")
                                if pitch_el is not None and pitch_el.text:
                                    midi_pitch = int(pitch_el.text)
                                    finger_el = note_el.find(".//Fingering/text")
                                    finger = None
                                    if finger_el is not None and finger_el.text and finger_el.text.strip().isdigit():
                                        f_val = int(finger_el.text.strip())
                                        if 1 <= f_val <= 5:
                                            finger = f_val
                                    hand = default_hand if len(staves) > 1 else ("right" if midi_pitch >= 60 else "left")
                                    notes_out.append(
                                        enrich_note(
                                            midi_pitch,
                                            v_beat * sec_per_beat,
                                            beats * sec_per_beat,
                                            hand,
                                            90,
                                            m_num,
                                            finger,
                                        )
                                    )
                        v_beat += beats
                if v_beat > max_voice_beat:
                    max_voice_beat = v_beat
            cur_beat = max_voice_beat

    notes_out.sort(key=lambda x: (x["startTime"], x["midi"]))
    assign_fingering(notes_out)
    total_duration = max((n["startTime"] + n["duration"] for n in notes_out), default=8.0)

    return {
        "title": title,
        "composer": composer,
        "format": "MuseScore (.mscz)",
        "bpm": bpm,
        "timeSignature": f"{sig_n}/{sig_d}",
        "beatsPerMeasure": sig_n * (4.0 / sig_d),
        "duration": round(total_duration, 2),
        "notes": notes_out,
    }


def parse_mscz_bytes(data: bytes, filename: str = "score.mscz") -> dict:
    """Extract .mscx from a compressed .mscz archive and parse it."""
    with zipfile.ZipFile(io.BytesIO(data), "r") as zf:
        mscx_names = [n for n in zf.namelist() if n.lower().endswith(".mscx")]
        if not mscx_names:
            raise ValueError("El archivo .mscz no contiene un archivo .mscx interno.")
        xml_bytes = zf.read(mscx_names[0])
        return parse_mscx_xml(xml_bytes.decode("utf-8", errors="replace"), filename)


class UndermaniaRequestHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def do_GET(self):
        if self.path == "/api/samples":
            samples_dir = os.path.join(BASE_DIR, "samples")
            files = []
            if os.path.isdir(samples_dir):
                for fname in sorted(os.listdir(samples_dir)):
                    if fname.endswith((".mid", ".midi", ".mscz", ".mscx")):
                        files.append({"name": fname, "url": f"/samples/{fname}"})
            self.send_json(200, {"samples": files})
            return
        super().do_GET()

    def do_POST(self):
        if self.path.startswith("/api/parse"):
            length = int(self.headers.get("Content-Length", "0"))
            filename = self.headers.get("X-Filename", "uploaded.mid")
            raw_data = self.rfile.read(length)
            try:
                lower = filename.lower()
                if lower.endswith(".mscz"):
                    song = parse_mscz_bytes(raw_data, filename)
                elif lower.endswith(".mscx"):
                    song = parse_mscx_xml(raw_data.decode("utf-8", errors="replace"), filename)
                else:
                    song = parse_midi_bytes(raw_data, filename)
                self.send_json(200, {"ok": True, "song": song})
            except Exception as exc:
                self.send_json(400, {"ok": False, "error": str(exc)})
            return
        self.send_json(404, {"ok": False, "error": "Ruta no encontrada"})

    def send_json(self, status: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", PORT), UndermaniaRequestHandler) as httpd:
        print(f"Undermania Conservatory Studio ejecutándose en http://127.0.0.1:{PORT}")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServidor detenido.")


if __name__ == "__main__":
    main()
