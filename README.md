# @mgreten/frigate-timelapse

A [swamp](https://github.com/systeminit/swamp) extension model for construction site timelapse capture and compilation via the [Frigate NVR](https://frigate.video) API.

Fetches periodic snapshots from any Frigate camera on a remote host via SSH, organises them into named construction phases, and compiles per-day and full-phase H.264 timelapse videos using ffmpeg inside the Frigate container.

## What it does

- **Captures snapshots** — Fetches the latest JPEG from any Frigate camera and archives it to a structured directory on the remote host, organised by `camera / phase / date`.
- **Manages phases** — Groups snapshots into named construction stages (e.g. `foundation`, `framing`, `roofing`) with a `phases.json` manifest persisted on the remote host.
- **Compiles timelapses** — Runs ffmpeg inside the Frigate Docker container to produce per-day H.264 MP4 files, then concatenates them into a single full-phase video.

## Prerequisites

- **Key-based SSH access** to the host running Frigate (no password prompt).
- **Frigate running in Docker** on the remote host. The container must have ffmpeg available (it does by default in official Frigate images).
- **ffmpeg in the container** — the default path is `/usr/lib/ffmpeg/7.0/bin/ffmpeg`. To find the right path for your version: `docker exec <container> find /usr -name ffmpeg`.
- **Shared volume mount** — the archive directory must exist on both the host and inside the container (via a Docker volume). You need to know both the host path and the container path.

## Global arguments

| Argument | Required | Default | Description |
|---|---|---|---|
| `frigateUrl` | yes | — | Frigate API base URL, e.g. `http://192.0.2.10:5000` |
| `sshHost` | yes | — | SSH hostname or IP of the machine running the Frigate container |
| `camera` | yes | — | Frigate camera name, e.g. `driveway` |
| `hostArchiveDir` | yes | — | Absolute path to the timelapse archive directory on the SSH host, e.g. `/srv/frigate/timelapse-archive` |
| `containerArchiveDir` | yes | — | Absolute path to the same archive directory as seen from inside the Frigate container, e.g. `/media/frigate/timelapse-archive` |
| `containerName` | no | `frigate` | Docker container name for the Frigate instance |
| `ffmpegPath` | no | `/usr/lib/ffmpeg/7.0/bin/ffmpeg` | Path to ffmpeg inside the Frigate container |

## Methods

| Method | Description | Output resource |
|---|---|---|
| `captureSnapshot` | Fetch the latest JPEG from Frigate and save to the phase archive | `snapshot` |
| `listSnapshots` | List all captured snapshots for a phase, grouped by date | `snapshotIndex` |
| `compileDay` | Compile all snapshots for a single date into an H.264 MP4 | `compiledVideo` |
| `compileDays` | Compile all days in a phase (or date range) and concatenate into one phase video | `phaseVideo` |
| `startPhase` | Create a new named construction phase and its directory structure | `phaseStatus` |
| `listPhases` | List all phases with live snapshot counts | `phaseList` |

### Method arguments

**`captureSnapshot`**
- `phase` (default: `construction`) — Phase name to file the snapshot under.

**`listSnapshots`**
- `phase` (default: `construction`) — Phase name to list.

**`compileDay`**
- `date` (required) — Date in `YYYY-MM-DD` format.
- `phase` (default: `construction`) — Phase name.
- `fps` (default: `30`) — Output frames per second.
- `crf` (default: `23`) — H.264 CRF quality (18 = near-lossless, 28 = low quality).

**`compileDays`**
- `phase` (default: `construction`) — Phase name.
- `startDate` (optional) — Inclusive start date `YYYY-MM-DD`.
- `endDate` (optional) — Inclusive end date `YYYY-MM-DD`.
- `fps` (default: `30`) — Output frames per second.
- `crf` (default: `23`) — H.264 CRF quality.

**`startPhase`**
- `phase` (required) — New phase name.
- `description` (optional) — Human-readable description.

## Example usage

```bash
# Install the extension
swamp extension pull @mgreten/frigate-timelapse

# Create a model instance
swamp model create @mgreten/frigate-timelapse my-timelapse \
  --global-arg frigateUrl=http://192.0.2.10:5000 \
  --global-arg sshHost=192.0.2.10 \
  --global-arg camera=driveway \
  --global-arg hostArchiveDir=/srv/frigate/timelapse-archive \
  --global-arg containerArchiveDir=/media/frigate/timelapse-archive

# Start a construction phase
swamp model method run my-timelapse startPhase --arg phase=foundation --arg description="Foundation pour"

# Capture a snapshot (call this on a schedule — see below)
swamp model method run my-timelapse captureSnapshot --arg phase=foundation

# List accumulated snapshots
swamp model method run my-timelapse listSnapshots --arg phase=foundation

# Compile today's snapshots into a timelapse
swamp model method run my-timelapse compileDay --arg date=2026-06-11 --arg phase=foundation

# Compile all days in a phase into one video
swamp model method run my-timelapse compileDays --arg phase=foundation

# List all phases
swamp model method run my-timelapse listPhases
```

## Setting up periodic snapshot capture

To capture snapshots automatically, add a cron job on the swamp host. For example, to capture every 5 minutes during daylight hours (7am–7pm):

```cron
*/5 7-19 * * * swamp model method run my-timelapse captureSnapshot --arg phase=foundation >> /var/log/timelapse-capture.log 2>&1
```

Adjust the phase name and schedule to match your project.

## Directory structure on the host

The extension creates the following layout under `hostArchiveDir`:

```
<hostArchiveDir>/
  <camera>/
    phases.json                  # Phase metadata
    snapshots/
      <phase>/
        20260611_070000.jpg
        20260611_070500.jpg
        ...
    videos/
      <phase>/
        20260611.mp4             # Per-day compiled video
        phase_<phase>_full.mp4  # Full phase concatenated video
```

## License

MIT — see [LICENSE.txt](LICENSE.txt).
