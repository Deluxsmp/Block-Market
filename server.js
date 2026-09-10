const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");

const app = express();

const PORT = process.env.PORT || 3000;

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const UPLOAD_DIR = path.join(ROOT, "uploads");
const OUTPUT_DIR = path.join(ROOT, "output");

for (const dir of [UPLOAD_DIR, OUTPUT_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

app.use(express.json({ limit: "1mb" }));
app.use(express.static(PUBLIC_DIR));
app.use("/output", express.static(OUTPUT_DIR));

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,

  filename: (req, file, cb) => {
    const id = crypto.randomBytes(8).toString("hex");
    const ext = path.extname(file.originalname).toLowerCase() || ".mp4";

    cb(null, `${id}${ext}`);
  }
});

const upload = multer({
  storage,

  limits: {
    fileSize: 500 * 1024 * 1024
  },

  fileFilter: (req, file, cb) => {
    const allowed = [
      "video/mp4",
      "video/webm",
      "video/quicktime",
      "video/x-matroska",
      "video/mpeg"
    ];

    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Unsupported video format."));
    }

    cb(null, true);
  }
});

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      args,
      {
        windowsHide: true,
        maxBuffer: 1024 * 1024 * 10
      },
      (error, stdout, stderr) => {
        if (error) {
          console.error(stderr);
          return reject(error);
        }

        resolve({ stdout, stderr });
      }
    );
  });
}

function runFFprobe(args) {
  return new Promise((resolve, reject) => {
    execFile(
      "ffprobe",
      args,
      {
        windowsHide: true,
        maxBuffer: 1024 * 1024 * 5
      },
      (error, stdout, stderr) => {
        if (error) {
          console.error(stderr);
          return reject(error);
        }

        resolve(stdout);
      }
    );
  });
}

async function getVideoInfo(file) {
  const result = await runFFprobe([
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    file
  ]);

  const duration = Number.parseFloat(result.trim());

  if (!Number.isFinite(duration)) {
    throw new Error("Could not determine video duration.");
  }

  return {
    duration
  };
}

/*
  For the free version we create up to 3 clips.

  The algorithm selects evenly distributed sections.
  This is intentionally not pretending to be AI.

  Later, an AI transcript/highlight model can replace
  chooseSegments() without changing the frontend.
*/

function chooseSegments(duration) {
  if (duration <= 10) {
    return [];
  }

  const clipLength = Math.min(
    180,
    Math.max(60, Math.floor(duration / 3))
  );

  const maxClips = Math.min(
    3,
    Math.floor(duration / clipLength)
  );

  if (maxClips <= 0) {
    return [];
  }

  const segments = [];

  if (maxClips === 1) {
    segments.push({
      start: Math.max(0, (duration - clipLength) / 2),
      duration: clipLength
    });

    return segments;
  }

  const usable = duration - clipLength;

  for (let i = 0; i < maxClips; i++) {
    const start =
      maxClips === 1
        ? 0
        : (usable / (maxClips - 1)) * i;

    segments.push({
      start,
      duration: Math.min(clipLength, duration - start)
    });
  }

  return segments;
}

async function createClip(input, output, start, duration) {
  await runFFmpeg([
    "-y",

    "-ss",
    String(start),

    "-i",
    input,

    "-t",
    String(duration),

    "-map",
    "0:v:0",

    "-map",
    "0:a:0?",

    "-c:v",
    "libx264",

    "-preset",
    "veryfast",

    "-crf",
    "18",

    "-pix_fmt",
    "yuv420p",

    "-c:a",
    "aac",

    "-b:a",
    "192k",

    "-movflags",
    "+faststart",

    output
  ]);
}

app.post(
  "/api/create-clips",
  upload.single("video"),
  async (req, res) => {
    let input = null;

    try {
      if (!req.file) {
        return res.status(400).json({
          error: "Please upload a video."
        });
      }

      input = req.file.path;

      const info = await getVideoInfo(input);

      if (info.duration < 60) {
        return res.status(400).json({
          error: "The video should be at least 1 minute long."
        });
      }

      const segments = chooseSegments(info.duration);

      if (!segments.length) {
        return res.status(400).json({
          error: "Not enough video duration."
        });
      }

      const jobId = crypto.randomBytes(10).toString("hex");
      const jobDir = path.join(OUTPUT_DIR, jobId);

      fs.mkdirSync(jobDir, { recursive: true });

      const clips = [];

      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];

        const filename = `clip-${i + 1}.mp4`;
        const output = path.join(jobDir, filename);

        await createClip(
          input,
          output,
          segment.start,
          segment.duration
        );

        clips.push({
          id: i + 1,
          title: `Clip ${i + 1}`,
          start: Math.round(segment.start),
          duration: Math.round(segment.duration),
          url: `/output/${jobId}/${filename}`
        });
      }

      res.json({
        success: true,
        sourceDuration: Math.round(info.duration),
        clips
      });

      fs.unlink(input, () => {});
    } catch (error) {
      console.error(error);

      if (input) {
        fs.unlink(input, () => {});
      }

      res.status(500).json({
        error:
          error.message ||
          "Video processing failed."
      });
    }
  }
);

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        error: "Maximum video size is 500MB."
      });
    }

    return res.status(400).json({
      error: error.message
    });
  }

  res.status(400).json({
    error: error.message || "Request failed."
  });
});

app.get("*", (req, res) => {
  res.sendFile(
    path.join(PUBLIC_DIR, "index.html")
  );
});

app.listen(PORT, () => {
  console.log("");
  console.log("=================================");
  console.log("       CLIPFORGE IS RUNNING");
  console.log("=================================");
  console.log(`http://localhost:${PORT}`);
  console.log("");
});
