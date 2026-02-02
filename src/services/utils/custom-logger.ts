import fs from "fs";
import path from "path";

const logsRoot = path.join(process.cwd(), "logs");
const sessionsRoot = path.join(logsRoot, "sessions");
const sessionDirs = new Map<string, string>();

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function getSessionDir(sessionId?: string): string {
  const id = sessionId && typeof sessionId === "string" ? sessionId : "default";
  const existing = sessionDirs.get(id);
  if (existing) return existing;
  const startedAt = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(sessionsRoot, `${startedAt}_${id}`);
  ensureDir(dir);
  sessionDirs.set(id, dir);
  return dir;
}

function appendLine(fileName: string, level: string, message: string, data?: unknown) {
  const ts = new Date().toISOString();
  const payload = data ? ` ${JSON.stringify(data)}` : "";
  const sessionId = (data as any)?.sessionId;
  const dir = getSessionDir(sessionId);
  const filePath = path.join(dir, fileName);
  fs.appendFileSync(filePath, `[${ts}] [${level}] ${message}${payload}\n`);
}

export function logLine(level: string, message: string, data?: unknown): void {
  appendLine("app.log", level, message, data);
}

export function logAgentLine(level: string, message: string, data?: unknown): void {
  appendLine("agent.log", level, message, data);
}

export function logLlmAgent(level: string, message: string, data?: unknown): void {
  appendLine("llm_agent_game.log", level, message, data);
}

export function logApiError(level: string, message: string, data?: unknown): void {
  appendLine("api_errors.log", level, message, data);
}
