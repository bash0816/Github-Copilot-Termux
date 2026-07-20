'use strict';

function isIssueNeeded(audit) {
  return audit.newPendingGitAsync.length > 0 || audit.newStreamRisk.length > 0 || audit.tokioPatchOk === false;
}

function generateIssueBody(audit, version) {
  const SAFE_LIMIT = 50000;
  const lines = [];
  lines.push(`copilot@${version} の NAPI 監査結果`);
  lines.push("");
  lines.push(`newTokio: ${audit.newTokio.length}`);
  lines.push(`newPendingGitAsync: ${audit.newPendingGitAsync.length}`);
  lines.push(`newStreamRisk: ${audit.newStreamRisk.length}`);
  lines.push(`newUnknown: ${audit.newUnknown.length}`);
  lines.push("");

  const sections = [
    { name: "newTokio", title: "## newTokio", items: audit.newTokio },
    { name: "newPendingGitAsync", title: "## newPendingGitAsync（手動レビュー後にスタブ追加が必要）", items: audit.newPendingGitAsync },
    { name: "newStreamRisk", title: "## newStreamRisk（ストリーム経路、必ず手動確認）", items: audit.newStreamRisk },
    { name: "newUnknown", title: "## newUnknown", items: audit.newUnknown },
  ];

  let truncated = false;
  for (let sectionIdx = 0; sectionIdx < sections.length && !truncated; sectionIdx++) {
    const section = sections[sectionIdx];
    if (section.items.length === 0) continue;

    const isCollapsible = section.name === "newTokio" || section.name === "newUnknown";
    const summaryLabel = section.title.replace(/^## /, "");
    const openTag = isCollapsible
      ? `<details><summary>${summaryLabel} (${section.items.length}件、クリックして展開)</summary>\n`
      : section.title;
    const closeTag = isCollapsible ? "\n</details>" : "";

    const testWithTitle = [...lines, openTag, ""].join("\n");
    if (testWithTitle.length + closeTag.length >= SAFE_LIMIT) {
      const remainingCount = sections.slice(sectionIdx).reduce((sum, s) => sum + s.items.length, 0);
      lines.push("");
      lines.push(`... および他 ${remainingCount} 件は本文上限により表示を省略しました(このリポジトリの再監査で再度検出されます)。`);
      truncated = true;
      break;
    }

    lines.push(openTag);
    let sectionItemCount = 0;
    for (let itemIdx = 0; itemIdx < section.items.length; itemIdx++) {
      const item = section.items[itemIdx];
      const itemLine = `- ${item}`;
      const testWithItem = [...lines, itemLine].join("\n");
      const truncNoticeEstimate = 250 + closeTag.length;
      if (testWithItem.length + truncNoticeEstimate >= SAFE_LIMIT) {
        const remainingInSection = section.items.length - sectionItemCount;
        const totalRemaining = remainingInSection + sections.slice(sectionIdx + 1).reduce((sum, s) => sum + s.items.length, 0);
        if (closeTag) lines.push(closeTag);
        lines.push("");
        lines.push(`... および他 ${totalRemaining} 件は本文上限により表示を省略しました(このリポジトリの再監査で再度検出されます)。`);
        truncated = true;
        break;
      }
      lines.push(itemLine);
      sectionItemCount++;
    }
    if (!truncated) {
      if (closeTag) lines.push(closeTag);
      if (sectionIdx < sections.length - 1) lines.push("");
    }
  }
  return lines.join("\n").trimEnd() + "\n";
}

module.exports = { isIssueNeeded, generateIssueBody };
