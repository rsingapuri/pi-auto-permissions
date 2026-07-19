import { GlobalConfigStore } from "../../src/state/config-store.ts";

const [configPath, writerId, countValue] = process.argv.slice(2);
if (configPath === undefined || writerId === undefined || countValue === undefined) {
  throw new Error("usage: config-writer.ts CONFIG_PATH WRITER_ID COUNT");
}
const count = Number(countValue);
if (!Number.isSafeInteger(count) || count <= 0) throw new Error("COUNT must be positive");

const store = new GlobalConfigStore({ configPath });
for (let index = 0; index < count; index += 1) {
  await store.setReviewer({
    provider: "race-provider",
    modelId: `${writerId}-${String(index)}`,
    thinkingLevel: index % 2 === 0 ? "high" : "xhigh",
  });
}

