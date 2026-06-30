import { spawn } from "node:child_process";

export function playFile(filePath) {
  return spawn("ffplay", ["-nodisp", "-autoexit", filePath], { stdio: "ignore" });
}

export function playWav(source) {
  const proc = spawn("ffplay", ["-nodisp", "-autoexit", "-f", "wav", "-i", "-"], {
    stdio: ["pipe", "ignore", "pipe"],
  });
  source.pipe(proc.stdin);
  return proc;
}

export function playRaw(source) {
  const proc = spawn(
    "ffplay",
    ["-nodisp", "-autoexit", "-f", "s16le", "-ar", "22050", "-ac", "1", "-i", "-"],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  source.pipe(proc.stdin);
  return proc;
}
