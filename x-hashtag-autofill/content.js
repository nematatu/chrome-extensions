const STORAGE_KEY = "hashtags";
const EDITOR_SELECTOR = '[data-testid="tweetTextarea_0"][contenteditable="true"]';
const handledComposers = new WeakSet();

function isReplyComposer(editor) {
  if (editor.closest('article[data-testid="tweet"]')) return true;

  const dialog = editor.closest('[role="dialog"]');
  if (!dialog) return false;

  const submitButton = dialog.querySelector(
    '[data-testid="tweetButton"], [data-testid="tweetButtonInline"]'
  );
  const label = `${submitButton?.textContent ?? ""} ${submitButton?.getAttribute("aria-label") ?? ""}`
    .trim()
    .toLowerCase();

  if (/(^|\s)reply($|\s)|返信/.test(label)) return true;

  // 返信モーダルには返信元のポストが同じダイアログ内に表示される。
  return Boolean(dialog.querySelector('article[data-testid="tweet"]'));
}

function normalizeHashtags(value) {
  return [...new Set(
    String(value ?? "")
      .split(/[\s,、]+/)
      .map((tag) => tag.trim())
      .filter(Boolean)
      .map((tag) => (tag.startsWith("#") ? tag : `#${tag}`))
  )];
}

function moveCaretToStart(editor) {
  const firstLeaf = editor.querySelector("[data-text='true']");
  if (!firstLeaf) return;

  editor.focus({ preventScroll: true });
  const range = document.createRange();
  const textNode = [...firstLeaf.childNodes].find(
    (node) => node.nodeType === Node.TEXT_NODE
  );

  // 先頭が空段落（<br>のみ）でも、その段落内の先頭へ配置する。
  range.setStart(textNode ?? firstLeaf, 0);
  range.collapse(true);

  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function afterRender() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

async function fillEditor(editor) {
  if (!editor.isConnected || isReplyComposer(editor)) return;
  const composer = editor.closest('[role="dialog"]') ?? editor;

  const { [STORAGE_KEY]: stored = "" } = await chrome.storage.sync.get(STORAGE_KEY);
  const hashtags = normalizeHashtags(stored);
  if (!hashtags.length || !editor.isConnected) return;

  const hashtagText = hashtags.join(" ");
  const currentText = editor.innerText.replace(/\u200B/g, "");
  if (hashtags.every((tag) => currentText.includes(tag))) {
    moveCaretToStart(editor);
    return;
  }

  const textToInsert = `\n\n${hashtagText}`;

  // XのDraft.jsへpasteイベントとして渡し、改行も内部状態へ登録する。
  // insertParagraphによるDOM操作は、次の入力時にReactから破棄されるため使わない。
  editor.focus({ preventScroll: true });
  const clipboardData = new DataTransfer();
  clipboardData.setData("text/plain", textToInsert);
  const pasteEvent = new ClipboardEvent("paste", {
    bubbles: true,
    cancelable: true,
    composed: true,
    clipboardData
  });
  const handledByX = !editor.dispatchEvent(pasteEvent);

  // pasteを処理しない環境ではブラウザ標準の入力処理へフォールバックする。
  if (!handledByX) {
    document.execCommand("insertText", false, textToInsert);
  }

  await afterRender();
  editor = composer.querySelector?.(EDITOR_SELECTOR) ?? editor;
  if (!editor.isConnected) return;
  moveCaretToStart(editor);
}

function scheduleEditor(editor) {
  if (isReplyComposer(editor)) return;

  // 入力時にeditor自体は再生成されるため、安定している投稿モーダルで管理する。
  const composer = editor.closest('[role="dialog"]') ?? editor;
  if (handledComposers.has(composer)) return;
  handledComposers.add(composer);

  // モーダル表示直後のDraft.js初期化が終わるまで待つ。
  setTimeout(() => void fillEditor(editor), 300);
}

function scan(root = document) {
  if (root instanceof Element && root.matches(EDITOR_SELECTOR)) {
    scheduleEditor(root);
  }
  root.querySelectorAll?.(EDITOR_SELECTOR).forEach(scheduleEditor);
}

scan();

new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    mutation.addedNodes.forEach((node) => {
      if (node instanceof Element) scan(node);
    });
  }
}).observe(document.documentElement, { childList: true, subtree: true });
