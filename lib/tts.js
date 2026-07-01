// Text-to-speech: LLM normalization, Piper synthesis, SSE-triggered TTS with temp file queue.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { getSessionTitle } from "./session.js";

const VOICES_DIR = path.join(os.homedir(), ".local", "share", "piper-voices");

const TTS_VOICES = {
  ryan: { label: "Ryan (high)", file: "en_US-ryan-high.onnx" },
  bryce: { label: "Bryce (medium)", file: "en_US-bryce-medium.onnx" },
};
const DEFAULT_TTS_VOICE = "ryan";

let ttsApiEndpoint = null;
let ttsApiKeyEnv = null;
let ttsApiModel = null;
let ttsDefaultVoice = "alloy";
let ttsInitPromise = null;

const DEFAULT_API_VOICES = [
  { value: "alloy", label: "Alloy" },
  { value: "echo", label: "Echo" },
  { value: "fable", label: "Fable" },
  { value: "onyx", label: "Onyx" },
  { value: "nova", label: "Nova" },
  { value: "shimmer", label: "Shimmer" },
];

let playerModule = null;

async function loadPlayer() {
  if (playerModule) return playerModule;
  try {
    execFileSync("play", ["--version"], { stdio: "ignore" });
    playerModule = await import("./tts_sox.js");
    return playerModule;
  } catch {}
  try {
    execFileSync("ffplay", ["-version"], { stdio: "ignore" });
    playerModule = await import("./tts_ffplay.js");
    return playerModule;
  } catch {}
  return null;
}

// ---- Session helpers ----

async function getTurnAssistantText(client, api) {
  const route = api.route.current;
  if (route.name !== "session") return null;

  const sessionID = route.params.sessionID;
  const stateMessages = api.state.session.messages(sessionID);
  if (!stateMessages || stateMessages.length === 0) return null;

  const assistantIDs = [];
  for (let i = stateMessages.length - 1; i >= 0; i--) {
    if (stateMessages[i].role === "user") break;
    if (stateMessages[i].role === "assistant") {
      assistantIDs.unshift(stateMessages[i].id);
    }
  }
  if (assistantIDs.length === 0) return null;

  const allText = [];
  for (const msgID of assistantIDs) {
    try {
      const fullMsg = await client.session
        .message({ sessionID, messageID: msgID }, { throwOnError: true })
        .then((r) => r.data);

      const textParts = (fullMsg?.parts || []).filter((p) => p.type === "text");
      const text = textParts
        .map((p) => p.text || "")
        .join("\n\n")
        .trim();
      if (text) allText.push(text);
    } catch {
      // Skip messages that fail to fetch
    }
  }

  if (allText.length === 0) return null;

  return {
    lastMessageID: assistantIDs[assistantIDs.length - 1],
    text: allText.join("\n\n"),
  };
}

// ---- Public API for TUI plugin ----

