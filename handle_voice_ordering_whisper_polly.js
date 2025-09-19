// server.js
import express from "express";
import { WebSocketServer } from "ws";
import bodyParser from "body-parser";
import { v4 as uuidv4 } from "uuid";
import os from "os";
import path from "path";
import fs from "fs";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import twilio from "twilio";
import { OpenAI } from "openai";
import { PollyClient, SynthesizeSpeechCommand } from "@aws-sdk/client-polly";
import { PassThrough, Readable } from "stream";

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const TWILIO_STREAM_URL = process.env.TWILIO_STREAM_URL; // optional override
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const AWS_REGION = process.env.AWS_REGION || "us-east-1";
if (!OPENAI_API_KEY) { console.error("Missing OPENAI_API_KEY"); process.exit(1); }

ffmpeg.setFfmpegPath(ffmpegStatic);

// ---------- Clients ----------
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const pollyClient = new PollyClient({ region: AWS_REGION });

// ---------- App ----------
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.get("/", (_, res) => res.send("Twilio Voice Ordering: OK"));

app.post("/voice", (req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();
  const streamUrl = TWILIO_STREAM_URL || `wss://${req.headers.host}/stream`;

  twiml.say("Welcome to the voice ordering system. Please speak after the beep.");
  const connect = twiml.connect();
  connect.stream({ url: streamUrl });

  res.type("text/xml").send(twiml.toString());
});

