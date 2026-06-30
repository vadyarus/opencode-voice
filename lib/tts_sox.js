import { spawn } from "node:child_process";
import { platform } from "node:os";

const isWin = platform() === "win32";

export function playFile(filePath) {
  const args = isWin ? ["-q", filePath, "-t", "waveaudio"] : ["-q", filePath];
  return spawn("play", args, { stdio: "ignore" });
}

export function playWav(source) {
  const args = isWin ? ["-t", "wav", "-q", "-", "-t", "waveaudio"] : ["-t", "wav", "-q", "-"];
  const proc = spawn("play", args, {
    stdio: ["pipe", "ignore", "pipe"],
  });
  source.pipe(proc.stdin);
  return proc;
}

export function playRaw(source) {
  const args = isWin
    ? [
        "-t",
        "raw",
        "-r",
        "22050",
        "-e",
        "signed",
        "-b",
        "16",
        "-c",
        "1",
        "-q",
        "-",
        "-t",
        "waveaudio",
      ]
    : ["-t", "raw", "-r", "22050", "-e", "signed", "-b", "16", "-c", "1", "-q", "-"];
  const proc = spawn("play", args, {
    stdio: ["pipe", "ignore", "pipe"],
  });
  source.pipe(proc.stdin);
  return proc;
}
