const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const routes = new Map([
  ["/", ["tests/fixture.html", "text/html; charset=utf-8"]],
  ["/fixture-native.js", ["tests/fixture-native.js", "text/javascript; charset=utf-8"]],
  ["/fixture-controls.js", ["tests/fixture-controls.js", "text/javascript; charset=utf-8"]],
  ...["core.js", "native-preview.js", "content.js"].map(file => ["/" + file, [file, "text/javascript; charset=utf-8"]]),
  ["/content.css", ["content.css", "text/css; charset=utf-8"]],
  ["/demo.mp4", [null, "video/mp4"]]
]);
const fixtureVideo = process.env.STRIPCHAT_HOVER_FIXTURE_VIDEO || path.join(__dirname, "demo.mp4");
const server = http.createServer((req, res) => {
  const route = routes.get(req.url);
  if (!route) { res.writeHead(404).end(); return; }
  const [file, type] = route;
  const source = file ? path.join(__dirname, "..", file) : fixtureVideo;
  const stat = fs.statSync(source);
  res.writeHead(200, { "Content-Type": type, "Content-Length": stat.size, "Cache-Control": "no-store" });
  fs.createReadStream(source).pipe(res);
});
server.listen(8767, "127.0.0.1", () => process.stdout.write("検証画面: http://127.0.0.1:8767/\n"));
