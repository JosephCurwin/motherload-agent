import { Router, Request, Response } from "express";
import path from "path";
import { callOpenRouterPlan, getOpenRouterModel, probeOpenRouter, testSystemPromptEcho, validateState } from "../services/agent-planner/run-agent-planner";
import { logAgentLine, logLine } from "../services/utils/custom-logger";
import { FuelNavigatorPayload, PlanRequest, State } from "../models/data-flow-models";

const router = Router();

function hasKeys(obj: unknown, keys: string[]): obj is Record<string, unknown> {
  return Boolean(obj) && keys.every((k) => Object.prototype.hasOwnProperty.call(obj, k));
}

router.get("/health", (req: Request, res: Response) => res.status(200).send("ok"));

router.get("/llm-model", (req: Request, res: Response) => {
  res.status(200).json({ model: getOpenRouterModel() });
});

router.get("/test-openrouter", async (req: Request, res: Response) => {
  logLine("INFO", "OpenRouter probe start", { path: req.path });
  const result = await probeOpenRouter();
  if (result.ok) {
    logLine("INFO", "OpenRouter probe ok", { model: result.model, elapsedMs: result.elapsedMs });
  } else {
    logLine("ERROR", "OpenRouter probe failed", {
      model: result.model,
      elapsedMs: result.elapsedMs,
      error: result.error || null
    });
  }
  res.status(result.ok ? 200 : 502).json(result);
});

router.post("/test-openrouter", async (req: Request, res: Response) => {
  const body = req.body || {};
  const input = typeof body.input === "string" ? body.input : undefined;
  logLine("INFO", "OpenRouter system prompt test start", { path: req.path, inputPreview: input?.slice(0, 200) });
  const result = await testSystemPromptEcho(input);
  if (result.ok) {
    logLine("INFO", "OpenRouter system prompt test ok", { model: result.model, elapsedMs: result.elapsedMs });
  } else {
    logLine("ERROR", "OpenRouter system prompt test failed", {
      model: result.model,
      elapsedMs: result.elapsedMs,
      error: result.error || null
    });
  }
  res.status(result.ok ? 200 : 502).json(result);
});

router.post("/client-log", (req: Request, res: Response) => {
  const body = req.body || {};
  const level = typeof body.level === "string" ? body.level : "INFO";
  const message = typeof body.message === "string" ? body.message : "Client log";
  const meta = body.meta && typeof body.meta === "object" ? body.meta : {};
  logLine(level, "CLIENT", { message, ...meta });
  res.status(204).end();
});

router.post("/agent-log", (req: Request, res: Response) => {
  const body = req.body || {};
  const level = typeof body.level === "string" ? body.level : "INFO";
  const message = typeof body.message === "string" ? body.message : "Agent log";
  const meta = body.meta && typeof body.meta === "object" ? body.meta : {};
  logAgentLine(level, "AGENT", { message, ...meta });
  res.status(204).end();
});

router.post("/plan", async (req: Request, res: Response) => {
  const body = req.body as PlanRequest | undefined;
  if (!body || !hasKeys(body, ["planLength", "state"]) || !validateState(body.state)) {
    logLine("WARN", "Invalid /plan request", { body });
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  try {
    const fuelNavigator = (body as { fuelNavigator?: FuelNavigatorPayload | null }).fuelNavigator ?? null;
    const result = await callOpenRouterPlan(body.state as State, body.planLength, body.sessionId, fuelNavigator);
    res.status(200).json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logLine("ERROR", "LLM error", { error: message });
    res.status(500).json({ error: "LLM error", detail: message });
  }
});

router.get("/test-agent", async (req: Request, res: Response) => {
  const testState: State = {
    turn: 0,
    pos: { x: 10, y: 1, depth: 1 },
    fuel: { cur: 40, max: 60 },
    hull: { cur: 35, max: 40 },
    cargo: { cur: 2, cap: 12 },
    money: 120,
    atSurface: true,
    atFuelStation: true,
    atUpgradeShop: false,
    drill: 1.0,
    goal: { x: 10, y: 24, mined: false },
    localScan: ["......", "..dd..", "..do..", "..d...", "......", "......"],
    rules: {
      noDigUp: false,
      upRequiresAir: false,
      lavaDamage: 8,
      baseTurnFuel: 1
    }
  };

  try {
    const result = await callOpenRouterPlan(testState, 3, "test", null);
    res.status(200).json({ ok: true, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logLine("ERROR", "Test-agent error", { error: message });
    res.status(500).json({ ok: false, error: message });
  }
});

router.get("/openapi.yaml", (req: Request, res: Response) => {
  res.sendFile(path.join(process.cwd(), "openapi.yaml"));
});

router.get("/", (req: Request, res: Response) => {
  res.sendFile(path.join(process.cwd(), "index.html"));
});

export default router;
