/**
 * Model `@mgreten/frigate-timelapse` — construction site timelapse capture and
 * compilation via the Frigate NVR API.
 *
 * Fetches periodic snapshots from any Frigate camera on a remote host via SSH,
 * organises them into named construction phases, and compiles per-day and
 * full-phase H.264 timelapse videos using ffmpeg inside the Frigate container.
 *
 * Requires key-based SSH access to the host running the Frigate container.
 * The Frigate API must be reachable from the machine running swamp.
 */
import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Global args
// ---------------------------------------------------------------------------

const GlobalArgsSchema = z.object({
  frigateUrl: z
    .string()
    .describe("Frigate API base URL (e.g. 'http://192.168.1.10:5000')"),
  sshHost: z
    .string()
    .describe(
      "SSH hostname or IP of the machine running the Frigate container",
    ),
  camera: z
    .string()
    .describe(
      "Frigate camera name to capture snapshots from (e.g. 'driveway')",
    ),
  containerName: z
    .string()
    .default("frigate")
    .describe("Docker container name for the Frigate instance"),
  hostArchiveDir: z
    .string()
    .describe(
      "Absolute path to the timelapse archive directory on the SSH host " +
        "(e.g. '/srv/frigate/timelapse-archive')",
    ),
  containerArchiveDir: z
    .string()
    .describe(
      "Absolute path to the same archive directory as seen from inside the " +
        "Frigate container (e.g. '/media/frigate/timelapse-archive'). " +
        "Needed because ffmpeg runs via 'docker exec' and sees container paths.",
    ),
  ffmpegPath: z
    .string()
    .default("/usr/lib/ffmpeg/7.0/bin/ffmpeg")
    .describe(
      "Path to ffmpeg inside the Frigate container. " +
        "Run 'docker exec <container> find /usr -name ffmpeg' to locate it.",
    ),
});

// ---------------------------------------------------------------------------
// Resource schemas
// ---------------------------------------------------------------------------

const SnapshotSchema = z.object({
  phase: z.string().describe("Phase name this snapshot belongs to"),
  file: z.string().describe(
    "Absolute path to the snapshot JPEG on the SSH host",
  ),
  camera: z.string().describe("Camera name"),
  timestamp: z.string().describe("ISO-8601 capture timestamp"),
  size: z.number().describe("File size in bytes"),
});

const DaySummarySchema = z.object({
  date: z.string().describe("Date string YYYYMMDD"),
  count: z.number().describe("Number of snapshots on this date"),
  firstFile: z.string().describe("Path to first snapshot of the day"),
  lastFile: z.string().describe("Path to last snapshot of the day"),
});

const SnapshotIndexSchema = z.object({
  phase: z.string(),
  camera: z.string(),
  days: z.array(DaySummarySchema),
  total: z.number().describe("Total snapshot count across all days"),
  timestamp: z.string().describe("ISO-8601 timestamp of this index"),
});

const CompiledVideoSchema = z.object({
  phase: z.string(),
  date: z.string().describe("YYYY-MM-DD date string for the compiled day"),
  camera: z.string(),
  file: z.string().describe(
    "Absolute path to the compiled video on the SSH host",
  ),
  frameCount: z.number().describe("Number of frames compiled into the video"),
  durationSec: z.number().describe("Approximate video duration in seconds"),
  timestamp: z.string().describe("ISO-8601 timestamp of compilation"),
});

const PhaseVideoSchema = z.object({
  phase: z.string(),
  camera: z.string(),
  file: z.string().describe(
    "Absolute path to the full phase video on the SSH host",
  ),
  dayCount: z.number().describe("Number of days included in the phase video"),
  totalFrames: z.number().describe("Total frame count across all days"),
  timestamp: z.string().describe("ISO-8601 timestamp of compilation"),
});

const PhaseEntrySchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  startDate: z.string().describe("ISO-8601 date when the phase was started"),
  status: z.enum(["active", "complete"]),
  snapshotCount: z.number().default(0),
});

