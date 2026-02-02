import fs from "fs";
import path from "path";
import OpenAI from "openai";
import { z } from "zod";
import { logApiError, logLine, logLlmAgent } from "../utils/custom-logger";
import {
  Action,
  ActionMove,
  ActionSurfaceOps,
  ActionUpgrade,
  Direction,
  FuelNavigatorPayload,
  PlanResponse,
  SessionMemory,
  State,
  UpgradeKind
} from "../../models/data-flow-models";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const API_BASE_URL = process.env.OPENROUTER_API_BASE_URL || "https://openrouter.ai/api/v1";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "moonshotai/kimi-k2.5";
const MAX_PLANS_PER_SESSION = Number(process.env.MAX_PLANS_PER_SESSION || 0);
const OPENROUTER_TIMEOUT_MS = Number(process.env.OPENROUTER_TIMEOUT_MS || 20000);
const MIN_REQUEST_GAP_MS = 500;
const MAX_COMPLETION_TOKENS = Number(process.env.MAX_COMPLETION_TOKENS || 200);
const REASONING_EFFORT = (process.env.REASONING_EFFORT || "low").toLowerCase();
const REASONING_EFFORT_SAFE = REASONING_EFFORT === "high" ? "high" : REASONING_EFFORT === "medium" ? "medium" : "low";

export function getOpenRouterModel(): string {
  return OPENROUTER_MODEL;
}

const client = new OpenAI({
  baseURL: API_BASE_URL,
  apiKey: OPENROUTER_API_KEY
});

const systemPromptPath = path.join(process.cwd(), "prompts", "system_prompt.txt");
const systemPrompt = fs.readFileSync(systemPromptPath, "utf8");
const sessionLogsRoot = path.join(process.cwd(), "logs", "sessions");

const exampleUserMessage =
  "Example user input (game state):\n" +
  JSON.stringify({
    planLength: 3,
    state: {
      turn: 5,
      pos: { x: 6, y: 3, depth: 3 },
      fuel: { cur: 18, max: 30 },
      hull: { cur: 28, max: 30 },
      cargo: { cur: 4, cap: 12 },
      money: 80,
      atSurface: false,
      atFuelStation: false,
      atUpgradeShop: false,
      drill: 1.0,
      goal: { x: 6, y: 24, mined: false },
      localScan: ["......", "..dd..", "..do..", "..d...", "......", "......"],
      rules: {
        noDigUp: false,
        upRequiresAir: false,
        lavaDamage: 8,
        baseTurnFuel: 1
      }
    },
    memory: {
      knownWindow: ["????", "????", "????", "????"],
      visitedTail: [],
      bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 }
    },
    scanTiles: [{ x: 6, y: 3, t: "d" }],
    knownTiles: [{ x: 6, y: 3, t: "d" }],
    fuelHint: {
      stationX: 6,
      returnDx: 0,
      returnDy: 2,
      estReturnFuel: 8,
      buffer: 6,
      fuelCur: 18,
      fuelMax: 30,
      shouldReturn: false,
      turnsLeftMax: 18,
      turnsLeftAir: 9,
      turnsLeftDig: 6,
      turnsLeftProbable: 6
    }
  });

const exampleAssistantOutput = [
  "Example output (exact format):",
  "<self_reflection>",
  "Start: Fuel 18, Pos (6,3).",
  "Plan: D(dig), D(dig), R(air).",
  "Calc:",
  "1. D -> (6,4) Cost 3 (Fuel 15)",
  "2. D -> (6,5) Cost 3 (Fuel 12)",
  "3. R -> (7,5) Cost 1.5 (Fuel 10.5)",
  "Result: Ends at (7,5) with Fuel 10.5. Safe.",
  "</self_reflection>",
  "<action_to_take>Dig down twice to reach dirt/ore, then move right into the air pocket.</action_to_take>",
  "<execution>MOVE:D MOVE:D MOVE:R</execution>"
].join("\n");

let lastRequestAt = 0;
let planCount = 0;

const sessions = new Map<string, SessionMemory>();

function hasKeys(obj: unknown, keys: string[]): obj is Record<string, unknown> {
  return Boolean(obj) && keys.every((k) => Object.prototype.hasOwnProperty.call(obj, k));
}

