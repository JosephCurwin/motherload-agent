import express, { Request, Response, NextFunction } from "express";
import router from "./routes/routes";
import { logLine } from "./services/utils/custom-logger";

const app = express();

app.use(express.json({ limit: "1mb" }));

app.use(router);

app.use(express.static(process.cwd()));

app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
  logLine("ERROR", "Unhandled server error", { error: String(error) });
  res.status(500).json({ error: "Internal server error" });
});

export { app };
