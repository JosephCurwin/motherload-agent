import { config as dotenvConfig } from "dotenv";

dotenvConfig();

import { app } from "./src/main";

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const HOST = process.env.HOST || "0.0.0.0";

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on http://${HOST}:${PORT}`);
  });
}
