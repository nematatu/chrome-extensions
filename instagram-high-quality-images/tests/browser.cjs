const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

(async () => {
  const extensionPath = path.resolve(__dirname, "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionPath, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.permissions, ["storage", "activeTab"]);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.background, undefined);
  assert.deepEqual(manifest.content_scripts[0].js, ["quality-core.js", "content.js"]);
  assert.deepEqual(manifest.content_scripts[0].css, ["content.css"]);

  const profilePath = fs.mkdtempSync(path.join(os.tmpdir(), "instagram-hq-test-"));
  const context = await chromium.launchPersistentContext(profilePath, {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  try {
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.route("https://scontent.cdninstagram.com/**", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="1080"><rect width="100%" height="100%" fill="#7354cc"/></svg>',
      }),
    );
    await page.route("https://www.instagram.com/**", (route) => {
      const pathname = new URL(route.request().url()).pathname;
      const body = pathname.includes("/live")
        ? '<main><video id="live" style="width:320px;height:480px"></video></main>'
        : `<main><article><img id="post-image" width="320" height="240"
             src="https://scontent.cdninstagram.com/small.svg"
             srcset="https://scontent.cdninstagram.com/small.svg 320w, https://scontent.cdninstagram.com/large.svg 1440w"
             sizes="320px"></article></main>`;
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html><body>${body}</body></html>`,
      });
    });

    await page.goto("https://www.instagram.com/p/ABC123/");
    const image = page.locator("#post-image");
    await image.waitFor();
    await page.waitForFunction(() => document.querySelector("#post-image")?.classList.contains("instagram-hq-image"));
    assert.match(await image.getAttribute("src"), /\/large\.svg$/);
    assert.equal(await image.getAttribute("srcset"), null);
    assert.equal(await image.getAttribute("sizes"), null);
    assert.equal(await page.locator('[class*="download"], [class*="story-tools"], [class*="grid-save"], .instagram-hq-bulk').count(), 0);

    await page.goto("https://www.instagram.com/alice/live/");
    await page.locator("#live").evaluate((video) => {
      Object.defineProperties(video, {
        videoWidth: { configurable: true, value: 1080 },
        videoHeight: { configurable: true, value: 1920 },
        duration: { configurable: true, value: Infinity },
      });
      video.dispatchEvent(new Event("loadedmetadata", { bubbles: true }));
    });
    await page.waitForFunction(() => document.querySelector("#live")?.classList.contains("instagram-hq-live-video"));

    assert.deepEqual(pageErrors, []);
    console.log("PASS: high-quality image display, Live rotation, and absence of download UI/permissions");
  } finally {
    await context.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