export function validateState(state: unknown): state is State {
  if (!state || typeof state !== "object") return false;
  if (!hasKeys(state, ["turn", "pos", "fuel", "hull", "cargo", "money", "localScan"])) return false;
  const s = state as Record<string, unknown>;
  const pos = s.pos as Record<string, unknown> | undefined;
  const fuel = s.fuel as Record<string, unknown> | undefined;
  const hull = s.hull as Record<string, unknown> | undefined;
  const cargo = s.cargo as Record<string, unknown> | undefined;
  return (
    Boolean(pos && hasKeys(pos, ["x", "y", "depth"])) &&
    Boolean(fuel && hasKeys(fuel, ["cur", "max"])) &&
    Boolean(hull && hasKeys(hull, ["cur", "max"])) &&
    Boolean(cargo && hasKeys(cargo, ["cur", "cap"]))
  );
}

function planActions(state: State, planLength: number): Action[] {
  const actions: Action[] = [];
  const n = Math.max(1, Math.min(10, planLength || 1));

  for (let i = 0; i < n; i++) {
    if (state.atFuelStation && (state.cargo.cur > 0 || state.fuel.cur < state.fuel.max)) {
      actions.push({ type: "SURFACE_OPS", reason: "Refuel and cash in at station." });
      continue;
    }
    if (state.atUpgradeShop && state.money >= 150) {
      actions.push({ type: "UPGRADE", kind: "FUEL", reason: "Buying fuel upgrade." });
      continue;
    }
    actions.push({ type: "MOVE", dir: "D", reason: "Server plan: move down." });
  }
  return actions;
}

function sanitizeActions(actions: Action[] | undefined, planLength: number): Action[] {
  const out: Action[] = [];
  const max = Math.max(1, Math.min(10, planLength || 1));
  const dirSet = new Set<Direction>(["L", "R", "U", "D"]);
  const kindSet = new Set<UpgradeKind>(["FUEL", "CARGO", "HULL", "DRILL"]);

  for (const a of actions || []) {
    if (out.length >= max) break;
    if (!a || typeof a.type !== "string") continue;

    if (a.type === "MOVE") {
      const dir = dirSet.has((a as ActionMove).dir) ? (a as ActionMove).dir : "D";
      out.push({ type: "MOVE", dir, reason: a.reason || "Fallback move." });
      continue;
    }
    if (a.type === "UPGRADE") {
      const kind = kindSet.has((a as ActionUpgrade).kind) ? (a as ActionUpgrade).kind : "FUEL";
      out.push({ type: "UPGRADE", kind, reason: a.reason || "Fallback upgrade." });
      continue;
    }
    if (a.type === "SURFACE_OPS") {
      out.push({ type: "SURFACE_OPS", reason: a.reason || "Fallback surface ops." });
      continue;
    }
  }
  return out.length
    ? out
    : planActions(
        { atFuelStation: false, atUpgradeShop: false, fuel: { cur: 1, max: 1 }, cargo: { cur: 0, cap: 0 }, money: 0, pos: { x: 0, y: 0, depth: 0 }, hull: { cur: 1, max: 1 }, localScan: [], turn: 0 },
        max
      );
}

function getSession(sessionId?: string): SessionMemory {
  const id = sessionId || "default";
  let s = sessions.get(id);
  if (!s) {
    const startedAt = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = path.join(sessionLogsRoot, `${startedAt}_${id}`);
    fs.mkdirSync(dir, { recursive: true });
    s = {
      id,
      known: new Map(),
      visited: [],
      bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 },
      sessionDir: dir,
      history: [],
      fuelRuns: 0,
      lastAtStation: false
    };
    sessions.set(id, s);
  }
  return s;
}

function updateMemory(session: SessionMemory, state: State) {
  if (!state.pos || !Array.isArray(state.localScan)) return;
  const baseX = state.pos.x - 2;
  const baseY = state.pos.y - 2;
  for (let ry = 0; ry < state.localScan.length; ry++) {
    const row = state.localScan[ry];
    if (typeof row !== "string") continue;
    for (let rx = 0; rx < row.length; rx++) {
      const t = row[rx];
      const gx = baseX + rx;
      const gy = baseY + ry;
      const key = `${gx},${gy}`;
      session.known.set(key, t);
      if (session.known.size === 1) {
        session.bounds = { minX: gx, maxX: gx, minY: gy, maxY: gy };
      } else {
        session.bounds.minX = Math.min(session.bounds.minX, gx);
        session.bounds.maxX = Math.max(session.bounds.maxX, gx);
        session.bounds.minY = Math.min(session.bounds.minY, gy);
        session.bounds.maxY = Math.max(session.bounds.maxY, gy);
      }
    }
  }

  session.visited.push({ x: state.pos.x, y: state.pos.y, turn: state.turn });
  if (session.visited.length > 50) session.visited.shift();
}

