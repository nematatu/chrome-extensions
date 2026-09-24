"use strict";
let rendered = "";
async function refresh() {
  const container = document.querySelector("#jobs");
  try {
    const result = await chrome.runtime.sendMessage({ type: "list" });
    if (!result?.ok) throw new Error();
    const serialized = JSON.stringify(result.jobs);
    if (serialized === rendered) return;
    rendered = serialized;
    container.replaceChildren();
    if (!result.jobs.length) container.textContent = "保存履歴はまだありません。";
    for (const job of [...result.jobs].reverse()) {
      const row = document.createElement("article");
      const title = document.createElement("p");
      title.className = "name";
      title.textContent = job.filename;
      const status = document.createElement("p");
      status.textContent = job.message;
      row.append(title, status);
      if (["receiving", "queued", "processing", "saving"].includes(job.state)) {
        const cancel = document.createElement("button");
        cancel.textContent = "中止";
        cancel.addEventListener("click", async () => {
          cancel.disabled = true;
          try { await chrome.runtime.sendMessage({ type: "cancel", id: job.id }); }
          finally { await refresh(); }
        });
        row.append(cancel);
      }
      container.append(row);
    }
  } catch { container.textContent = "保存状況を取得できません。拡張を再読み込みしてください。"; }
}
void refresh();
setInterval(refresh, 1000);
