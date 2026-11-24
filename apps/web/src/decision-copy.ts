type Request = {
  kind?: string;
  title?: string;
  action?: string;
  reason?: string;
  risk?: string;
  provider?: string;
};
type Copy = {
  title: string;
  facts: string[];
  command?: string;
  raw: string;
  inspect: boolean;
};

// Presentation only. A description of observed operations is not a safety
// assessment and must never change the provider's approval decision.
export function decisionCopy(item: Request): Copy {
  const raw = item.action || "";
  let a;
  try {
    a = JSON.parse(raw);
  } catch {
    /* demo and manual requests can be plain text */
  }
  const base = { raw: a ? JSON.stringify(a, null, 2) : raw, inspect: false };
  if (item.kind === "input")
    return { ...base, title: "这项委托需要你补充信息", facts: [] };
  if (item.kind === "decision")
    return { ...base, title: "请核对这次任务实际有没有完成", facts: [raw] };
  if (item.risk?.includes("仅可拒绝"))
    return {
      ...base,
      inspect: true,
      title: "这项操作的范围无法完整核对",
      facts: ["不能批准这项请求。可以拒绝，让助手换一种方式。"],
    };
  if (typeof a?.command === "string") {
    const cmd = a.command;
    const facts: string[] = [];
    // Only pair a named path with the adjacent read. Report unlink separately;
    // do not infer its target from a potentially reassigned variable.
    const read = cmd.match(
      /(?:^|\n)(\w+)\s*=\s*Path\((['"])([^'"\n]{1,200})\2\)\s*\n[^\n]{0,100}?\b\1\.read_(?:bytes|text)\(/,
    );
    const deletes =
      /\b(?:unlink|rmdir|remove|rmtree)\s*\(|(?:^|[\s;&|])rm\s/.test(cmd);
    if (read) facts.push(`读取本次任务中的文件：${read[3]}。`);
    if (deletes)
      facts.push("脚本包含删除操作；允许后，涉及的文件或目录可能被移除。");
    const url = cmd.match(/https?:\/\/[^\s'"<>\\]+/);
    if (url) facts.push(`命令中包含网址：${url[0]}`);
    if (a.network || a.additionalPermissions)
      facts.push("还请求了网络访问或额外权限，请核对完整请求。");
    if (!facts.length)
      facts.push(
        "无法从这条命令可靠判断全部影响。请先核对命令，再决定是否允许。",
      );
    return {
      ...base,
      command: cmd,
      inspect:
        (!read && !deletes) ||
        !!(a.network || a.additionalPermissions),
      title: deletes
        ? (read ? "允许读取文件并执行删除操作吗？" : "是否允许运行含删除操作的脚本？")
        : "是否允许这项委托运行命令？",
      facts,
    };
  }
  if (Array.isArray(a?.changes) && a.changes.length) {
    const actions: Record<string, string> = {
      add: "新增",
      update: "修改",
      delete: "删除",
    };
    const facts = a.changes.map(
      (ch: { kind?: { type?: string; move_path?: string }; path?: string }) =>
        `${actions[ch?.kind?.type || ""] || "变更"}：${ch?.path || "路径未知"}${ch?.kind?.move_path ? ` → ${ch.kind.move_path}` : ""}`,
    );
    if (a.grantRoot) facts.push(`请求目录授权：${a.grantRoot}`);
    return {
      ...base,
      title: `是否允许变更 ${a.changes.length} 个文件？`,
      facts,
    };
  }
  return {
    ...base,
    title: item.title || "是否允许这次操作？",
    facts: [],
    inspect: item.provider !== "demo",
  };
}