// ---------- HTTP + WS ----------
const server = app.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}`);
});
const wss = new WebSocketServer({ server, path: "/stream" });

// ---------- Order state ----------
function createEmptyOrderState() {
  return { items: [], address: null, contact: null, confirmed: false, finalized: false };
}
class OrderManager { constructor() { this.state = createEmptyOrderState(); } }

// ---------- Per-call store ----------
const calls = {}; // streamSid -> state

// ---------- VAD / endpointing (tuned) ----------
const VAD = {
  MIN_ACTIVITY_PER_FRAME: 0.10, // >=10% non-quiet bytes => active
  START_FRAMES: 3,              // ~60ms to start utterance
  END_FRAMES: 6,                // ~120ms quiet to end utterance
  MIN_UTTER_MS: 300,            // drop <300ms segments
  MAX_UTTER_MS: 6000            // hard cap 6s
};
function isMulawQuietByte(b) { return b === 0xFF || b === 0x7F; }
function mulawActivityRatio(buf) {
  if (!buf || buf.length === 0) return 0;
  let active = 0; for (let i = 0; i < buf.length; i++) if (!isMulawQuietByte(buf[i])) active++;
  return active / buf.length;
}
function isLikelySilenceMulaw(buf) {
  let quiet = 0; for (let i = 0; i < buf.length; i++) if (isMulawQuietByte(buf[i])) quiet++;
  return (quiet / Math.max(1, buf.length)) >= 0.90;
}
const FRAME_MS = 20;                 // Twilio frames are ~20ms
const ULawBytesPer20ms = 160;        // 8kHz * 0.02s * 1 byte/sample

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function cleanupCall(streamSid) {
  const c = calls[streamSid]; if (!c) return;
  try { if (c.ws && c.ws.readyState === 1) c.ws.close(); } catch {}
  delete calls[streamSid]; console.log("Cleaned up", streamSid);
}

// ---------- WS handling ----------
wss.on("connection", (ws) => {
  let streamSid = null;
  console.log("WS connected");

  ws.on("message", async (msg) => {
    let data; try { data = JSON.parse(msg.toString()); } catch { return; }

    if (data.event === "start") {
      streamSid = data.streamSid; ws.streamSid = streamSid;
      console.log("Stream started", streamSid);
      calls[streamSid] = {
        ws, streamSid,
        order: new OrderManager(),
        speaking: false,
        awaitingMark: null,
        pendingReply: false,
        lastTranscript: "",
        lastSpeakText: "",
        cancelTTS: null,
        bargeCooldownUntil: 0,
        vad: { inUtterance:false, voiceyStreak:0, quietStreak:0, utterStartTs:0, pendingFrames:[] }
      };
      return;
    }

    if (data.event === "media") {
      const call = calls[data.streamSid || ws.streamSid]; if (!call) return;
      const base64 = data.media?.payload; if (!base64) return;
      const raw = Buffer.from(base64, "base64");
      const activity = mulawActivityRatio(raw);
      const now = Date.now();

      // Barge-in: if speaking and caller active, cancel immediately
      if (call.speaking && activity >= VAD.MIN_ACTIVITY_PER_FRAME) {
        if (Date.now() >= call.bargeCooldownUntil) {
          if (typeof call.cancelTTS === "function") { try { call.cancelTTS(); } catch {} call.cancelTTS = null; }
          try { call.ws.send(JSON.stringify({ event: "clear", streamSid: call.streamSid })); } catch {}
          call.speaking = false; call.pendingReply = false; call.awaitingMark = null;
          call.bargeCooldownUntil = Date.now() + 250;
        } else {
          return; // short debounce
        }
      }
      if (call.speaking) return; // ignore while talking

      // VAD endpointing
      if (activity >= VAD.MIN_ACTIVITY_PER_FRAME) {
        call.vad.voiceyStreak++; call.vad.quietStreak = 0;
        if (!call.vad.inUtterance && call.vad.voiceyStreak >= VAD.START_FRAMES) {
          call.vad.inUtterance = true;
          call.vad.utterStartTs = now - (VAD.START_FRAMES - 1) * FRAME_MS;
          call.vad.pendingFrames.length = 0;
        }
        if (call.vad.inUtterance) call.vad.pendingFrames.push(base64);
      } else {
        call.vad.quietStreak++; call.vad.voiceyStreak = 0;
        if (call.vad.inUtterance) {
          call.vad.pendingFrames.push(base64);
          const durMs = now - call.vad.utterStartTs;
          const endByQuiet = call.vad.quietStreak >= VAD.END_FRAMES;
          const endByMax = durMs >= VAD.MAX_UTTER_MS;
          if (endByQuiet || endByMax) {
            const frames = call.vad.pendingFrames.splice(0);
            call.vad.inUtterance = false; call.vad.voiceyStreak = 0; call.vad.quietStreak = 0;
            if (durMs >= VAD.MIN_UTTER_MS) {
              handleAudioChunk(call.streamSid, frames).catch(err => console.error("Chunk error", err));
            }
          }
        }
      }
      return;
    }

    if (data.event === "mark") {
      const call = calls[data.streamSid || ws.streamSid]; if (!call) return;
      if (data.mark?.name && call.awaitingMark && data.mark.name === call.awaitingMark) {
        call.awaitingMark = null; // we do not rely on marks to flip speaking
      }
      return;
    }

    if (data.event === "stop") {
      const call = calls[data.streamSid || ws.streamSid];
      console.log("Stream stopped", data.streamSid);
      if (call) cleanupCall(call.streamSid);
      return;
    }
  });

  ws.on("close", () => { if (streamSid) cleanupCall(streamSid); });
});

// ---------- Audio chunk -> STT -> NLU -> TTS ----------
async function handleAudioChunk(streamSid, base64Frames) {
  const call = calls[streamSid]; if (!call) return;

  // Concatenate μ-law bytes
  const mulawBuf = Buffer.concat(base64Frames.map(b => Buffer.from(b, "base64")));

  // Pre-flight silence/size checks
  const minBytes = Math.floor((VAD.MIN_UTTER_MS / 1000) * 8000);
  if (mulawBuf.length < minBytes) return;
  if (mulawActivityRatio(mulawBuf) < 0.05) return;
  if (isLikelySilenceMulaw(mulawBuf)) return;

  // Convert μ-law/8k -> WAV PCM16/16k for Whisper (disk is fine; cost is small vs synth)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twilio-audio-"));
  const inRaw = path.join(tmpDir, `${uuidv4()}.ulaw`);
  const outWav = path.join(tmpDir, `${uuidv4()}.wav`);
  fs.writeFileSync(inRaw, mulawBuf);

  try {
    await new Promise((resolve, reject) => {
      ffmpeg(inRaw)
        .inputOptions(["-f mulaw", "-ar 8000", "-ac 1"])
        .audioChannels(1).audioFrequency(16000).audioCodec("pcm_s16le")
        .format("wav")
        .on("end", resolve).on("error", reject)
        .save(outWav);
    });
  } catch (e) {
    console.error("ffmpeg in->wav error:", e);
    try { fs.unlinkSync(inRaw); } catch {}
    try { fs.unlinkSync(outWav); } catch {}
    try { fs.rmdirSync(tmpDir); } catch {}
    return;
  }

  // STT
  let transcription = "";
  try {
    const fileStream = fs.createReadStream(outWav);
    const resp = await openai.audio.transcriptions.create({ file: fileStream, model: "whisper-1" });
    transcription = resp.text?.trim() ?? "";
    console.log("User said:", transcription);
  } catch (err) {
    console.error("STT error", err);
  } finally {
    try { fs.unlinkSync(inRaw); } catch {}
    try { fs.unlinkSync(outWav); } catch {}
    try { fs.rmdirSync(tmpDir); } catch {}
  }

  // Post STT guards
  const t = (transcription || "").trim();
  if (!t || t.length < 3) return;
  if (t === call.lastTranscript) return;
  if (call.pendingReply) return;
  call.lastTranscript = t;
  call.pendingReply = true;

  // NLU -> Assistant reply
  const reply = await processTranscriptionAndManageOrder(call, t);
  if (reply?.speak) {
    await respondWithTTS(call.streamSid, reply.speak).catch(e => {
      console.error("TTS error", e);
      call.speaking = false; call.pendingReply = false;
    });
  } else {
    call.pendingReply = false;
  }
}

async function processTranscriptionAndManageOrder(call, transcription) {
  const systemPrompt = `