function buildMemoryWindow(session: SessionMemory, state: State, size = 12) {
  const half = Math.floor(size / 2);
  const startX = state.pos.x - half;
  const startY = state.pos.y - half;
  const rows: string[] = [];
  for (let y = 0; y < size; y++) {
    let row = "";
    for (let x = 0; x < size; x++) {
      const gx = startX + x;
      const gy = startY + y;
      const key = `${gx},${gy}`;
      row += session.known.get(key) || "?";
    }
    rows.push(row);
  }
  return rows;
}

function extractTaggedText(text: string, tagName: string): string | null {
  if (typeof text !== "string") return null;
  const pattern = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, "i");
  const match = text.match(pattern);
  return match ? match[1].trim() : null;
}

function extractExecutionText(text: string): string | null {
  const full = extractTaggedText(text, "execution");
  if (full) return full;
  if (typeof text !== "string") return null;
  const openTag = /<execution>([\s\S]*)$/i;
  const match = text.match(openTag);
  return match ? match[1].trim() : null;
}

function parseDirections(text: string): Direction[] {
  if (typeof text !== "string") return [];
  const matches = text.toUpperCase().match(/[UDLR]/g);
  return (matches || []) as Direction[];
}

function formatValidationError(executionText: string | null, planLength: number) {
  return [
    "Your last response did not format the <execution> block correctly.",
    `Current <execution> content: ${executionText ? JSON.stringify(executionText) : "<missing>"}`,
    "Required format:",
    `- <execution> must contain 1 to ${planLength} action tokens separated by spaces.`,
    "- Token formats: MOVE:U|MOVE:D|MOVE:L|MOVE:R, SURFACE_OPS, UPGRADE:FUEL|CARGO|HULL|DRILL.",
    "- Example: <execution>MOVE:D MOVE:D MOVE:L</execution>"
  ].join("\n");
}

function parseActionTokens(executionText: string): Action[] {
  const tokens = executionText.trim().split(/\s+/).filter(Boolean);
  const actions: Action[] = [];
  for (const raw of tokens) {
    const t = raw.trim().toUpperCase();
    if (t === "SURFACE_OPS") {
      actions.push({ type: "SURFACE_OPS", reason: "Planned action." });
      continue;
    }
    if (t.startsWith("UPGRADE:")) {
      const kind = t.split(":", 2)[1] as UpgradeKind;
      actions.push({ type: "UPGRADE", kind, reason: "Planned action." });
      continue;
    }
    if (t.startsWith("MOVE:")) {
      const dir = t.split(":", 2)[1] as Direction;
      actions.push({ type: "MOVE", dir, reason: "Planned action." });
      continue;
    }
  }
  return actions;
}

function validateExecution(executionText: string, planLength: number) {
  const tokens = executionText.trim().split(/\s+/).filter(Boolean);
  const tokenSchema = z.union([
    z.literal("SURFACE_OPS"),
    z.string().regex(/^MOVE:(U|D|L|R)$/),
    z.string().regex(/^UPGRADE:(FUEL|CARGO|HULL|DRILL)$/)
  ]);
  const schema = z.array(tokenSchema).min(1).max(planLength);
  const result = schema.safeParse(tokens.map((t) => t.toUpperCase()));
  return { result, tokens };
}

function buildScanTiles(state: State) {
  if (!state.pos || !Array.isArray(state.localScan)) return [];
  const baseX = state.pos.x - 2;
  const baseY = state.pos.y - 2;
  const tiles: Array<{ x: number; y: number; t: string }> = [];
  for (let ry = 0; ry < state.localScan.length; ry++) {
    const row = state.localScan[ry];
    if (typeof row !== "string") continue;
    for (let rx = 0; rx < row.length; rx++) {
      const t = row[rx];
      if (t === ".") continue;
      tiles.push({ x: baseX + rx, y: baseY + ry, t });
    }
  }
  return tiles;
}

