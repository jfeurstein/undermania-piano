#!/usr/bin/env python3
"""Generate sample .mid and .mscz files for Undermania."""

import os
import struct
import zipfile

SAMPLES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "samples")


def encode_vlq(value: int) -> bytes:
    """Encode an integer as a MIDI Variable Length Quantity."""
    result = [value & 0x7F]
    value >>= 7
    while value > 0:
        result.append((value & 0x7F) | 0x80)
        value >>= 7
    result.reverse()
    return bytes(result)


def create_midi_file(filepath: str, tempo_bpm: int, right_hand_notes: list, left_hand_notes: list, ticks_per_beat: int = 480):
    """
    Create a Format 1 Standard MIDI File (.mid) with separate tracks for Right and Left hands.
    Each note in right_hand_notes / left_hand_notes is (start_beat, duration_beats, midi_pitch, velocity).
    """
    def build_track(notes, channel: int, track_name: str, include_tempo: bool = False) -> bytes:
        events = []
        # Track name meta event
        name_bytes = track_name.encode("utf-8")
        events.append((0, b"\xFF\x03" + encode_vlq(len(name_bytes)) + name_bytes))

        if include_tempo:
            mpqn = int(60_000_000 / tempo_bpm)
            tempo_bytes = struct.pack(">I", mpqn)[1:]
            events.append((0, b"\xFF\x51\x03" + tempo_bytes))
            # Time signature 4/4
            events.append((0, b"\xFF\x58\x04\x04\x02\x18\x08"))

        # Program change: Acoustic Grand Piano (0)
        events.append((0, bytes([0xC0 | channel, 0])))

        for start_beat, dur_beat, pitch, vel in notes:
            start_tick = int(round(start_beat * ticks_per_beat))
            end_tick = int(round((start_beat + dur_beat) * ticks_per_beat))
            events.append((start_tick, bytes([0x90 | channel, pitch, vel])))
            events.append((end_tick, bytes([0x80 | channel, pitch, 0])))

        events.sort(key=lambda e: (e[0], 0 if (e[1][0] & 0xF0) == 0x80 else 1))

        track_data = bytearray()
        last_tick = 0
        for tick, data in events:
            delta = max(0, tick - last_tick)
            track_data.extend(encode_vlq(delta))
            track_data.extend(data)
            last_tick = tick

        # End of track
        track_data.extend(b"\x00\xFF\x2F\x00")
        return b"MTrk" + struct.pack(">I", len(track_data)) + bytes(track_data)

    header = b"MThd" + struct.pack(">IHHH", 6, 1, 2, ticks_per_beat)
    track_rh = build_track(right_hand_notes, 0, "Right Hand (Treble)", include_tempo=True)
    track_lh = build_track(left_hand_notes, 1, "Left Hand (Bass)", include_tempo=False)

    with open(filepath, "wb") as f:
        f.write(header + track_rh + track_lh)


