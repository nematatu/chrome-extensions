(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.IGMediaAPI = api;
})(globalThis, function () {
  "use strict";
  const QUERIES = {
    post: { name: "PolarisPostRootQuery", id: "27852811784380813" },
    user: { name: "PolarisSearchBoxRefetchableQuery", id: "27706427925724183" },
    story: { name: "PolarisStoriesV3ReelPageGalleryQuery", id: "28262315486766731" },
    highlight: { name: "PolarisStoriesV3HighlightsPageQuery", id: "28325328583775973" },
  };
  function create({ fetch: request, session, onData, signal = () => null }) {
    async function query(kind, variables) {
      const { name, id } = QUERIES[kind];
      const auth = session();
      const controller = new AbortController();
      const external = signal();
      if (external?.aborted) throw new Error("取得を中止しました。");
      const abort = () => controller.abort();
      external?.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(() => controller.abort(), 20000);
      try {
        const response = await request("https://www.instagram.com/graphql/query", {
          method: "POST", credentials: "include", signal: controller.signal,
          headers: { "Content-Type": "application/x-www-form-urlencoded", "X-IG-App-ID": "936619743392459",
            "X-FB-Friendly-Name": name, "X-CSRFToken": auth.csrf || "" },
          body: new URLSearchParams({ fb_dtsg: auth.dtsg || "", fb_api_caller_class: "RelayModern",
            fb_api_req_friendly_name: name, doc_id: id, variables: JSON.stringify(variables), server_timestamps: "true" }).toString(),
        });
        if (response.status === 429) throw new Error("Instagramの取得制限です。時間をおいて再実行してください。");
        if ([401, 403].includes(response.status) || response.redirected) throw new Error("ログイン状態またはInstagramのアクセス制限を確認してください。");
        if (!response.ok || !/^(?:application\/(?:json|javascript|x-javascript)|text\/javascript)(?:\s*;|$)/i.test(response.headers.get("content-type") || "")) throw new Error("メディア情報を取得できません。投稿を開き直してください。");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let text = "", size = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 12 * 1024 * 1024) { await reader.cancel(); throw new Error("メディア情報が大きすぎます。"); }
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
        const data = JSON.parse(text.replace(/^for\s*\(;;\);\s*/, ""));
        if (data.errors?.length || data.status === "fail") throw new Error("Instagramが取得を拒否しました。ログイン状態を確認し、時間をおいて再実行してください。");
        onData(data); return data;
      } catch (error) {
        if (external?.aborted) throw new Error("取得を中止しました。");
        if (error.name === "AbortError") throw new Error("メディア情報の取得がタイムアウトしました。");
        if (error instanceof SyntaxError) throw new Error("Instagramの応答形式が変わりました。現在の画面から取得できるメディアのみ保存できます。");
        if (error instanceof TypeError) throw new Error("通信に失敗しました。接続を確認して再実行してください。");
        throw error;
      } finally { clearTimeout(timeout); external?.removeEventListener("abort", abort); }
    }
    async function post(code) {
      return query("post", { shortcode: code,
        __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: false,
        __relay_internal__pv__PolarisMultiCaptionCarouselEnabledrelayprovider: false });
    }
    async function stories(route, knownOwner) {
      let id = knownOwner;
      const highlight = route.username === "highlights";
      if (highlight) id = `highlight:${route.id}`;
      else if (!/^\d+$/.test(id || "")) {
        const data = await query("user", { data: { context: "blended", include_reel: "true", query: route.username,
          rank_token: "", search_surface: "web_top_search" }, hasQuery: true });
        const users = data.data?.xdt_api__v1__fbsearch__topsearch_connection?.users;
        const user = users?.find(value => value.user?.username === route.username)?.user;
        id = String(user?.id || user?.pk || "");
        if (!/^\d+$/.test(id)) throw new Error("ストーリーのアカウントを特定できませんでした。");
      }
      const data = await query(highlight ? "highlight" : "story", { initial_reel_id: id, reel_ids: [id], first: 3, last: 2,
        __relay_internal__pv__PolarisCommunityNoteStoriesLabelEnabledrelayprovider: true });
      const edges = data.data?.xdt_api__v1__feed__reels_media__connection?.edges;
      const reel = edges?.map(edge => edge.node).find(node => String(node.id) === id || String(node.user?.pk || node.user?.id) === id);
      if (!Array.isArray(reel?.items) || !reel.items.length) throw new Error("ストーリーを取得できません。期限切れや閲覧権限を確認してください。");
      if (reel.has_more === true || reel.more_available === true) throw new Error("ストーリーを全件取得できませんでした。一括保存を中断しました。");
      return reel;
    }
    return { post, stories };
  }
  function sessionFromPage(scripts, cookie, inputToken = "") {
    let dtsg = inputToken;
    if (!dtsg) for (const text of scripts) {
      const match = text.match(/"DTSGInitialData"\s*,\s*\[\s*\]\s*,\s*\{\s*"token"\s*:\s*("(?:[^"\\]|\\.)*")/);
      if (match) { try { dtsg = JSON.parse(match[1]); break; } catch {} }
    }
    return { dtsg, csrf: cookie.match(/(?:^|;\s*)csrftoken=([^;]*)/)?.[1] || "" };
  }
  return { create, sessionFromPage };
});