export function registerTTS(api, kv, complete, prompts, opts, logger) {
  const client = api.client;

  const AUTO_PROMPT_PATH = new URL("../prompts/tts-auto.md", import.meta.url);
  const MANUAL_PROMPT_PATH = new URL("../prompts/tts-manual.md", import.meta.url);

  function loadDefaultPrompt(url, name) {
    try {
      return fs.readFileSync(url, "utf-8").trim();
    } catch {
      logger?.log?.("TTS", `Failed to load bundled ${name} prompt`, "error");
      return null;
    }
  }

  const systemAuto = prompts?.ttsAuto || loadDefaultPrompt(AUTO_PROMPT_PATH, "auto");
  const systemManual = prompts?.ttsManual || loadDefaultPrompt(MANUAL_PROMPT_PATH, "manual");

  if (opts?.ttsEndpoint) {
    ttsApiEndpoint = opts.ttsEndpoint;
    ttsApiKeyEnv = opts.ttsApiKeyEnv || null;
    if (opts.ttsModel) ttsApiModel = opts.ttsModel;
    logger?.log?.("TTS", `Configured API endpoint=${ttsApiEndpoint}`, "debug");
    ttsInitPromise = initApiTts().catch(() => {});
  }

  async function initApiTts() {
    const url = ttsApiEndpoint.replace(/\/+$/, "") + "/voices";
    const headers = {};
    if (ttsApiKeyEnv && process.env[ttsApiKeyEnv]) {
      headers["Authorization"] = "Bearer " + process.env[ttsApiKeyEnv];
    }
    try {
      const resp = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
      if (resp.ok) {
        const data = await resp.json();
        const raw = Array.isArray(data) ? data : data?.data;
        if (Array.isArray(raw) && raw.length > 0) {
          const first = raw.find(Boolean);
          if (first) {
            if (!ttsApiModel && first.model) ttsApiModel = first.model;
            ttsDefaultVoice =
              first.voice_id ?? first.id ?? first.value ?? first.name ?? ttsDefaultVoice;
          }
        }
      }
    } catch (err) {
      logger?.log?.("TTS", `API TTS init failed: ${err.message}`, "warn");
    }
  }

  function toast(message, variant = "info") {
    api.ui.toast({ message, variant, duration: 3000 });
  }

  function getVoiceModel() {
    const voice = kv.get("tts.voice", DEFAULT_TTS_VOICE);
    const entry = TTS_VOICES[voice] || TTS_VOICES[DEFAULT_TTS_VOICE];
    return path.join(VOICES_DIR, entry.file);
  }

  function piperOnPath() {
    const pathDirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
    return pathDirs.some((dir) => fs.existsSync(path.join(dir, "piper")));
  }

  async function normalizeForSpeech(text, systemPrompt) {
    logger?.log?.("TTS", `Normalizing speech chars=${text.length}`, "debug");
    return complete({
      system: systemPrompt,
      prompt: `Convert for text-to-speech:\n\n${text}`,
      config: { maxTokens: 4096 },
    });
  }

  // ---- Audio pipeline ----

  let piperProc = null;
  let playProc = null;
  let playbackQueue = [];
  let isPlaying = false;

  function cleanupQueue() {
    for (const f of playbackQueue) {
      try {
        fs.unlinkSync(f);
      } catch {}
    }
    playbackQueue.length = 0;
    isPlaying = false;
  }

  function killProcs() {
    if (piperProc) {
      try {
        piperProc.kill("SIGKILL");
      } catch {}
      piperProc = null;
    }
    if (playProc) {
      try {
        playProc.kill("SIGKILL");
      } catch {}
      playProc = null;
    }
    cleanupQueue();
  }

  async function processQueue() {
    if (isPlaying || playbackQueue.length === 0) return;
    isPlaying = true;
    let filePlayer;
    try {
      execFileSync("ffplay", ["-version"], { stdio: "ignore" });
      filePlayer = await import("./tts_ffplay.js");
    } catch {
      filePlayer = await loadPlayer();
    }
    if (!filePlayer) {
      logger?.log?.("TTS", `No audio player found (install ffplay or sox)`, "error");
      toast(`No audio player found — install ffplay or sox`, "error");
      isPlaying = false;
      return;
    }
    while (playbackQueue.length > 0) {
      const filePath = playbackQueue.shift();
      await new Promise((resolve) => {
        playProc = filePlayer.playFile(filePath);
        playProc.on("close", () => {
          playProc = null;
          try {
            fs.unlinkSync(filePath);
          } catch {}
          resolve();
        });
        playProc.on("error", () => {
          playProc = null;
          try {
            fs.unlinkSync(filePath);
          } catch {}
          resolve();
        });
      });
    }
    isPlaying = false;
  }

  async function speak(text, sessionID) {
    if (!text) return;
    const line = text.replace(/\n/g, " ").trim();
    if (!line) return;

    killProcs();

    if (ttsApiEndpoint) {
      return speakViaSse(line, sessionID);
    }

    const voiceModel = getVoiceModel();
    logger?.log?.("TTS", `Speak requested chars=${line.length} voice=${voiceModel}`, "debug");
    if (!piperOnPath()) {
      logger?.log?.("TTS", `Piper binary not found on PATH`, "warn");
      toast(`Piper binary not found on PATH`, "warning");
      return;
    }
    if (!fs.existsSync(voiceModel)) {
      logger?.log?.("TTS", `Voice model not found: ${voiceModel}`, "warn");
      toast(`Voice model not found: ${voiceModel}`, "warning");
      return;
    }

    const player = await loadPlayer();
    if (!player) {
      logger?.log?.("TTS", `No audio player found (install ffplay or sox)`, "error");
      toast(`No audio player found — install ffplay or sox`, "error");
      return;
    }

    return new Promise((resolve) => {
      let piperStderr = "";
      let playStderr = "";

      piperProc = spawn("piper", ["-m", voiceModel, "--output_raw"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      playProc = player.playRaw(piperProc.stdout);

      piperProc.stderr.on("data", (chunk) => {
        piperStderr += chunk.toString();
      });
      playProc.stderr.on("data", (chunk) => {
        playStderr += chunk.toString();
      });

      piperProc.on("close", (code) => {
        if (code !== 0 && code !== null) {
          logger?.log?.("TTS", `piper exited code=${code} stderr=${piperStderr.trim()}`, "error");
        }
      });

      playProc.on("close", (code) => {
        if (code !== 0 && code !== null) {
          logger?.log?.("TTS", `play exit code=${code} stderr=${playStderr.trim()}`, "error");
        } else {
          logger?.log?.("TTS", "playback finished", "debug");
        }
        piperProc = null;
        playProc = null;
        resolve();
      });

      piperProc.on("error", (err) => {
        logger?.log?.("TTS", `piper error: ${err.message}`, "error");
        killProcs();
        resolve();
      });
      playProc.on("error", (err) => {
        logger?.log?.("TTS", `play error: ${err.message}`, "error");
        killProcs();
        resolve();
      });

      if (piperProc?.stdin && !piperProc.stdin.destroyed) {
        piperProc.stdin.write(line + "\n");
        piperProc.stdin.end();
      }
    });
  }

  async function speakViaSse(text, sessionID) {
    if (ttsInitPromise) await ttsInitPromise;
    const model = kv.get("tts.api.model", ttsApiModel || "tts-1");
    const voice = kv.get("tts.api.voice", ttsDefaultVoice);
    const apiKey = ttsApiKeyEnv ? process.env[ttsApiKeyEnv] : null;

    const url = ttsApiEndpoint.replace(/\/+$/, "") + "/audio/speech";

    try {
      logger?.log?.("TTS", `SSE TTS voice=${voice} model=${model} chars=${text.length}`, "debug");

      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: "Bearer " + apiKey } : {}),
          ...(sessionID ? { "X-Session-Id": sessionID } : {}),
        },
        body: JSON.stringify({
          model,
          input: text,
          voice,
          response_format: "wav",
          stream_format: "sse",
        }),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        logger?.log?.("TTS", `SSE TTS error ${resp.status}: ${errText}`, "error");
        toast(`TTS API error (${resp.status})`, "error");
        return;
      }

      const ts = Date.now();
      let sseBuf = "";
      const decoder = new TextDecoder();
      const reader = resp.body.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuf += decoder.decode(value, { stream: true });
        const parts = sseBuf.split("\n\n");
        sseBuf = parts.pop() || "";

        for (const part of parts) {
          if (!part.trim()) continue;
          const lines = part.split("\n");
          let event = "";
          let rawData = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) event = line.slice(7);
            else if (line.startsWith("data: ")) rawData = line.slice(6);
          }
          if (!rawData) continue;

          try {
            const data = JSON.parse(rawData);

            if (event === "chunk") {
              const wavBytes = Buffer.from(data.audio, "base64");
              const chunkPath = path.join(os.tmpdir(), `tts-${ts}-${data.index}.wav`);
              fs.writeFileSync(chunkPath, wavBytes);
              playbackQueue.push(chunkPath);
              processQueue();
              logger?.log?.(
                "TTS",
                `SSE chunk ${data.index}/${data.total} (${wavBytes.length} bytes)`,
                "debug",
              );
            } else if (event === "done") {
              logger?.log?.("TTS", `SSE done`, "debug");
            } else if (event === "progress") {
              logger?.log?.("TTS", `SSE progress: ${data.message}`, "debug");
            } else if (event === "error") {
              logger?.log?.("TTS", `SSE error: ${data.message}`, "error");
              toast(`TTS error: ${data.message}`, "error");
            }
          } catch (parseErr) {
            logger?.log?.("TTS", `SSE parse error: ${parseErr.message}`, "error");
          }
        }
      }
    } catch (err) {
      logger?.log?.("TTS", `SSE request failed: ${err.message}`, "error");
      toast(`TTS SSE failed: ${err.message}`, "error");
    }
  }

  // ---- Session-prefixed announcements ----

  async function speakWithSessionPrefix(sessionID, message, suffix) {
    const sessionTitle = await getSessionTitle(client, sessionID);
    const parts = [];
    if (sessionTitle) parts.push(`Session: ${sessionTitle}.`);
    parts.push(message);
    if (suffix) parts.push(suffix);
    await speak(parts.join(" "), sessionID);
  }

  function stopSpeech() {
    const wasPlaying = piperProc !== null || playProc !== null || playbackQueue.length > 0;
    killProcs();
    return wasPlaying;
  }

  async function getApiVoices() {
    try {
      const url = ttsApiEndpoint.replace(/\/+$/, "") + "/voices";
      const headers = {};
      if (ttsApiKeyEnv && process.env[ttsApiKeyEnv]) {
        headers["Authorization"] = "Bearer " + process.env[ttsApiKeyEnv];
      }
      const resp = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
      if (resp.ok) {
        const data = await resp.json();
        const raw = Array.isArray(data) ? data : data?.data;
        if (Array.isArray(raw) && raw.length > 0) {
          const valid = raw
            .filter(Boolean)
            .map((v) => ({
              value: v.value ?? v.voice_id ?? v.id ?? v.name ?? "",
              label:
                v.label ??
                v.name ??
                v.description ??
                v.display_name ??
                v.value ??
                v.voice_id ??
                v.id ??
                "",
            }))
            .filter((v) => v.value && v.label);
          if (valid.length > 0) return valid;
        }
      }
    } catch (err) {
      logger?.log?.("TTS", `Failed to fetch voices: ${err.message}`, "warn");
    }
    return DEFAULT_API_VOICES;
  }

  // ---- Auto mode ----

  let lastSpokenMessageID = null;
  let wasBusy = false;

  api.event.on("session.status", (event) => {
    if (event.properties?.status?.type === "busy") wasBusy = true;
  });

  api.event.on("session.idle", async (event) => {
    if (kv.get("tts.mode", "off") !== "on") return;
    if (!wasBusy) return;
    wasBusy = false;

    const sessionID = event.properties?.sessionID;
    const result = await getTurnAssistantText(client, api);
    if (!result || !result.text) return;

    if (result.lastMessageID === lastSpokenMessageID) return;
    lastSpokenMessageID = result.lastMessageID;

    toast("Normalizing response...");
    const llmResult = await normalizeForSpeech(result.text, systemAuto);
    if (!llmResult.text) {
      logger?.log?.("TTS", `Auto normalization failed: ${llmResult.error}`, "warn");
      toast(`TTS normalization failed: ${llmResult.error}`, "warning");
      return;
    }

    logger?.log?.("TTS", `Auto normalization succeeded chars=${llmResult.text.length}`, "debug");
    await speakWithSessionPrefix(sessionID, llmResult.text, "Ready for your input.");
  });

  api.event.on("permission.asked", async (event) => {
    if (kv.get("tts.mode", "off") !== "on") return;
    await speakWithSessionPrefix(
      event.properties?.sessionID,
      "Permission requested. Please check your screen.",
    );
  });

  api.event.on("question.asked", async (event) => {
    if (kv.get("tts.mode", "off") !== "on") return;
    await speakWithSessionPrefix(
      event.properties?.sessionID,
      "A question needs your answer. Please check your screen.",
    );
  });

  // ---- Manual mode ----

  async function speakLastResponse() {
    const result = await getTurnAssistantText(client, api);
    if (!result || !result.text) {
      toast("No assistant response to speak", "warning");
      return;
    }

    const route = api.route.current;
    const sessionID = route.name === "session" ? route.params.sessionID : null;

    toast("Normalizing response...");
    const llmResult = await normalizeForSpeech(result.text, systemManual);
    if (!llmResult.text) {
      logger?.log?.("TTS", `Manual normalization failed: ${llmResult.error}`, "warn");
      toast(`TTS normalization failed: ${llmResult.error}`, "warning");
      return;
    }

    logger?.log?.("TTS", `Manual normalization succeeded chars=${llmResult.text.length}`, "debug");
    toast("Speaking last response");
    await speak(llmResult.text, sessionID);
  }

  // ---- Commands ----

  return [
    {
      title: "TTS: speak last response",
      value: "tts.speak-last",
      description: "Read the last assistant response aloud (detailed)",
      keybind: "<leader>s",
      slash: { name: "tts-speak" },
      onSelect() {
        speakLastResponse();
      },
    },
    {
      title: "TTS: toggle",
      value: "tts.mode",
      description: "Toggle auto text-to-speech on/off",
      keybind: "<leader>v",
      slash: { name: "tts-mode" },
      onSelect() {
        const current = kv.get("tts.mode", "off");
        const next = current === "on" ? "off" : "on";
        kv.set("tts.mode", next);
        if (next === "off") stopSpeech();
        const backend = ttsApiEndpoint ? "API" : "Piper";
        const voice = ttsApiEndpoint
          ? kv.get("tts.api.voice", ttsDefaultVoice)
          : (TTS_VOICES[kv.get("tts.voice", DEFAULT_TTS_VOICE)] || TTS_VOICES[DEFAULT_TTS_VOICE])
              .label;
        toast(next === "on" ? `TTS on (${backend}: ${voice})` : "TTS off");
      },
    },
    {
      title: "TTS: stop playback",
      value: "tts.stop",
      description: "Stop current TTS playback",
      keybind: "escape",
      slash: { name: "tts-stop" },
      onSelect() {
        if (stopSpeech()) toast("TTS stopped");
      },
    },
    {
      title: ttsApiEndpoint ? "TTS: select voice (API)" : "TTS: select voice",
      value: "tts.voice",
      description: ttsApiEndpoint ? "Choose TTS voice via API" : "Choose TTS voice",
      slash: { name: "tts-voice" },
      async onSelect() {
        if (ttsApiEndpoint) {
          try {
            if (ttsInitPromise) await ttsInitPromise;
            const current = kv.get("tts.api.voice", ttsDefaultVoice);
            const voices = (await getApiVoices()) || DEFAULT_API_VOICES;
            if (!Array.isArray(voices) || voices.length === 0) return;
            api.ui.dialog.replace(() =>
              api.ui.DialogSelect({
                title: "Select voice (API)",
                current,
                options: voices.map((v) => ({
                  title: v.label,
                  value: v.value,
                  onSelect() {
                    kv.set("tts.api.voice", v.value);
                    toast(`TTS voice: ${v.label}`);
                    api.ui.dialog.clear();
                  },
                })),
              }),
            );
          } catch (err) {
            logger?.log?.("TTS", `Voice selection error: ${err.message}`, "error");
          }
        } else {
          const current = kv.get("tts.voice", DEFAULT_TTS_VOICE);
          api.ui.dialog.replace(() =>
            api.ui.DialogSelect({
              title: "Select voice",
              current,
              options: Object.entries(TTS_VOICES).map(([key, v]) => ({
                title: v.label,
                value: key,
                onSelect() {
                  kv.set("tts.voice", key);
                  toast(`Voice: ${v.label}`);
                  api.ui.dialog.clear();
                },
              })),
            }),
          );
        }
      },
    },
  ];
}