def create_mscz_file(filepath: str, title: str, composer: str, tempo_bpm: int, right_hand_measures: list, left_hand_measures: list):
    """
    Create a valid MuseScore .mscz (ZIP archive containing .mscx XML and container.xml).
    Each measure is a list of tuples: (midi_pitch, duration_type, dots) where midi_pitch=None means rest.
    """
    def render_staff_measures(measures):
        out = []
        for idx, m in enumerate(measures):
            out.append(f'      <Measure number="{idx + 1}">')
            out.append('        <voice>')
            if idx == 0:
                out.append('          <TimeSig><sigN>4</sigN><sigD>4</sigD></TimeSig>')
                tempo_bps = round(tempo_bpm / 60.0, 4)
                out.append(f'          <Tempo><tempo>{tempo_bps}</tempo><text>{tempo_bpm} BPM</text></Tempo>')
            for pitch, dtype in m:
                if pitch is None:
                    out.append(f'          <Rest><durationType>{dtype}</durationType></Rest>')
                else:
                    out.append('          <Chord>')
                    out.append(f'            <durationType>{dtype}</durationType>')
                    out.append(f'            <Note><pitch>{pitch}</pitch><tpc>14</tpc></Note>')
                    out.append('          </Chord>')
            out.append('        </voice>')
            out.append('      </Measure>')
        return "\n".join(out)

    mscx_content = f"""<?xml version="1.0" encoding="UTF-8"?>
<museScore version="3.02">
  <Score>
    <metaTag name="workTitle">{title}</metaTag>
    <metaTag name="composer">{composer}</metaTag>
    <Part>
      <Staff id="1">
        <StaffType group="pitched"><name>stdNormal</name></StaffType>
      </Staff>
      <Staff id="2">
        <StaffType group="pitched"><name>stdNormal</name></StaffType>
        <defaultClef>F</defaultClef>
      </Staff>
      <trackName>Piano</trackName>
    </Part>
    <Staff id="1">
{render_staff_measures(right_hand_measures)}
    </Staff>
    <Staff id="2">
{render_staff_measures(left_hand_measures)}
    </Staff>
  </Score>
</museScore>
"""
    container_xml = """<?xml version="1.0" encoding="UTF-8"?>
<container>
  <rootfiles>
    <rootfile full-path="score.mscx"/>
  </rootfiles>
</container>
"""
    with zipfile.ZipFile(filepath, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("META-INF/container.xml", container_xml)
        zf.writestr("score.mscx", mscx_content)


def main():
    os.makedirs(SAMPLES_DIR, exist_ok=True)

    # 1. Beethoven - Ode to Joy (Himno a la Alegría) - .mid
    ode_rh = [
        # Measure 1
        (0, 1, 64, 90), (1, 1, 64, 90), (2, 1, 65, 92), (3, 1, 67, 95),
        # Measure 2
        (4, 1, 67, 95), (5, 1, 65, 92), (6, 1, 64, 90), (7, 1, 62, 88),
        # Measure 3
        (8, 1, 60, 90), (9, 1, 60, 90), (10, 1, 62, 92), (11, 1, 64, 95),
        # Measure 4
        (12, 1.5, 64, 95), (13.5, 0.5, 62, 85), (14, 2, 62, 88),
        # Measure 5
        (16, 1, 64, 90), (17, 1, 64, 90), (18, 1, 65, 92), (19, 1, 67, 95),
        # Measure 6
        (20, 1, 67, 95), (21, 1, 65, 92), (22, 1, 64, 90), (23, 1, 62, 88),
        # Measure 7
        (24, 1, 60, 90), (25, 1, 60, 90), (26, 1, 62, 92), (27, 1, 64, 95),
        # Measure 8
        (28, 1.5, 62, 92), (29.5, 0.5, 60, 85), (30, 2, 60, 90),
    ]
    ode_lh = [
        (0, 2, 48, 75), (2, 2, 55, 75),
        (4, 2, 55, 75), (6, 2, 43, 75),
        (8, 2, 48, 75), (10, 2, 52, 75),
        (12, 2, 55, 75), (14, 2, 43, 75),
        (16, 2, 48, 75), (18, 2, 55, 75),
        (20, 2, 55, 75), (22, 2, 43, 75),
        (24, 2, 48, 75), (26, 2, 52, 75),
        (28, 2, 43, 75), (30, 2, 48, 80),
    ]
    create_midi_file(os.path.join(SAMPLES_DIR, "beethoven_ode_to_joy.mid"), 108, ode_rh, ode_lh)

    # 2. Bach - Minuet in G Major (BWV Anh. 114) excerpt - .mscz
    bach_rh_measures = [
        [(74, "quarter"), (67, "eighth"), (69, "eighth"), (71, "eighth"), (72, "eighth")],
        [(74, "quarter"), (67, "quarter"), (67, "quarter"), (None, "quarter")],
        [(76, "quarter"), (72, "eighth"), (74, "eighth"), (76, "eighth"), (78, "eighth")],
        [(79, "quarter"), (67, "quarter"), (67, "quarter"), (None, "quarter")],
    ]
    bach_lh_measures = [
        [(55, "half"), (57, "quarter"), (59, "quarter")],
        [(59, "half"), (55, "half")],
        [(60, "half"), (59, "quarter"), (57, "quarter")],
        [(55, "half"), (43, "half")],
    ]
    create_mscz_file(
        os.path.join(SAMPLES_DIR, "bach_minuet_in_g.mscz"),
        "Minuet in G Major (Estudio Universitario)",
        "J. S. Bach",
        100,
        bach_rh_measures,
        bach_lh_measures,
    )

    print("Sample .mid and .mscz files created in", SAMPLES_DIR)


if __name__ == "__main__":
    main()