You are an assistant that extracts food-order details from short customer utterances.
Maintain or update the order state (items with quantity and optional notes, address, contact).
If details are missing, ask only for what is necessary. If the user confirms, finalize the order.
Respond concisely for IVR playback. Return a JSON control object only.
`;

  const contextState = call.order.state;
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content:
      `Current state: ${JSON.stringify(contextState)}\n\n` +
      `User: "${transcription}"\n\n` +
      `Reply JSON only like: {"action":"update"|"ask"|"confirm"|"finalize", "order":{...}, "speak":"..."}`
    }
  ];

  let parsed = null;
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages, max_tokens: 220, temperature: 0.1
    });
    const raw = completion.choices?.[0]?.message?.content ?? "";
    const firstBrace = raw.indexOf("{");
    parsed = JSON.parse(firstBrace >= 0 ? raw.slice(firstBrace) : raw);
  } catch (err) {
    console.warn("LLM JSON parse error; raw fallback.", err);
    parsed = { action: "ask", order: contextState, speak: "Sorry, I didn't get that. Could you repeat your order?" };
  }

  if (parsed.action === "update" && parsed.order) {
    call.order.state = { ...call.order.state, ...parsed.order, confirmed: false };
    return { speak: parsed.speak || "Updated your order. Anything else?" };
  }
  if (parsed.action === "ask") {
    return { speak: parsed.speak || "Could you provide more details?" };
  }
  if (parsed.action === "confirm") {
    call.order.state = { ...call.order.state, ...parsed.order };
    return { speak: parsed.speak || "Please confirm your order." };
  }
  if (parsed.action === "finalize") {
    call.order.state = { ...call.order.state, ...parsed.order, finalized: true };
    console.log("FINAL ORDER", JSON.stringify(call.order.state, null, 2));
    return { speak: parsed.speak || "Your order is placed. Thank you!" };
  }
  return { speak: parsed.speak || "Okay. Anything else?" };
}

// ---------- TTS -> Twilio (streaming, framed & paced) ----------
async function respondWithTTS(streamSid, textToSpeak) {
  const call = calls[streamSid]; if (!call) return;

  // De-dupe replies
  if (textToSpeak && textToSpeak === call.lastSpeakText) { call.pendingReply = false; return; }
  call.lastSpeakText = textToSpeak;

  // Gate
  call.speaking = true;

  // Reset VAD buffer for a clean next turn
  call.vad.inUtterance = false; call.vad.voiceyStreak = 0; call.vad.quietStreak = 0; call.vad.pendingFrames.length = 0;

  // 1) Request Polly in PCM 8k (no MP3 decode)
  const pollyParams = { Text: textToSpeak, OutputFormat: "pcm", SampleRate: "8000", VoiceId: "Joanna" };
  const command = new SynthesizeSpeechCommand(pollyParams);
  const pollyResp = await pollyClient.send(command);

  // 2) Build a PassThrough and pipe Polly PCM → ffmpeg → μ-law
  const pcmIn = new PassThrough();
  (async () => { for await (const chunk of pollyResp.AudioStream) pcmIn.write(chunk); pcmIn.end(); })().catch(() => pcmIn.end());

  // 3) Abort control for barge-in
  let canceled = false; let ffmpegProc = null;
  call.cancelTTS = () => { canceled = true; try { ffmpegProc?.kill("SIGKILL"); } catch {} };

  // 4) ffmpeg: PCM s16le 8k → μ-law raw
  const ulawStream = ffmpeg(pcmIn)
    .inputOptions(["-f s16le", "-ar 8000", "-ac 1"])
    .audioChannels(1).audioFrequency(8000).audioCodec("pcm_mulaw")
    .format("mulaw")
    .on("start", (cp) => { ffmpegProc = cp; })
    .on("error", (err) => { if (!canceled) console.error("ffmpeg TTS error:", err); })
    .pipe();

  // 5) Frame to exact 160-byte / 20ms packets and pace
  let buffer = Buffer.alloc(0);
  let pacingTimer = null;
  const sendFrame = () => {
    if (canceled) return;
    if (buffer.length < ULawBytesPer20ms) return;
    const frame = buffer.subarray(0, ULawBytesPer20ms);
    buffer = buffer.subarray(ULawBytesPer20ms);
    try {
      call.ws.send(JSON.stringify({
        event: "media",
        streamSid: call.streamSid,
        media: { payload: frame.toString("base64") }
      }));
    } catch (e) { if (!canceled) console.error("send media error:", e); }
  };

  const startPacing = () => {
    if (pacingTimer) return;
    pacingTimer = setInterval(() => {
      // Send as many frames as we have to drain initial buffer quickly, but not too fast
      let sent = 0;
      while (sent < 2 && buffer.length >= ULawBytesPer20ms) { // allow slight catch-up
        sendFrame(); sent++;
      }
      if (buffer.length === 0 && ulawEnded) {
        clearInterval(pacingTimer); pacingTimer = null;
        finish();
      }
    }, FRAME_MS);
  };

  let ulawEnded = false;
  ulawStream.on("data", (chunk) => {
    if (canceled) return;
    buffer = Buffer.concat([buffer, chunk]);
    startPacing();
  });
  ulawStream.on("end", () => { ulawEnded = true; });

  const finish = () => {
    if (canceled) return;
    // Optional: send a mark for logs (we don't rely on it)
    const markName = `tts-done-${uuidv4()}`;
    call.awaitingMark = markName;
    try { call.ws.send(JSON.stringify({ event: "mark", streamSid: call.streamSid, mark: { name: markName } })); } catch {}

    // Release turn
    call.speaking = false; call.pendingReply = false;
    setTimeout(() => { call.lastSpeakText = ""; }, 900);
    call.cancelTTS = null;
  };

  // Safety: if canceled, flush state
  const cancelWatcher = async () => {
    while (!ulawEnded && !canceled) { await sleep(30); }
    if (canceled) {
      try { call.ws.send(JSON.stringify({ event: "clear", streamSid: call.streamSid })); } catch {}
      if (pacingTimer) { clearInterval(pacingTimer); pacingTimer = null; }
      call.speaking = false; call.pendingReply = false; call.cancelTTS = null;
    }
  };
  cancelWatcher();
}