function buildFuelHint(state: State) {
  if (!state.pos || !state.fuel) return null;
  const stationX = state.stations?.fuel?.x ?? 6;
  const returnDy = Math.max(0, state.pos.y - 1);
  const returnDx = Math.abs(state.pos.x - stationX);
  const baseTurnFuel = state.rules?.baseTurnFuel ?? 1;
  const upThrustFuel = 2;
  const airMoveFuel = 0.5;
  const digFuel =
    typeof (state.rules as any)?.digFuelBase?.dirt === "number"
      ? (state.rules as any).digFuelBase.dirt
      : 2;
  const lavaDigFuel =
    typeof (state.rules as any)?.digFuelBase?.lava === "number"
      ? (state.rules as any).digFuelBase.lava
      : 3;
  const verticalCost = baseTurnFuel + upThrustFuel;
  const horizontalCost = baseTurnFuel + (state.pos.y > 1 ? (digFuel + 1) : airMoveFuel);
  const estReturnFuel = returnDy * verticalCost + returnDx * horizontalCost;
  const buffer = 8;
  const safeBase = Math.max(1, baseTurnFuel);
  const safeAir = Math.max(1, baseTurnFuel + airMoveFuel);
  const safeDig = Math.max(1, baseTurnFuel + digFuel + 1);
  const safeUpThrust = Math.max(1, baseTurnFuel + upThrustFuel);
  const safeWorst = Math.max(1, baseTurnFuel + lavaDigFuel + 1);
  const turnsLeftMax = Math.floor(state.fuel.cur / safeBase);
  const turnsLeftAir = Math.floor(state.fuel.cur / safeAir);
  const turnsLeftDig = Math.floor(state.fuel.cur / safeDig);
  const turnsLeftProbable = turnsLeftDig;
  const turnsLeftUp = Math.floor(state.fuel.cur / safeUpThrust);
  const turnsLeftWorst = Math.floor(state.fuel.cur / safeWorst);
  return {
    stationX,
    returnDx,
    returnDy,
    estReturnFuel,
    buffer,
    fuelCur: state.fuel.cur,
    fuelMax: state.fuel.max,
    shouldReturn: state.fuel.cur <= estReturnFuel + buffer,
    turnsLeftMax,
    turnsLeftAir,
    turnsLeftDig,
    turnsLeftProbable,
    turnsLeftUp,
    turnsLeftWorst
  };
}

function buildKnownTiles(session: SessionMemory, limit = 400) {
  const tiles: Array<{ x: number; y: number; t: string }> = [];
  for (const [key, t] of session.known.entries()) {
    if (t === "." || t === "?") continue;
    const [xStr, yStr] = key.split(",");
    const x = Number(xStr);
    const y = Number(yStr);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      tiles.push({ x, y, t });
    }
  }
  if (tiles.length > limit) {
    tiles.sort((a, b) => a.y - b.y || a.x - b.x);
    return tiles.slice(0, limit);
  }
  return tiles;
}

function appendHistory(session: SessionMemory, role: "user" | "assistant", content: string) {
  if (!session.history) session.history = [];
  session.history.push({ ts: new Date().toISOString(), role, content });
  if (session.history.length > 200) session.history.shift();
  if (!session.sessionDir) return;
  const filePath = path.join(session.sessionDir, "conversation.json");
  fs.writeFileSync(filePath, JSON.stringify(session.history, null, 2));
}

function summarizeUserPayloadForHistory(payloadText: string): string {
  try {
    const data = JSON.parse(payloadText);
    const state = data?.state;
    const summary = {
      planLength: data?.planLength,
      turnsElapsed: data?.turnsElapsed,
      state: state
        ? {
            turn: state.turn,
            pos: state.pos,
            fuel: state.fuel,
            hull: state.hull,
            cargo: state.cargo,
            money: state.money,
            atSurface: state.atSurface,
            atFuelStation: state.atFuelStation,
            atUpgradeShop: state.atUpgradeShop,
            drill: state.drill,
            goal: state.goal
          }
        : undefined,
      fuelNavigator: data?.fuelNavigator,
      fuelHint: data?.fuelHint,
      shopHint: data?.shopHint,
      behaviorNote: data?.behaviorNote,
      blockedDirs: data?.blockedDirs,
      fuelRuns: data?.fuelRuns,
      upgradeReminder: data?.upgradeReminder
    };
    return JSON.stringify(summary);
  } catch {
    return payloadText;
  }
}

function appendSessionLog(session: SessionMemory, level: string, message: string, data?: unknown, fileName = "llm.log") {
  if (!session.sessionDir) return;
  const ts = new Date().toISOString();
  const payload = data ? ` ${JSON.stringify(data)}` : "";
  const filePath = path.join(session.sessionDir, fileName);
  fs.appendFileSync(filePath, `[${ts}] [${level}] ${message}${payload}\n`);
}

