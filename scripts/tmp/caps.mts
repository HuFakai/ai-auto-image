import path from "node:path";
import { openDatabase, ChannelRepo } from "@aai/storage";
import { ChannelService } from "../../apps/web/src/server/channel-service";

const dataDir = path.resolve(process.cwd(), "apps/web/data");
const db = openDatabase({ sqlitePath: path.join(dataDir, "db", "app.db") });
const service = new ChannelService(new ChannelRepo(db.db), dataDir);

for (const c of service.list()) {
  console.log(`[${c.type}] ${c.name} · edit=${c.imageEditSupport}`);
}
const assembled = service.assembleRoutes();
for (const r of assembled.imageRoutes) {
  const caps = r.image.capabilities();
  console.log(`route ${r.model} · imageEditSingle=${caps.imageEditSingle}`);
}
console.log("mode:", assembled.mode, "| label:", assembled.label);
process.exit(0);
