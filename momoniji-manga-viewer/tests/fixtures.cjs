const ROOT = 'https://momoniji.com/test-comic/';

function workHtml({ sitePage = 1, total = 6, perSitePage = 2, id = '123', title = 'テスト漫画', pages = null, links = null, omitTotal = false, pagerRanges = false, metadataTotal = total } = {}) {
  const numbers = pages || Array.from({ length: perSitePage }, (_, index) => (sitePage - 1) * perSitePage + index + 1).filter(number => number <= total);
  const chapterLinks = links || Array.from({ length: Math.ceil(total / perSitePage) }, (_, index) => index + 1).map(page => page === 1 ? ROOT : `${ROOT}page/${page}/`);
  return `<!doctype html><html lang="ja"><head><title>${title} | テストサイト</title></head><body>
    <header><img src="https://img.momoniji.com/logo.png" alt="サイトのロゴ"></header>
    <main><h1>${title}</h1><table class="data"><tbody>${omitTotal ? '' : `<tr><th>全ページ数</th><td>${metadataTotal === null ? '' : `${metadataTotal}ページ`}</td></tr>`}<tr><th>作者</th><td>テスト作者</td></tr></tbody></table>
    <div id="content" data="${id}" page="${sitePage}"></div>
    <div class="singlepager"><div class="spgr">${chapterLinks.map((url, index) => {
      const label = pagerRanges ? `${index * perSitePage + 1}-${Math.min(total, (index + 1) * perSitePage)}ページ` : 'ページ';
      return pagerRanges && index + 1 === sitePage ? `<span>${label}</span>` : `<a href="${url}">${label}</a>`;
    }).join('')}</div></div>
    <div class="cif" id="cif">${numbers.map(number => `<div class="iw"><img id="c${number}" src="https://img.momoniji.com/test/${String(number).padStart(3, '0')}.png" width="720" height="1017" loading="lazy" alt="${number}ページ目"></div><span>${number}</span>`).join('')}</div>
    <aside><img src="https://img.momoniji.com/advertisement.png" alt="広告"><a href="/other-comic/">関連作品</a></aside>
    </main></body></html>`;
}

module.exports = { ROOT, workHtml };
