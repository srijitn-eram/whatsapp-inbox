import express from "express";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { canChooseTeamPassword, config, whatsappConnected } from "./config.js";
import { webhook } from "./webhook.js";
import { api } from "./api.js";

const app = express();
// Behind a host's proxy (Render, Railway, nginx) so req.protocol reflects https
app.set("trust proxy", true);

// Keep the raw body so webhook signatures can be verified.
app.use(
  express.json({
    limit: "2mb",
    verify: (req, _res, buf) => {
      (req as any).rawBody = buf;
    },
  })
);

app.use("/webhook", webhook);
app.use("/api", api);

// Serve the built React app in production.
const webDist = join(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^\/(?!api|webhook).*/, (_req, res) => res.sendFile(join(webDist, "index.html")));
}

app.listen(config.port, () => {
  console.log(`WhatsApp platform listening on http://localhost:${config.port}`);
  if (canChooseTeamPassword()) console.log("Open the app to choose the team password.");
  if (!whatsappConnected()) console.log("WhatsApp isn't connected yet: sign in and follow the Connect WhatsApp page.");
  else if (!config.appSecret) console.warn("WHATSAPP_APP_SECRET not set: webhook signatures are NOT being verified.");
});
