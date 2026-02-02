export type Direction = "U" | "D" | "L" | "R";
export type ActionType = "MOVE" | "UPGRADE" | "SURFACE_OPS";
export type UpgradeKind = "FUEL" | "CARGO" | "HULL" | "DRILL";

export interface Position {
  x: number;
  y: number;
  depth: number;
}

export interface FuelState {
  cur: number;
  max: number;
}

export interface HullState {
  cur: number;
  max: number;
}

export interface CargoState {
  cur: number;
  cap: number;
}

export interface StationPosition {
  x: number;
  y: number;
}

export interface State {
  turn: number;
  pos: Position;
  fuel: FuelState;
  hull: HullState;
  cargo: CargoState;
  money: number;
  localScan: string[];
  atSurface?: boolean;
  atFuelStation?: boolean;
  atUpgradeShop?: boolean;
  drill?: number;
  goal?: { x: number; y: number; mined: boolean };
  stations?: { fuel?: StationPosition; shop?: StationPosition };
  rules?: {
    noDigUp?: boolean;
    upRequiresAir?: boolean;
    lavaDamage?: number;
    baseTurnFuel?: number;
  };
}

export interface PlanRequest {
  planLength: number;
  state: State;
  sessionId?: string;
  fuelNavigator?: FuelNavigatorPayload | null;
}

export interface ActionMove {
  type: "MOVE";
  dir: Direction;
  reason: string;
}

export interface ActionUpgrade {
  type: "UPGRADE";
  kind: UpgradeKind;
  reason: string;
}

export interface ActionSurfaceOps {
  type: "SURFACE_OPS";
  reason: string;
}

export type Action = ActionMove | ActionUpgrade | ActionSurfaceOps;

export interface PlanResponse {
  actions: Action[];
  note: string;
  model?: string | null;
  reasoning?: string | null;
  progress?: unknown | null;
  status?: string | null;
}

export interface FuelNavigatorPayload {
  active: boolean;
  fuelPct: number;
  estReturnFuel: number;
  errorRate: number;
  risk: number;
  pathDirs: string[];
  nextActions?: string[];
  message?: string;
}

export interface SessionMemory {
  id: string;
  known: Map<string, string>;
  visited: Array<{ x: number; y: number; turn: number }>;
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  sessionDir?: string;
  history?: Array<{ ts: string; role: "user" | "assistant"; content: string }>;
  fuelRuns?: number;
  lastAtStation?: boolean;
}
