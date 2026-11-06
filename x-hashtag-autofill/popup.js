const STORAGE_KEY = "hashtags";
const input = document.querySelector("#hashtags");
const saveButton = document.querySelector("#save");
const status = document.querySelector("#status");

chrome.storage.sync.get(STORAGE_KEY).then(({ [STORAGE_KEY]: hashtags = "" }) => {
  input.value = hashtags;
});

saveButton.addEventListener("click", async () => {
  await chrome.storage.sync.set({ [STORAGE_KEY]: input.value.trim() });
  status.textContent = "保存しました。";
  setTimeout(() => { status.textContent = ""; }, 2500);
});