function analyzeBehavior(session: SessionMemory, state: State) {
  const tail = session.visited.slice(-8);
  if (tail.length < 3 || !state.pos) return null;
  const posKey = (p: { x: number; y: number }) => `${p.x},${p.y}`;
  const unique = Array.from(new Set(tail.map(posKey)));
  const stuck = unique.length === 1
    ? `Position unchanged for last ${tail.length} turns; likely blocked moves (rock/surface) or insufficient fuel for U thrust.`
    : null;
  const oscillating = unique.length === 2
    ? `Oscillating between ${unique[0]} and ${unique[1]} over last ${tail.length} turns; may be bouncing off obstacles.`
    : null;
  const depthDelta = tail[tail.length - 1].y - tail[0].y;
  const depthNote = Math.abs(depthDelta) <= 1
    ? `No depth progress over last ${tail.length} turns (Δy=${depthDelta}).`
    : null;

  return {
    stuck,
    oscillating,
    depthNote
  };
}

function blockedDirsFromScan(state: State) {
  const scan = state.localScan;
  if (!Array.isArray(scan) || scan.length < 3) return null;
  const center = 2; // localScan is 6x6 with player at (2,2)
  const at = (dx: number, dy: number) => {
    const y = center + dy;
    const x = center + dx;
    const row = scan[y];
    return typeof row === "string" ? row[x] : null;
  };
  const blocked: string[] = [];
  const isBlocked = (t: string | null) => t === "r" || t === "S";
  if (isBlocked(at(0, -1))) blocked.push("U");
  if (isBlocked(at(0, 1))) blocked.push("D");
  if (isBlocked(at(-1, 0))) blocked.push("L");
  if (isBlocked(at(1, 0))) blocked.push("R");
  return blocked.length ? blocked : null;
}

function updateFuelRunCount(session: SessionMemory, state: State) {
  if (!state.atFuelStation) {
    session.lastAtStation = false;
    return;
  }
  if (!session.lastAtStation) {
    session.fuelRuns = (session.fuelRuns ?? 0) + 1;
    session.lastAtStation = true;
  }
}

function buildShopHint(state: State) {
  if (!state.pos) return null;
  const shopX = state.stations?.shop?.x ?? 27;
  const returnDy = Math.max(0, state.pos.y - 1);
  const returnDx = Math.abs(state.pos.x - shopX);
  const baseTurnFuel = state.rules?.baseTurnFuel ?? 1;
  const upThrustFuel = 2;
  const airMoveFuel = 0.5;
  const digFuel =
    typeof (state.rules as any)?.digFuelBase?.dirt === "number"
      ? (state.rules as any).digFuelBase.dirt
      : 2;
  const verticalCost = baseTurnFuel + upThrustFuel;
  const horizontalCost = baseTurnFuel + (state.pos.y > 1 ? (digFuel + 1) : airMoveFuel);
  const estReturnFuel = returnDy * verticalCost + returnDx * horizontalCost;
  return { shopX, returnDx, returnDy, estReturnFuel };
}