const PhaseStatusSchema = z.object({
  phase: z.string(),
  camera: z.string(),
  status: z.string(),
  phasesFile: z.string().describe(
    "Absolute path to phases.json on the SSH host",
  ),
  timestamp: z.string(),
});

const PhaseListSchema = z.object({
  camera: z.string(),
  phases: z.array(PhaseEntrySchema),
  timestamp: z.string(),
});

// ---------------------------------------------------------------------------
// SSH helper
// ---------------------------------------------------------------------------

/** Execute a shell command on the remote host via SSH and return trimmed stdout. */
async function sshExec(host: string, command: string): Promise<string> {
  const cmd = new Deno.Command("ssh", {
    args: ["-o", "ConnectTimeout=10", "-o", "BatchMode=yes", host, command],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  if (code !== 0) {
    const errText = new TextDecoder().decode(stderr);
    throw new Error(`SSH command failed (exit ${code}): ${errText.trim()}`);
  }
  return new TextDecoder().decode(stdout).trim();
}

// ---------------------------------------------------------------------------
// Context type shared across methods
// ---------------------------------------------------------------------------

type MethodContext = {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    spec: string,
    name: string,
    data: unknown,
  ) => Promise<unknown>;
};

// ---------------------------------------------------------------------------
// Model export
// ---------------------------------------------------------------------------

/**
 * `@mgreten/frigate-timelapse` — construction site timelapse management.
 *
 * Captures periodic snapshots from a Frigate NVR camera on a remote host,
 * organises them into named construction phases, and compiles them into per-day
 * and full-phase video files using ffmpeg — all on the remote host via SSH.
 */
export const model = {
  type: "@mgreten/frigate-timelapse",
  version: "2026.06.27.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    snapshot: {
      description:
        "A single captured JPEG snapshot from the construction camera",
      schema: SnapshotSchema,
      lifetime: "1h",
      garbageCollection: 100,
    },
    snapshotIndex: {
      description: "Index of all snapshots for a phase, grouped by date",
      schema: SnapshotIndexSchema,
      lifetime: "1h",
      garbageCollection: 5,
    },
    compiledVideo: {
      description: "A per-day compiled timelapse video for a phase",
      schema: CompiledVideoSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    phaseVideo: {
      description: "A full-phase concatenated timelapse video",
      schema: PhaseVideoSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    phaseStatus: {
      description: "Result of a phase create/update operation",
      schema: PhaseStatusSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    phaseList: {
      description: "List of all construction phases with snapshot counts",
      schema: PhaseListSchema,
      lifetime: "1h",
      garbageCollection: 5,
    },
  },
  methods: {
    /**
     * Capture a single snapshot from the configured Frigate camera.
     *
     * Fetches the latest JPEG via curl on the remote host and saves it to the
     * phase snapshot directory with a timestamp filename.
     *
     * Output resource: `snapshot`
     */
    captureSnapshot: {
      description:
        "Fetch the latest camera JPEG from Frigate via SSH curl on the remote host " +
        "and save it to the phase snapshot archive directory",
      arguments: z.object({
        phase: z
          .string()
          .default("construction")
          .describe("Construction phase name (e.g. 'foundation', 'framing')"),
      }),
      execute: async (
        args: { phase: string },
        context: MethodContext,
      ): Promise<{ dataHandles: unknown[] }> => {
        const { sshHost, frigateUrl, camera, hostArchiveDir } =
          context.globalArgs;
        const { phase } = args;

        // Build the snapshot directory path on the remote host
        const snapshotDir = `${hostArchiveDir}/${camera}/snapshots/${phase}`;

        context.logger.info(
          "Capturing snapshot for camera {camera} phase {phase}",
          {
            camera,
            phase,
          },
        );

        // Generate a timestamp for the filename
        const timestamp = await sshExec(
          sshHost,
          `date +%Y%m%d_%H%M%S`,
        );

        const outputPath = `${snapshotDir}/${timestamp}.jpg`;

        // Ensure the directory exists on the remote host
        await sshExec(sshHost, `mkdir -p "${snapshotDir}"`);

        // Fetch the latest JPEG from Frigate using the configured URL
        await sshExec(
          sshHost,
          `curl -s -f -o "${outputPath}" "${frigateUrl}/api/${camera}/latest.jpg"`,
        );

        // Stat the file to get its size
        const sizeStr = await sshExec(
          sshHost,
          `stat -c %s "${outputPath}"`,
        );
        const size = parseInt(sizeStr, 10);

        context.logger.info("Snapshot saved to {file} ({size} bytes)", {
          file: outputPath,
          size,
        });

        const isoTimestamp = await sshExec(
          sshHost,
          `date +%Y-%m-%dT%H:%M:%S%z`,
        );

        const handle = await context.writeResource(
          "snapshot",
          `snapshot-${camera}-${phase}-${timestamp}`,
          {
            phase,
            file: outputPath,
            camera,
            timestamp: isoTimestamp,
            size,
          },
        );

        return { dataHandles: [handle] };
      },
    },

    /**
     * List all snapshots for a phase, grouped by date.
     *
     * SSHes to the remote host and enumerates JPEG files in the phase snapshot
     * directory. Returns a day-by-day summary with counts and first/last files.
     *
     * Output resource: `snapshotIndex`
     */
    listSnapshots: {
      description:
        "List all captured snapshots for a phase on the remote host, grouped by date",
      arguments: z.object({
        phase: z
          .string()
          .default("construction")
          .describe("Construction phase name to list snapshots for"),
      }),
      execute: async (
        args: { phase: string },
        context: MethodContext,
      ): Promise<{ dataHandles: unknown[] }> => {
        const { sshHost, camera, hostArchiveDir } = context.globalArgs;
        const { phase } = args;

        const snapshotDir = `${hostArchiveDir}/${camera}/snapshots/${phase}`;

        context.logger.info(
          "Listing snapshots for camera {camera} phase {phase}",
          { camera, phase },
        );

        // List all JPEGs sorted by name (which is also chronological order)
        let listing: string;
        try {
          listing = await sshExec(
            sshHost,
            `find "${snapshotDir}" -maxdepth 1 -name '*.jpg' | sort`,
          );
        } catch {
          // Directory may not exist yet — return empty index
          listing = "";
        }

        const files = listing
          ? listing.split("\n").filter((f) => f.length > 0)
          : [];

        context.logger.info("Found {count} snapshots", { count: files.length });

        // Group by date prefix (first 8 chars of filename: YYYYMMDD)
        const byDate = new Map<string, string[]>();
        for (const file of files) {
          const basename = file.split("/").pop() ?? "";
          const date = basename.slice(0, 8);
          if (!date.match(/^\d{8}$/)) continue;
          const existing = byDate.get(date) ?? [];
          existing.push(file);
          byDate.set(date, existing);
        }

        const days: z.infer<typeof DaySummarySchema>[] = [];
        for (const [date, dayFiles] of [...byDate.entries()].sort()) {
          days.push({
            date,
            count: dayFiles.length,
            firstFile: dayFiles[0],
            lastFile: dayFiles[dayFiles.length - 1],
          });
        }

        const handle = await context.writeResource(
          "snapshotIndex",
          `snapshotIndex-${camera}-${phase}`,
          {
            phase,
            camera,
            days,
            total: files.length,
            timestamp: new Date().toISOString(),
          },
        );

        return { dataHandles: [handle] };
      },
    },

    /**
     * Compile all snapshots for a single date into a timelapse video.
     *
     * SSHes to the remote host, finds all JPEGs for the given date in the phase
     * snapshot directory, then runs ffmpeg inside the Frigate container to
     * produce an H.264 MP4. The output is saved to the phase videos directory.
     *
     * Output resource: `compiledVideo`
     */
    compileDay: {
      description:
        "Compile all snapshots for a single date into an H.264 timelapse video on the remote host",
      arguments: z.object({
        date: z
          .string()
          .describe("Date to compile in YYYY-MM-DD format (e.g. '2026-06-01')"),
        phase: z
          .string()
          .default("construction")
          .describe("Phase name whose snapshots to compile"),
        fps: z
          .number()
          .default(30)
          .describe("Output video frames per second"),
        crf: z
          .number()
          .default(23)
          .describe(
            "H.264 CRF quality (18=near-lossless, 28=low quality, 23=default)",
          ),
      }),
      execute: async (
        args: { date: string; phase: string; fps: number; crf: number },
        context: MethodContext,
      ): Promise<{ dataHandles: unknown[] }> => {
        const {
          sshHost,
          camera,
          hostArchiveDir,
          containerArchiveDir,
          containerName,
          ffmpegPath,
        } = context.globalArgs;
        const { date, phase, fps, crf } = args;

        // Normalise date to YYYYMMDD for glob matching
        const dateCompact = date.replace(/-/g, "");

        const snapshotDir = `${hostArchiveDir}/${camera}/snapshots/${phase}`;
        const videoDir = `${hostArchiveDir}/${camera}/videos/${phase}`;
        const outputFile = `${videoDir}/${dateCompact}.mp4`;

        context.logger.info(
          "Compiling day {date} for camera {camera} phase {phase} at {fps}fps CRF {crf}",
          { date, camera, phase, fps, crf },
        );

        // Count matching frames
        const countStr = await sshExec(
          sshHost,
          `find "${snapshotDir}" -maxdepth 1 -name '${dateCompact}_*.jpg' | wc -l`,
        );
        const frameCount = parseInt(countStr.trim(), 10);

        if (frameCount === 0) {
          throw new Error(
            `No snapshots found for date ${date} in ${snapshotDir}. ` +
              `Run listSnapshots to verify available dates.`,
          );
        }

        context.logger.info("Found {frames} frames for {date}", {
          frames: frameCount,
          date,
        });

        // Ensure the video output directory exists
        await sshExec(sshHost, `mkdir -p "${videoDir}"`);

        // ffmpeg runs inside the Frigate container via docker exec,
        // so we use containerArchiveDir for all paths passed to ffmpeg.
        const containerSnapshotDir =
          `${containerArchiveDir}/${camera}/snapshots/${phase}`;
        const containerOutputFile =
          `${containerArchiveDir}/${camera}/videos/${phase}/${dateCompact}.mp4`;

        const ffmpegCmd = `docker exec ${containerName} ${ffmpegPath} -y ` +
          `-framerate ${fps} ` +
          `-pattern_type glob -i '${containerSnapshotDir}/${dateCompact}_*.jpg' ` +
          `-c:v libx264 -pix_fmt yuv420p -crf ${crf} -movflags +faststart ` +
          `"${containerOutputFile}"`;

        context.logger.info("Running ffmpeg via docker exec for {date}", {
          date,
        });
        await sshExec(sshHost, ffmpegCmd);

        const durationSec = Math.round(frameCount / fps);

        context.logger.info(
          "Compiled {frames} frames → {file} (~{dur}s)",
          { frames: frameCount, file: outputFile, dur: durationSec },
        );

        const handle = await context.writeResource(
          "compiledVideo",
          `compiledVideo-${camera}-${phase}-${dateCompact}`,
          {
            phase,
            date,
            camera,
            file: outputFile,
            frameCount,
            durationSec,
            timestamp: new Date().toISOString(),
          },
        );

        return { dataHandles: [handle] };
      },
    },

    /**
     * Compile all days in a phase (or a date range) into per-day videos and
     * then concatenate them into a single full-phase video.
     *
     * SSHes to the remote host to enumerate available dates, compiles each day
     * individually with ffmpeg, then uses ffmpeg concat demuxer to join them
     * all into one phase-level video file.
     *
     * Output resource: `phaseVideo`
     */
    compileDays: {
      description:
        "Compile all days in a phase (or date range) into per-day videos, " +
        "then concatenate into a single full-phase video on the remote host",
      arguments: z.object({
        phase: z
          .string()
          .default("construction")
          .describe("Phase name to compile"),
        startDate: z
          .string()
          .optional()
          .describe("Optional start date YYYY-MM-DD (inclusive); omit for all"),
        endDate: z
          .string()
          .optional()
          .describe("Optional end date YYYY-MM-DD (inclusive); omit for all"),
        fps: z
          .number()
          .default(30)
          .describe("Output video frames per second"),
        crf: z
          .number()
          .default(23)
          .describe("H.264 CRF quality"),
      }),
      execute: async (
        args: {
          phase: string;
          startDate?: string;
          endDate?: string;
          fps: number;
          crf: number;
        },
        context: MethodContext,
      ): Promise<{ dataHandles: unknown[] }> => {
        const {
          sshHost,
          camera,
          hostArchiveDir,
          containerArchiveDir,
          containerName,
          ffmpegPath,
        } = context.globalArgs;
        const { phase, startDate, endDate, fps, crf } = args;

        const snapshotDir = `${hostArchiveDir}/${camera}/snapshots/${phase}`;
        const videoDir = `${hostArchiveDir}/${camera}/videos/${phase}`;
        const phaseOutputFile = `${videoDir}/phase_${phase}_full.mp4`;

        context.logger.info(
          "Compiling all days for camera {camera} phase {phase}",
          { camera, phase },
        );

        // Discover all distinct dates with snapshots
        const listing = await sshExec(
          sshHost,
          `find "${snapshotDir}" -maxdepth 1 -name '*.jpg' | ` +
            `sed 's|.*/||' | cut -c1-8 | sort -u`,
        );

        let allDates = listing
          ? listing.split("\n").filter((d) => d.match(/^\d{8}$/))
          : [];

        // Apply optional date range filter (dates are YYYYMMDD)
        const startCompact = startDate ? startDate.replace(/-/g, "") : null;
        const endCompact = endDate ? endDate.replace(/-/g, "") : null;
        if (startCompact) {
          allDates = allDates.filter((d) => d >= startCompact);
        }
        if (endCompact) {
          allDates = allDates.filter((d) => d <= endCompact);
        }

        if (allDates.length === 0) {
          throw new Error(
            `No snapshot dates found for phase '${phase}' in ${snapshotDir}` +
              (startDate || endDate ? ` within the specified date range` : ""),
          );
        }

        context.logger.info("Found {count} dates to compile: {dates}", {
          count: allDates.length,
          dates: allDates.join(", "),
        });

        await sshExec(sshHost, `mkdir -p "${videoDir}"`);

        let totalFrames = 0;
        const perDayFiles: string[] = [];

        // ffmpeg runs inside the Frigate container via docker exec,
        // so we use containerArchiveDir for all paths passed to ffmpeg.
        const containerSnapshotDir =
          `${containerArchiveDir}/${camera}/snapshots/${phase}`;
        const containerVideoDir =
          `${containerArchiveDir}/${camera}/videos/${phase}`;

        // Compile each day individually
        for (const dateCompact of allDates) {
          const dayOutputFile = `${videoDir}/${dateCompact}.mp4`;
          const containerDayOutputFile =
            `${containerVideoDir}/${dateCompact}.mp4`;

          const countStr = await sshExec(
            sshHost,
            `find "${snapshotDir}" -maxdepth 1 -name '${dateCompact}_*.jpg' | wc -l`,
          );
          const frameCount = parseInt(countStr.trim(), 10);

          if (frameCount === 0) {
            context.logger.warning(
              "No frames found for date {date}, skipping",
              {
                date: dateCompact,
              },
            );
            continue;
          }

          context.logger.info("Compiling {frames} frames for {date}", {
            frames: frameCount,
            date: dateCompact,
          });

          const ffmpegCmd = `docker exec ${containerName} ${ffmpegPath} -y ` +
            `-framerate ${fps} ` +
            `-pattern_type glob -i '${containerSnapshotDir}/${dateCompact}_*.jpg' ` +
            `-c:v libx264 -pix_fmt yuv420p -crf ${crf} -movflags +faststart ` +
            `"${containerDayOutputFile}"`;

          await sshExec(sshHost, ffmpegCmd);

          totalFrames += frameCount;
          perDayFiles.push(dayOutputFile);
        }

        if (perDayFiles.length === 0) {
          throw new Error(
            `No per-day videos were produced — cannot create phase video.`,
          );
        }

        context.logger.info(
          "Concatenating {count} day videos into phase video {file}",
          { count: perDayFiles.length, file: phaseOutputFile },
        );

        // Build a concat list on the remote host using container paths (for docker exec ffmpeg).
        const concatListHostPath = `${videoDir}/.concat_list_${phase}.txt`;
        const concatListContainerPath =
          `${containerVideoDir}/.concat_list_${phase}.txt`;
        const containerPerDayFiles = perDayFiles.map(
          (f) => f.replace(videoDir, containerVideoDir),
        );
        const writeListCmd = `rm -f "${concatListHostPath}" && ` +
          containerPerDayFiles
            .map((f) => `echo "file '${f}'" >> "${concatListHostPath}"`)
            .join(" && ");
        await sshExec(sshHost, writeListCmd);

        const containerPhaseOutputFile =
          `${containerVideoDir}/phase_${phase}_full.mp4`;
        const concatCmd =
          `docker exec ${containerName} ${ffmpegPath} -y -f concat -safe 0 ` +
          `-i "${concatListContainerPath}" -c copy "${containerPhaseOutputFile}"`;
        await sshExec(sshHost, concatCmd);

        await sshExec(sshHost, `rm -f "${concatListHostPath}"`);

        context.logger.info(
          "Phase video complete: {file} ({days} days, {frames} total frames)",
          {
            file: phaseOutputFile,
            days: perDayFiles.length,
            frames: totalFrames,
          },
        );

        const handle = await context.writeResource(
          "phaseVideo",
          `phaseVideo-${camera}-${phase}`,
          {
            phase,
            camera,
            file: phaseOutputFile,
            dayCount: perDayFiles.length,
            totalFrames,
            timestamp: new Date().toISOString(),
          },
        );

        return { dataHandles: [handle] };
      },
    },

    /**
     * Start a new construction phase.
     *
     * Creates the snapshot directory structure on the remote host and appends
     * an entry to `phases.json`. If `phases.json` does not yet exist it is
     * created. An error is thrown if the phase name already exists.
     *
     * Output resource: `phaseStatus`
     */
    startPhase: {
      description:
        "Create a new construction phase: make snapshot directories on the remote host " +
        "and record the phase in phases.json",
      arguments: z.object({
        phase: z.string().describe(
          "New phase name (e.g. 'foundation', 'framing')",
        ),
        description: z
          .string()
          .optional()
          .describe("Optional human-readable description of this phase"),
      }),
      execute: async (
        args: { phase: string; description?: string },
        context: MethodContext,
      ): Promise<{ dataHandles: unknown[] }> => {
        const { sshHost, camera, hostArchiveDir } = context.globalArgs;
        const { phase, description } = args;

        const snapshotDir = `${hostArchiveDir}/${camera}/snapshots/${phase}`;
        const videoDir = `${hostArchiveDir}/${camera}/videos/${phase}`;
        const phasesFile = `${hostArchiveDir}/${camera}/phases.json`;

        context.logger.info(
          "Starting new phase '{phase}' for camera {camera}",
          {
            phase,
            camera,
          },
        );

        // Ensure directories exist
        await sshExec(sshHost, `mkdir -p "${snapshotDir}" "${videoDir}"`);

        // Load or initialise phases.json.
        // Format on disk: {"phases": [...]} — an object wrapper to allow future metadata.
        let phases: z.infer<typeof PhaseEntrySchema>[] = [];
        try {
          const raw = await sshExec(sshHost, `cat "${phasesFile}"`);
          const parsed = JSON.parse(raw) as {
            phases?: z.infer<typeof PhaseEntrySchema>[];
          };
          phases = parsed.phases ?? [];
        } catch {
          // File does not exist yet — start with empty list
          phases = [];
        }

        // Check for duplicate
        if (phases.some((p) => p.name === phase)) {
          throw new Error(
            `Phase '${phase}' already exists in ${phasesFile}. ` +
              `Use listPhases to see existing phases.`,
          );
        }

        const startDate = new Date().toISOString().slice(0, 10);
        const newEntry: z.infer<typeof PhaseEntrySchema> = {
          name: phase,
          ...(description ? { description } : {}),
          startDate,
          status: "active",
          snapshotCount: 0,
        };
        phases.push(newEntry);

        // Write the updated phases.json back to the remote host.
        // Use python3 to avoid shell quoting issues with multi-line JSON content.
        const phasesJson = JSON.stringify({ phases }, null, 2);
        const writeCmd =
          `python3 -c "import sys; open('${phasesFile}', 'w').write(sys.stdin.read())" <<'PHASESEOF'\n` +
          phasesJson +
          `\nPHASESEOF`;
        await sshExec(sshHost, writeCmd);

        context.logger.info("Phase '{phase}' created — phases.json updated", {
          phase,
        });

        const handle = await context.writeResource(
          "phaseStatus",
          `phaseStatus-${camera}-${phase}`,
          {
            phase,
            camera,
            status: "created",
            phasesFile,
            timestamp: new Date().toISOString(),
          },
        );

        return { dataHandles: [handle] };
      },
    },

    /**
     * List all construction phases for the configured camera.
     *
     * Reads `phases.json` from the remote host and enriches each entry with a
     * live snapshot count by enumerating JPEG files on disk.
     *
     * Output resource: `phaseList`
     */
    listPhases: {
      description:
        "Read phases.json from the remote host and return all phases with live snapshot counts",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ): Promise<{ dataHandles: unknown[] }> => {
        const { sshHost, camera, hostArchiveDir } = context.globalArgs;
        const phasesFile = `${hostArchiveDir}/${camera}/phases.json`;

        context.logger.info("Listing phases for camera {camera}", { camera });

        let phases: z.infer<typeof PhaseEntrySchema>[] = [];
        try {
          const raw = await sshExec(sshHost, `cat "${phasesFile}"`);
          const parsed = JSON.parse(raw) as {
            phases?: z.infer<typeof PhaseEntrySchema>[];
          };
          phases = parsed.phases ?? [];
        } catch {
          // phases.json does not exist — return empty list
          context.logger.info("No phases.json found for camera {camera}", {
            camera,
          });
          phases = [];
        }

        // Enrich each phase with a live snapshot count
        const enriched: z.infer<typeof PhaseEntrySchema>[] = [];
        for (const entry of phases) {
          const snapshotDir =
            `${hostArchiveDir}/${camera}/snapshots/${entry.name}`;
          let snapshotCount = 0;
          try {
            const countStr = await sshExec(
              sshHost,
              `find "${snapshotDir}" -maxdepth 1 -name '*.jpg' | wc -l`,
            );
            snapshotCount = parseInt(countStr.trim(), 10);
          } catch {
            // Directory doesn't exist yet — count stays 0
          }
          enriched.push({ ...entry, snapshotCount });
        }

        context.logger.info("Found {count} phases", { count: enriched.length });

        const handle = await context.writeResource(
          "phaseList",
          `phaseList-${camera}`,
          {
            camera,
            phases: enriched,
            timestamp: new Date().toISOString(),
          },
        );

        return { dataHandles: [handle] };
      },
    },
  },
};
