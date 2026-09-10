const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;

const uploadDir = path.join(__dirname, "uploads");
const outputDir = path.join(__dirname, "output");

fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(outputDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `video-${Date.now()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 500 * 1024 * 1024
  }
});

app.use(express.static(path.join(__dirname, "public")));
app.use("/output", express.static(outputDir));

app.post("/api/create-clips", upload.single("video"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      error: "Please upload a video."
    });
  }

  const input = req.file.path;
  const jobId = Date.now().toString();
  const jobDir = path.join(outputDir, jobId);

  fs.mkdirSync(jobDir, { recursive: true });

  // Create 3 clips.
  // Each clip is 150 seconds (2.5 minutes).
  const clipLength = 150;

  const clips = [];

  const createClip = (index) => {
    const start = index * clipLength;
    const filename = `clip-${index + 1}.mp4`;
    const output = path.join(jobDir, filename);

    execFile(
      "ffmpeg",
      [
        "-y",
        "-ss", String(start),
        "-i", input,
        "-t", String(clipLength),
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-c:a", "aac",
        "-movflags", "+faststart",
        output
      ],
      (error) => {
        if (error) {
          console.error(error);
          return res.status(500).json({
            error: "Video processing failed."
          });
        }

        clips.push({
          name: filename,
          url: `/output/${jobId}/${filename}`
        });

        if (clips.length === 3) {
          fs.unlink(input, () => {});

          return res.json({
            success: true,
            clips
          });
        }

        createClip(index + 1);
      }
    );
  };

  createClip(0);
});

app.listen(PORT, () => {
  console.log(`Clip Generator running on port ${PORT}`);
});