export async function callOpenRouterPlan(
  state: State,
  planLength: number,
  sessionId?: string,
  fuelNavigator?: FuelNavigatorPayload | null
): Promise<PlanResponse> {
  if (!OPENROUTER_API_KEY) {
    logLine("WARN", "Missing OPENROUTER_API_KEY, using fallback plan.");
    return { actions: planActions(state, planLength), note: "fallback-no-key", model: OPENROUTER_MODEL };
  }
  if (MAX_PLANS_PER_SESSION > 0 && planCount >= MAX_PLANS_PER_SESSION) {
    logLine("WARN", "MAX_PLANS_PER_SESSION reached, using fallback.");
    return { actions: planActions(state, planLength), note: "fallback-max-plans", model: OPENROUTER_MODEL };
  }

  const session = getSession(sessionId);
  updateMemory(session, state);
  updateFuelRunCount(session, state);
  const memory = {
    knownWindow: buildMemoryWindow(session, state, 12),
    visitedTail: session.visited.slice(-8),
    bounds: session.bounds
  };

  appendSessionLog(session, "INFO", "LLM request", {
    model: OPENROUTER_MODEL,
    planLength,
    sessionId,
    stateSummary: {
      turn: state.turn,
      pos: state.pos,
      fuel: state.fuel,
      hull: state.hull,
      cargo: state.cargo,
      money: state.money,
      atSurface: state.atSurface,
      atFuelStation: state.atFuelStation,
      atUpgradeShop: state.atUpgradeShop
    }
  });

  const needsUpgradeReminder = (session.fuelRuns ?? 0) >= 2 && (state.fuel?.max ?? 0) < 180;
  const userPayload = {
    planLength,
    turnsElapsed: state.turn,
    state,
    fuelNavigator: fuelNavigator ?? null,
    memory,
    scanTiles: buildScanTiles(state),
    knownTiles: buildKnownTiles(session),
    fuelHint: buildFuelHint(state),
    shopHint: buildShopHint(state),
    behaviorNote: analyzeBehavior(session, state),
    blockedDirs: blockedDirsFromScan(state),
    fuelRuns: session.fuelRuns ?? 0,
    upgradeReminder: needsUpgradeReminder
      ? "You have returned to the fuel station multiple times; prioritize buying a FUEL upgrade at the shop to reach deeper depths."
      : null
  };

  const payloadText = JSON.stringify(userPayload);
  appendSessionLog(session, "INFO", "LLM input", { payloadPreview: payloadText.slice(0, 4000) });
  appendSessionLog(session, "INFO", "LLM input full", { payload: payloadText });

  const now = Date.now();
  const waitMs = Math.max(0, MIN_REQUEST_GAP_MS - (now - lastRequestAt));
  if (waitMs > 0) {
    await new Promise((r) => setTimeout(r, waitMs));
  }
  lastRequestAt = Date.now();

  const controller = new AbortController();
  const startedAt = Date.now();
  let abortedByTimeout = false;
  const timeoutId = setTimeout(() => {
    abortedByTimeout = true;
    controller.abort();
  }, OPENROUTER_TIMEOUT_MS);

  let responseContent = "";
  let reasoningDetails: unknown = null;
  let reasoningText: string | null = null;

  try {
    const apiResponse = await client.chat.completions.create(
      {
        model: OPENROUTER_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: exampleUserMessage },
          { role: "assistant", content: exampleAssistantOutput },
          ...(session.history || []).map((h) => ({ role: h.role, content: h.content })),
          { role: "user", content: JSON.stringify(userPayload) }
        ],
        reasoning: { enabled: true, effort: REASONING_EFFORT_SAFE },
        max_tokens: MAX_COMPLETION_TOKENS,
        max_output_tokens: MAX_COMPLETION_TOKENS,
        temperature: 0.3
      } as any,
      { signal: controller.signal }
    );

    type ORChatMessage = (typeof apiResponse)["choices"][number]["message"] & {
      reasoning_details?: unknown;
      reasoning?: unknown;
    };
    const response = apiResponse.choices[0]?.message as ORChatMessage | undefined;
    responseContent = typeof response?.content === "string" ? response.content : "";
    reasoningDetails = response?.reasoning_details ?? null;
    reasoningText = typeof response?.reasoning === "string" ? response.reasoning : null;
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    const isAbort = err instanceof Error && err.name === "AbortError";
    const msg = isAbort
      ? abortedByTimeout
        ? "OpenRouter request aborted (timeout)"
        : "OpenRouter request aborted (external)"
      : "OpenRouter request failed";
    appendSessionLog(session, "ERROR", msg, {
      error: String(err instanceof Error ? err.message : err),
      name: err instanceof Error ? err.name : null,
      elapsedMs,
      timeoutMs: OPENROUTER_TIMEOUT_MS
    }, "api_errors.log");
    appendHistory(session, "user", payloadText);
    appendHistory(session, "assistant", `<error:${String(err instanceof Error ? err.message : err)}>`);
    return {
      actions: [],
      note: "api-error",
      model: OPENROUTER_MODEL,
      reasoning: String(err instanceof Error ? err.message : err),
      status: "api_error"
    };
  } finally {
    clearTimeout(timeoutId);
  }

  const elapsedMs = Date.now() - startedAt;
  appendSessionLog(session, "INFO", "LLM request complete", { elapsedMs, timeoutMs: OPENROUTER_TIMEOUT_MS });

  if (reasoningText) {
    appendSessionLog(session, "INFO", "LLM reasoning", { textPreview: reasoningText.slice(0, 2000) });
  }
  if (reasoningDetails) {
    appendSessionLog(session, "INFO", "LLM reasoning_details", { details: reasoningDetails });
  }
  const combinedText = responseContent || reasoningText || "";
  appendHistory(session, "user", summarizeUserPayloadForHistory(payloadText));
  appendHistory(session, "assistant", combinedText || "<empty>");
  if (!responseContent) {
    appendSessionLog(session, "WARN", "LLM empty content", { response: combinedText });
  }
  appendSessionLog(session, "INFO", "LLM raw output", { textPreview: combinedText.slice(0, 500) });

  const selfReflection = extractTaggedText(combinedText, "self_reflection");
  const actionToTake = extractTaggedText(combinedText, "action_to_take");
  const executionText = extractExecutionText(combinedText);
  if (selfReflection) {
    appendSessionLog(session, "INFO", "LLM self_reflection", { textPreview: selfReflection.slice(0, 1000) });
  }
  if (actionToTake) {
    appendSessionLog(session, "INFO", "LLM action_to_take", { textPreview: actionToTake.slice(0, 1000) });
  }

  if (!executionText) {
    appendSessionLog(session, "WARN", "LLM missing <execution> tag; requesting correction.", { textPreview: combinedText.slice(0, 500) });
    const correction = formatValidationError(null, planLength);
    const correctionResponse = await requestCorrection(session, systemPrompt, userPayload, combinedText, correction, planLength, reasoningDetails);
    if (correctionResponse) {
      return correctionResponse;
    }
    return {
      actions: planActions(state, planLength),
      note: "no-execution-tag",
      model: OPENROUTER_MODEL,
      reasoning: combinedText || null,
      status: "bad_format"
    };
  }

  const validation = validateExecution(executionText, planLength);
  if (!validation.result.success) {
    appendSessionLog(session, "WARN", "LLM execution validation failed; requesting correction.", {
      issues: validation.result.error.issues,
      executionText
    });
    const correction = formatValidationError(executionText, planLength);
    const correctionResponse = await requestCorrection(session, systemPrompt, userPayload, combinedText, correction, planLength, reasoningDetails);
    if (correctionResponse) {
      return correctionResponse;
    }
    return {
      actions: planActions(state, planLength),
      note: "bad-execution-format",
      model: OPENROUTER_MODEL,
      reasoning: combinedText || null,
      status: "bad_format"
    };
  }

  const actions = parseActionTokens(executionText);
  if (actions.length < 1 || actions.length > planLength) {
    appendSessionLog(session, "WARN", "LLM execution token parse mismatch.", {
      expected: planLength,
      got: actions.length
    });
    return {
      actions: planActions(state, planLength),
      note: "bad-execution-parse",
      model: OPENROUTER_MODEL,
      reasoning: combinedText || null,
      status: "bad_format"
    };
  }
  planCount += 1;
  const cleaned = sanitizeActions(actions, planLength);
  const response: PlanResponse = {
    actions: cleaned,
    note: "openrouter",
    model: OPENROUTER_MODEL,
    reasoning: responseContent || null,
    progress: null,
    status: null
  };
  appendSessionLog(session, "INFO", "LLM response parsed", { actions: cleaned.length, preview: cleaned });
  return response;
}

