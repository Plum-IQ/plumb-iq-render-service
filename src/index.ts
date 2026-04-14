import * as fs from "fs";
import * as path from "path";
import express from "express";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { renderMediaOnLambda, speculateFunctionName } from "@remotion/lambda/client";

// Load .env manually (no dotenv dependency needed)
for (const envPath of [path.join(process.cwd(), ".env"), path.join(__dirname, "../.env")]) {
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, "utf8").split("\n").forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 1) return;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (key && !process.env[key]) process.env[key] = val;
    });
    console.log("Loaded env from", envPath);
    break;
  }
}

const app = express();
app.use(express.json());

const REGION = (process.env.AWS_REGION || "ap-southeast-2") as "ap-southeast-2";
const SERVE_URL = process.env.REMOTION_SERVE_URL!;
const MEMORY_SIZE = 3008;
const TIMEOUT = 900;
const DISK_SIZE = 2048;

const s3 = new S3Client({ region: REGION });

const FUNCTION_NAME = speculateFunctionName({
  memorySizeInMb: MEMORY_SIZE,
  timeoutInSeconds: TIMEOUT,
  diskSizeInMb: DISK_SIZE,
});

console.log("Function name:", FUNCTION_NAME);
console.log("Serve URL:", SERVE_URL);

app.post("/render", async (req, res) => {
  const {
    photos = [],
    audioUrl,
    videoUrl,
    musicUrl,
    transitionStyle,
    musicVolume = 0.05,
    overlays = [],
    durationInSeconds,
  } = req.body;

  // script mode requires photos + audioUrl; intro_video mode requires videoUrl
  if (!videoUrl && (!photos?.length || !audioUrl)) {
    return res.status(400).json({ error: "photos and audioUrl are required (or videoUrl for intro_video mode)" });
  }

  try {
    const result = await renderMediaOnLambda({
      region: REGION,
      functionName: FUNCTION_NAME,
      serveUrl: SERVE_URL,
      composition: "PlumbIQVideo",
      inputProps: { photos, audioUrl, videoUrl, musicUrl, transitionStyle, musicVolume, overlays, durationInSeconds },
      codec: "h264",
      imageFormat: "jpeg",
      privacy: "public",
      downloadBehavior: { type: "play-in-browser" },
      // intro_video mode = long video → fewer, larger chunks to stay under concurrency limits
      framesPerLambda: videoUrl ? 900 : 150,
      maxRetries: 1,
      concurrencyPerLambda: 1,
    });

    res.json({ renderId: result.renderId, bucketName: result.bucketName });
  } catch (err: any) {
    console.error("Render start error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Read progress.json directly from S3 — avoids invoking Lambda for status checks
app.get("/render/:renderId/status", async (req, res) => {
  const { renderId } = req.params;
  const bucketName = req.query.bucketName as string;

  if (!bucketName) return res.status(400).json({ error: "bucketName query param required" });

  try {
    const cmd = new GetObjectCommand({
      Bucket: bucketName,
      Key: `renders/${renderId}/progress.json`,
    });
    const s3res = await s3.send(cmd);
    const body = await s3res.Body!.transformToString();
    const progress = JSON.parse(body);

    console.log(`[render-status] renderId=${renderId} done=${progress.done} progress=${progress.overallProgress} errors=${progress.errors?.length}`);

    if (progress.errors?.length > 0 && progress.errors[0]?.isFatal) {
      return res.json({ status: "error", error: progress.errors[0].message });
    }

    if (progress.done || progress.postRenderData) {
      const outputUrl = progress.outputFile || progress.postRenderData?.outputFile;
      return res.json({ status: "done", outputUrl });
    }

    res.json({
      status: "rendering",
      progress: Math.round((progress.overallProgress || 0) * 100),
    });
  } catch (err: any) {
    // progress.json may not exist yet (render just started)
    if (err.name === "NoSuchKey") {
      return res.json({ status: "rendering", progress: 0 });
    }
    console.error("Render status error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Render service on port ${PORT}`));
