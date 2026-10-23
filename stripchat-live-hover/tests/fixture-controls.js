(() => {
  let hovered = null;
  function leave() {
    if (!hovered) return;
    hovered.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, pointerType: "mouse", relatedTarget: document.body }));
    hovered.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
    hovered = null;
  }
  function hover(id) {
    leave();
    const card = document.querySelector(`[data-model-id="${id}"]`);
    const rect = card.getBoundingClientRect();
    const point = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    card.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse", ...point }));
    card.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, ...point }));
    hovered = card;
  }
  function report() {
    const videos = [...document.querySelectorAll(".live-thumb video")];
    const badges = [...document.querySelectorAll(".sc-live-hover-badge")];
    const result = {
      adapter: document.documentElement.getAttribute("data-sc-live-hover-native"),
      duration: fixtureNative.config.duration,
      hoverDelay: fixtureNative.config.visibilityTimeout,
      videos: videos.length,
      playing: videos.filter(v => !v.paused && v.readyState >= 2).length,
      muted: videos.every(v => v.muted),
      frames: videos.reduce((sum, v) => sum + (v.getVideoPlaybackQuality?.().totalVideoFrames || 0), 0),
      badges: badges.map(b => ({ text: b.textContent, state: b.dataset.state, visible: !b.hidden })),
      targets: document.querySelectorAll(".sc-live-hover-target").length,
      nativeActive: fixtureNative.isActive()
    };
    document.getElementById("results").textContent = JSON.stringify(result, null, 2);
  }
  document.getElementById("start-a").onclick = () => hover("10001");
  document.getElementById("start-b").onclick = () => hover("10002");
  document.getElementById("leave").onclick = leave;
  document.getElementById("unavailable").onclick = () => hover("10003");
  document.getElementById("add").onclick = () => {
    leave();
    const template = document.querySelector('[data-model-list-root="item"]').cloneNode(true);
    template.querySelector("a").dataset.modelId = "10004";
    template.querySelector("a").href = "https://ja.stripchat.com/demo-added";
    template.querySelector(".poster").textContent = "動的プレビュー";
    template.querySelector(".meta").textContent = "後から追加したカード";
    template.querySelector(".live-thumb")?.remove();
    template.querySelector(".sc-live-hover-badge")?.remove();
    document.getElementById("grid").append(template);
    hover("10004");
  };
  document.getElementById("late").onclick = () => {
    fixtureNative.setLateDelay(1800);
    hover("10001");
    setTimeout(() => hover("10002"), 150);
  };
  document.getElementById("checks").onclick = report;
  setInterval(report, 200);
})();
