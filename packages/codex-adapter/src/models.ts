import { Rpc } from "./rpc.ts";
import type { Model } from "../generated/v2/Model.ts";
import type { ModelListResponse } from "../generated/v2/ModelListResponse.ts";
import type { Workload } from "../../agent-core/src/index.ts";

type Entry = Pick<
  Model,
  | "model"
  | "description"
  | "displayName"
  | "supportedReasoningEfforts"
  | "defaultReasoningEffort"
  | "isDefault"
>;
type CatalogModel = Entry & Pick<Model, "inputModalities">;
export type ModelChoice = { model?: string; effort?: string };

async function readModels(rpc: Rpc, provider?: string): Promise<CatalogModel[]> {
  const deadline = Date.now() + 3500;
  const models: CatalogModel[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page: ModelListResponse = await rpc.call(
      "model/list",
      {
        cursor,
        limit: 100,
        includeHidden: false,
        modelProvider: provider,
      },
      Math.max(1, deadline - Date.now()),
    );
    for (const m of page.data) {
      if (
        !m.hidden &&
        !m.modelSpecialty &&
        m.inputModalities?.includes("text") &&
        typeof m.model === "string" &&
        m.model &&
        typeof m.description === "string" &&
        Array.isArray(m.supportedReasoningEfforts)
      )
        models.push(m);
    }
    cursor = page.nextCursor;
    if (cursor && (cursors.has(cursor) || cursors.size >= 16))
      throw Error("模型目录分页异常");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return models;
}

// A short-lived directory lookup is shared by concurrent readers. Its failure
// never closes a live execution connection. No prompts are sent by this process.
const cached = new Map<string, { until: number; items: Promise<CatalogModel[]> }>();
export function expireCatalog(provider?: string, cwd?: string) {
  cached.delete(JSON.stringify([provider, cwd]));
}
export function modelCatalog(
  provider?: string,
  cwd?: string,
  live?: Rpc,
): Promise<CatalogModel[]> {
  const key = JSON.stringify([provider, cwd]);
  const time = Date.now();
  for (const [k, entry] of cached) if (entry.until <= time) cached.delete(k);
  const hit = cached.get(key);
  if (hit) return hit.items;
  const items = (async () => {
    if (live) return readModels(live, provider).catch(() => []);
    const rpc = new Rpc(
      () => {},
      () => {},
      cwd,
    );
    const timer = setTimeout(() => rpc.close(), 3500);
    try {
      await rpc.init();
      return await readModels(rpc, provider);
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
      rpc.close();
    }
  })();
  const entry = { until: time + 300_000, items };
  cached.set(key, entry);
  void items.then((rows) => {
    if (!rows.length) entry.until = Date.now() + 15_000;
  });
  return items;
}

// Catalog order breaks ties. Advertised capabilities are hints, not prices.
function preference(m: Entry, tier: Workload) {
  const text = m.description;
  let score = m.isDefault ? 2 : 0;
  if (/legacy|previous generation|deprecated/i.test(text)) score -= 8;
  if (tier === "light") {
    if (
      /affordable|cost.efficient|cheaper|economical|easier tasks|simpler tasks/i.test(
        text,
      )
    )
      score += 6;
    if (/\bfast\b|low.latency|\bmini\b/i.test(text + " " + m.model)) score += 3;
  }
  if (
    tier === "deep" &&
    /most capable|complex (?:coding|tasks|reasoning)|advanced reasoning|most intelligent/i.test(
      text,
    )
  )
    score += 7;
  return score;
}
export function selectModel(models: Entry[], tier: Workload): ModelChoice {
  if (!models.length) return {};
  const best = models.reduce((a, b) =>
    preference(b, tier) > preference(a, tier) ? b : a,
  );
  const preferred = {
    light: ["low", "minimal", "medium"],
    standard: ["medium", "low"],
    deep: ["high", "xhigh", "medium"],
  }[tier];
  const efforts = best.supportedReasoningEfforts.map((e) => e.reasoningEffort);
  const effort =
    preferred.find((e) => efforts.includes(e)) ??
    (efforts.includes(best.defaultReasoningEffort)
      ? best.defaultReasoningEffort
      : undefined);
  return { model: best.model, effort };
}

// Only explicit model/effort rejections allow a default-model retry.
export function modelRejected(message: string) {
  return /(?:model|reasoning effort)[^\n]{0,160}(?:not supported|unsupported|not available|unavailable|not found|does not exist|not allowed)|(?:unsupported|unknown|invalid|unavailable) (?:model|reasoning effort)\b/i.test(
    message,
  );
}
