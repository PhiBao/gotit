# Demo video — sources

The video itself is **not** committed: it is a 17 MB binary and a submission artifact,
not source. These are the files that produce it, so it can be regenerated rather than
re-shot.

| File | What it is |
|---|---|
| `story.json` | The script: narration and scene definitions |
| `video.json` | Branding, voice, and the theme |
| `gotit.srt` | The subtitle sidecar that was burned in, kept for uploads |

## Regenerating

The generator is a separate toolkit (`demo-video-template`), not part of this repo:

```bash
cd ~/demo-video-template
cp /path/to/midnight/docs/video/story.json videos/gotit/script/story.json
cp /path/to/midnight/docs/video/video.json videos/gotit/config/video.json
./scripts/run.sh --project gotit
# -> videos/gotit/out/gotit.mp4, plus qa/ for inspection
```

`./scripts/run.sh --project gotit --only s3_report` re-records one scene. Editing a
segment's narration regenerates only its audio; editing a scene regenerates only its
clip.

## What the scenes show

| Scene | Surface | Why |
|---|---|---|
| `s1_title` | card | The obligation and the date |
| `s2_problem` | landing page | The trap: publish statistics, identify nobody |
| `s3_report` | `#report` | **The hero.** A real publishable row: 5 women, 5 men, a material gap, the interval, the Art. 9(4) flag |
| `s4_gate` | `#report` | The withheld table, and that the gate is in the circuit |
| `s5_verify` | `#verify` | Anyone can check a fingerprint with no wallet |
| `s6_proof` | terminal | Reproduction from chain state, and the contract tests |
| `s7_setup` | landing → wallet gate → `#guide` | **The connect path**, and the sync warning |
| `s8_close` | card | Thesis and links |

## Rules these scenes follow

- Every number on screen is real and was captured from the running system. The gap,
  the headcounts and the test count come from the live Preprod contract.
- `s6_proof` shows the actual command and its actual output.
- `s7_setup` shows the connect modal and the setup guide, because a demo that skips
  setup leaves the viewer unable to try it.

## One dependency worth knowing

`edge-tts` below 7.3.1 gets a `403` from Microsoft's narration endpoint and the
pipeline fails at the TTS step. Upgrade with:

```bash
~/.local/share/uv/python/*/bin/python -m pip install --upgrade edge-tts
```

or recreate the venv with `./scripts/setup.sh`.
