const DEFAULT_SETTINGS = {
  autoFullscreen: false,
  autoMaximize: true
};

const autoFullscreenEl = document.getElementById("autoFullscreen");
const autoMaximizeEl = document.getElementById("autoMaximize");
const saveBtn = document.getElementById("saveBtn");
const detectBtn = document.getElementById("detectBtn");
const statusEl = document.getElementById("status");

// 显示状态
function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? "#dc2626" : "#2563eb";
}

// 回填设置
async function loadSettings() {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  autoFullscreenEl.checked = Boolean(settings.autoFullscreen);
  autoMaximizeEl.checked = Boolean(settings.autoMaximize);
}

// 保存设置
async function saveSettings() {
  const settings = {
    autoFullscreen: autoFullscreenEl.checked,
    autoMaximize: autoMaximizeEl.checked
  };

  await chrome.storage.sync.set(settings);
  setStatus("设置已保存");
  window.setTimeout(() => setStatus(""), 1600);
}

// 打开屏幕检测页
async function openDetectPage() {
  await chrome.tabs.create({
    url: chrome.runtime.getURL("screen-picker.html"),
    active: true
  });
}

saveBtn.addEventListener("click", async () => {
  try {
    await saveSettings();
  } catch (error) {
    console.error("保存设置失败：", error);
    setStatus(`保存失败：${error?.message || String(error)}`, true);
  }
});

detectBtn.addEventListener("click", async () => {
  try {
    await openDetectPage();
  } catch (error) {
    console.error("打开屏幕检测页失败：", error);
    setStatus(`打开失败：${error?.message || String(error)}`, true);
  }
});

loadSettings().catch((error) => {
  console.error("读取设置失败：", error);
  setStatus(`读取失败：${error?.message || String(error)}`, true);
});