const assert = require("node:assert/strict");
const { parseSushidaShareText, extractTweetTextFromUrl } = require("./src/parser.js");

const shareText = `高級10,000円コース【普通】
★7,700円分 お得でした！（速度：5.9key/秒、ミス：18key）
 https://sushida.net/ #寿司打`;

const result = parseSushidaShareText(shareText);
assert.equal(result.course, "高級10,000円コース");
assert.equal(result.difficulty, "普通");
assert.equal(result.amountYen, 7700);
assert.equal(result.resultType, "profit");
assert.equal(result.speedKeyPerSec, 5.9);
assert.equal(result.missedKeys, 18);

const url = `https://x.com/intent/tweet?text=${encodeURIComponent(shareText)}`;
assert.equal(extractTweetTextFromUrl(url), shareText);

const lossText = `お手軽3,000円コース【難しい】
☆1,240円分 損でした！（速度：3.4key/秒、ミス：42key）
https://sushida.net/ #寿司打`;

const lossResult = parseSushidaShareText(lossText);
assert.equal(lossResult.course, "お手軽3,000円コース");
assert.equal(lossResult.difficulty, "難しい");
assert.equal(lossResult.amountYen, 1240);
assert.equal(lossResult.resultType, "loss");
assert.equal(lossResult.speedKeyPerSec, 3.4);
assert.equal(lossResult.missedKeys, 42);

const mixedText = `正確重視5,000円コース【一発勝負】
★12,345円分 お得でした！（速度：10.2key/秒、ミス：0key）
https://sushida.net/ #寿司打`;

const mixedResult = parseSushidaShareText(mixedText);
assert.equal(mixedResult.course, "正確重視5,000円コース");
assert.equal(mixedResult.difficulty, "一発勝負");
assert.equal(mixedResult.amountYen, 12345);
assert.equal(mixedResult.resultType, "profit");
assert.equal(mixedResult.speedKeyPerSec, 10.2);
assert.equal(mixedResult.missedKeys, 0);

console.log("parser tests passed");