export async function probeOpenRouter(): Promise<{
  ok: boolean;
  model: string;
  elapsedMs: number;
  error?: string;
}> {
  const startedAt = Date.now();
  if (!OPENROUTER_API_KEY) {
    return {
      ok: false,
      model: OPENROUTER_MODEL,
      elapsedMs: 0,
      error: "Missing OPENROUTER_API_KEY"
    };
  }

  try {
    await client.chat.completions.create({
      model: OPENROUTER_MODEL,
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 16,
      temperature: 0
    } as any);
    return { ok: true, model: OPENROUTER_MODEL, elapsedMs: Date.now() - startedAt };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const meta = {
      name: err instanceof Error ? err.name : null,
      message,
      status: (err as any)?.status ?? null,
      code: (err as any)?.code ?? null,
      type: (err as any)?.type ?? null,
      responseStatus: (err as any)?.response?.status ?? null,
      responseData: (err as any)?.response?.data ?? null,
      errorData: (err as any)?.error ?? null,
      cause: (err as any)?.cause ?? null
    };
    logApiError("ERROR", "OpenRouter probe error detail", meta);
    return {
      ok: false,
      model: OPENROUTER_MODEL,
      elapsedMs: Date.now() - startedAt,
      error: message
    };
  }
}

export async function testSystemPromptEcho(input?: string): Promise<{
  ok: boolean;
  model: string;
  elapsedMs: number;
  content?: string;
  error?: string;
}> {
  const startedAt = Date.now();
  if (!OPENROUTER_API_KEY) {
    return {
      ok: false,
      model: OPENROUTER_MODEL,
      elapsedMs: 0,
      error: "Missing OPENROUTER_API_KEY"
    };
  }
  const userText =
    typeof input === "string" && input.trim().length > 0
      ? input.trim()
      : "In one sentence, state your purpose based on the system prompt.";

  try {
    const res = await client.chat.completions.create({
      model: OPENROUTER_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userText }
      ],
      max_tokens: 80,
      temperature: 0
    } as any);
    logLlmAgent("INFO", "OpenRouter system prompt test raw response", { response: res });
    type ORChatMessage = (typeof res)["choices"][number]["message"] & {
      reasoning?: unknown;
      reasoning_details?: unknown;
    };
    const msg = res.choices[0]?.message as ORChatMessage | undefined;
    let content = (msg?.content ?? "").trim();
    if (!content && typeof msg?.reasoning === "string") {
      content = msg.reasoning.trim();
    }
    if (!content && msg?.reasoning_details) {
      content = JSON.stringify(msg.reasoning_details);
    }
    return { ok: true, model: OPENROUTER_MODEL, elapsedMs: Date.now() - startedAt, content };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logApiError("ERROR", "OpenRouter system prompt test failed", {
      name: err instanceof Error ? err.name : null,
      message
    });
    return {
      ok: false,
      model: OPENROUTER_MODEL,
      elapsedMs: Date.now() - startedAt,
      error: message
    };
  }
}

async function requestCorrection(
  session: SessionMemory,
  systemPrompt: string,
  userPayload: unknown,
  priorOutput: string,
  correctionMessage: string,
  planLength: number,
  priorReasoningDetails: unknown
): Promise<PlanResponse | null> {
  const correctionStart = Date.now();
  try {
    const assistantMsg = {
      role: "assistant",
      content: priorOutput,
      reasoning_details: priorReasoningDetails
    } as any;
    const apiResponse = await client.chat.completions.create({
      model: OPENROUTER_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: exampleUserMessage },
        { role: "assistant", content: exampleAssistantOutput },
        { role: "user", content: JSON.stringify(userPayload) },
        assistantMsg,
        { role: "user", content: correctionMessage }
      ],
      reasoning: { enabled: true, effort: REASONING_EFFORT_SAFE },
      max_tokens: MAX_COMPLETION_TOKENS,
      max_output_tokens: MAX_COMPLETION_TOKENS,
      temperature: 0.2
    } as any);

    type ORChatMessage = (typeof apiResponse)["choices"][number]["message"] & {
      reasoning_details?: unknown;
      reasoning?: unknown;
    };
    const response = apiResponse.choices[0]?.message as ORChatMessage | undefined;
    const content = typeof response?.content === "string" ? response.content : "";
    const reasoningDetails = response?.reasoning_details ?? null;
    const reasoningText = typeof response?.reasoning === "string" ? response.reasoning : null;
    appendSessionLog(session, "INFO", "LLM correction response", {
      elapsedMs: Date.now() - correctionStart,
      reasoningPreview: reasoningText ? reasoningText.slice(0, 1000) : null,
      reasoningDetails
    });

    const combinedText = content || reasoningText || "";
    const executionText = extractExecutionText(combinedText);
    if (!executionText) {
      appendSessionLog(session, "WARN", "Correction missing <execution> tag.", { textPreview: combinedText.slice(0, 500) });
      return null;
    }

    const validation = validateExecution(executionText, planLength);
    if (!validation.result.success) {
      appendSessionLog(session, "WARN", "Correction execution validation failed.", {
        issues: validation.result.error.issues,
        executionText
      });
      return null;
    }

    const actions = parseActionTokens(executionText);
    if (actions.length < 1 || actions.length > planLength) return null;
    const cleaned = sanitizeActions(actions, planLength);
    return {
      actions: cleaned,
      note: "openrouter-corrected",
      model: OPENROUTER_MODEL,
      reasoning: content || null,
      progress: null,
      status: null
    };
  } catch (err) {
    appendSessionLog(session, "ERROR", "Correction request failed", {
      error: String(err instanceof Error ? err.message : err)
    }, "api_errors.log");
    return null;
  }
}
