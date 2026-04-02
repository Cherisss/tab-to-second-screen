// 默认设置
const DEFAULT_SETTINGS = {
  autoFullscreen: false,
  autoMaximize: true
};

// 扩展内部页面 URL
const SCREEN_PICKER_URL = chrome.runtime.getURL("screen-picker.html");
const OPTIONS_URL = chrome.runtime.getURL("options.html");

// 点击锁，防止极快连点
let isToggling = false;

// 记录窗口聚焦历史，越靠后越新
const focusedWindowHistory = [];

// 延迟工具
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 读 local
async function getLocal(keys) {
  return chrome.storage.local.get(keys);
}

// 写 local
async function setLocal(data) {
  return chrome.storage.local.set(data);
}

// 删 local
async function removeLocal(keys) {
  return chrome.storage.local.remove(keys);
}

// 读取设置
async function getSettings() {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return {
    autoFullscreen: Boolean(settings.autoFullscreen),
    autoMaximize: Boolean(settings.autoMaximize)
  };
}

// 初始化默认设置
async function initDefaultSettings() {
  const current = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const merged = {
    autoFullscreen:
      typeof current.autoFullscreen === "boolean"
        ? current.autoFullscreen
        : DEFAULT_SETTINGS.autoFullscreen,
    autoMaximize:
      typeof current.autoMaximize === "boolean"
        ? current.autoMaximize
        : DEFAULT_SETTINGS.autoMaximize
  };

  await chrome.storage.sync.set(merged);

  // 清理旧字段
  await chrome.storage.sync.remove("showFloatingRestoreButton");
  await removeLocal("toggleState");
}

// 是否扩展内部页
function isExtensionPage(url) {
  return typeof url === "string" && url.startsWith("chrome-extension://");
}

// 是否可用的屏幕检测结果
function hasUsableScreenDetails(screenDetails) {
  return Boolean(
    screenDetails &&
    screenDetails.support === true &&
    screenDetails.isExtended === true &&
    screenDetails.totalScreens >= 2 &&
    Array.isArray(screenDetails.screens) &&
    screenDetails.screens.length >= 2
  );
}

// 判断点是否在屏幕区域内
function isPointInScreen(x, y, screen) {
  return (
    x >= screen.left &&
    x < screen.left + screen.width &&
    y >= screen.top &&
    y < screen.top + screen.height
  );
}

// 判断两个屏幕是否相同
function isSameScreen(a, b) {
  if (!a || !b) {
    return false;
  }

  return (
    a.left === b.left &&
    a.top === b.top &&
    a.width === b.width &&
    a.height === b.height
  );
}

// 根据窗口中心点判断当前窗口属于哪块屏
function findScreenByWindow(windowInfo, screenDetails) {
  if (
    !windowInfo ||
    typeof windowInfo.left !== "number" ||
    typeof windowInfo.top !== "number" ||
    typeof windowInfo.width !== "number" ||
    typeof windowInfo.height !== "number"
  ) {
    return null;
  }

  const centerX = windowInfo.left + windowInfo.width / 2;
  const centerY = windowInfo.top + windowInfo.height / 2;

  const matched = screenDetails.screens.find((screen) =>
    isPointInScreen(centerX, centerY, screen)
  );

  if (matched) {
    return matched;
  }

  // 兜底：按左上角判断
  return (
    screenDetails.screens.find((screen) =>
      isPointInScreen(windowInfo.left, windowInfo.top, screen)
    ) || null
  );
}

// 记录窗口聚焦顺序
function rememberFocusedWindow(windowId) {
  if (typeof windowId !== "number" || windowId === chrome.windows.WINDOW_ID_NONE) {
    return;
  }

  const index = focusedWindowHistory.indexOf(windowId);
  if (index >= 0) {
    focusedWindowHistory.splice(index, 1);
  }

  focusedWindowHistory.push(windowId);

  // 限制历史长度
  if (focusedWindowHistory.length > 20) {
    focusedWindowHistory.shift();
  }
}

// 打开屏幕检测页
async function openScreenPickerPage() {
  const tabs = await chrome.tabs.query({ url: SCREEN_PICKER_URL });

  if (tabs.length > 0) {
    await chrome.tabs.update(tabs[0].id, { active: true });

    if (typeof tabs[0].windowId === "number") {
      await chrome.windows.update(tabs[0].windowId, { focused: true });
    }
    return;
  }

  await chrome.tabs.create({
    url: SCREEN_PICKER_URL,
    active: true
  });
}

// 打开选项页
async function openOptionsPage() {
  try {
    await chrome.runtime.openOptionsPage();
  } catch (error) {
    console.warn("打开选项页失败，退化为新标签页：", error);
    await chrome.tabs.create({ url: OPTIONS_URL, active: true });
  }
}

// 应用窗口状态
async function applyWindowState(windowId, settings) {
  if (typeof windowId !== "number") {
    return;
  }

  await sleep(120);

  if (settings.autoFullscreen) {
    await chrome.windows.update(windowId, {
      state: "fullscreen",
      focused: true
    });
    return;
  }

  if (settings.autoMaximize) {
    await chrome.windows.update(windowId, {
      state: "maximized",
      focused: true
    });
  }
}

// 选目标屏：主屏 <-> 第一块副屏
function pickToggleTargetScreen(currentScreen, screenDetails) {
  if (!hasUsableScreenDetails(screenDetails) || !currentScreen) {
    return null;
  }

  const primaryScreen = screenDetails.screens.find((screen) => screen.isPrimary);
  const secondaryScreen = screenDetails.screens.find((screen) => !screen.isPrimary);

  if (!primaryScreen || !secondaryScreen) {
    return null;
  }

  return currentScreen.isPrimary ? secondaryScreen : primaryScreen;
}

// 查找屏幕上的普通窗口
async function getNormalWindowsOnScreen(screen, excludeWindowId) {
  const windows = await chrome.windows.getAll({ populate: false });
  const result = [];

  for (const win of windows) {
    if (
      typeof win.id !== "number" ||
      win.id === excludeWindowId ||
      win.type !== "normal" ||
      typeof win.left !== "number" ||
      typeof win.top !== "number" ||
      typeof win.width !== "number" ||
      typeof win.height !== "number"
    ) {
      continue;
    }

    const centerX = win.left + win.width / 2;
    const centerY = win.top + win.height / 2;

    if (isPointInScreen(centerX, centerY, screen)) {
      result.push(win);
    }
  }

  return result;
}

// 优先找目标屏最近聚焦过的窗口
async function findPreferredWindowOnScreen(screen, excludeWindowId) {
  const candidates = await getNormalWindowsOnScreen(screen, excludeWindowId);

  if (candidates.length === 0) {
    return null;
  }

  // 按聚焦历史倒序找最近聚焦窗口
  for (let i = focusedWindowHistory.length - 1; i >= 0; i -= 1) {
    const historyWindowId = focusedWindowHistory[i];
    const matched = candidates.find((win) => win.id === historyWindowId);
    if (matched) {
      return matched;
    }
  }

  // 再退回当前 getAll 标记的 focused 窗口
  const focusedWindow = candidates.find((win) => win.focused);
  if (focusedWindow) {
    return focusedWindow;
  }

  // 最后退回第一个候选窗口
  return candidates[0];
}

// 把 tab 移入已有窗口
async function moveTabToExistingWindow(tabId, targetWindowId) {
  await chrome.tabs.move(tabId, {
    windowId: targetWindowId,
    index: -1
  });

  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(targetWindowId, { focused: true });
  rememberFocusedWindow(targetWindowId);
}

// 尝试清理空窗口
async function cleanupWindowIfEmpty(windowId) {
  if (typeof windowId !== "number") {
    return;
  }

  try {
    const tabs = await chrome.tabs.query({ windowId });

    if (tabs.length === 0) {
      await chrome.windows.remove(windowId);
    }
  } catch (error) {
    // 可能窗口已自动关闭，忽略即可
  }
}

// 切换当前 tab 到目标屏
async function moveCurrentTabToTargetScreen(
  activeTab,
  currentWindow,
  currentScreen,
  targetScreen,
  settings
) {
  if (!activeTab?.id || typeof activeTab.windowId !== "number") {
    throw new Error("当前标签页信息不完整");
  }

  const goingToPrimary = Boolean(targetScreen?.isPrimary);

  // 回主屏时优先并入主屏最近聚焦过的窗口
  if (goingToPrimary) {
    const reusableWindow = await findPreferredWindowOnScreen(
      targetScreen,
      activeTab.windowId
    );

    if (reusableWindow?.id) {
      await moveTabToExistingWindow(activeTab.id, reusableWindow.id);
      await cleanupWindowIfEmpty(currentWindow?.id);
      return;
    }
  }

  // 没有可复用窗口时，创建新窗口
  const tempWindow = await chrome.windows.create({
    tabId: activeTab.id,
    focused: true,
    type: "normal",
    left: targetScreen.availLeft,
    top: targetScreen.availTop,
    width: targetScreen.availWidth,
    height: targetScreen.availHeight
  });

  if (typeof tempWindow.id !== "number") {
    throw new Error("创建目标窗口失败");
  }

  rememberFocusedWindow(tempWindow.id);

  // 只有切到副屏时才应用副屏窗口状态
  if (!goingToPrimary) {
    await applyWindowState(tempWindow.id, settings);
  }
}

// 主切换逻辑
async function handleToggle(tab) {
  if (isExtensionPage(tab?.url)) {
    return;
  }

  const activeTab = tab?.id
    ? tab
    : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];

  if (!activeTab?.id || typeof activeTab.windowId !== "number") {
    throw new Error("未获取到当前活动标签页");
  }

  const { screenDetails } = await getLocal("screenDetails");

  if (!hasUsableScreenDetails(screenDetails)) {
    await openScreenPickerPage();
    return;
  }

  const currentWindow = await chrome.windows.get(activeTab.windowId);
  const currentScreen = findScreenByWindow(currentWindow, screenDetails);

  if (!currentScreen) {
    await openScreenPickerPage();
    throw new Error("无法判断当前窗口所在屏幕，请重新检测屏幕");
  }

  const targetScreen = pickToggleTargetScreen(currentScreen, screenDetails);

  if (!targetScreen) {
    await openScreenPickerPage();
    throw new Error("没有可用的目标屏幕，请重新检测屏幕");
  }

  if (isSameScreen(currentScreen, targetScreen)) {
    return;
  }

  const settings = await getSettings();
  await moveCurrentTabToTargetScreen(
    activeTab,
    currentWindow,
    currentScreen,
    targetScreen,
    settings
  );
}

// 安装/更新时初始化
chrome.runtime.onInstalled.addListener(async () => {
  await initDefaultSettings();

  try {
    const currentWindow = await chrome.windows.getCurrent();
    rememberFocusedWindow(currentWindow.id);
  } catch (error) {
    // 忽略初始化失败
  }
});

// 记录窗口聚焦变化
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    return;
  }

  try {
    const win = await chrome.windows.get(windowId);

    if (win.type === "normal") {
      rememberFocusedWindow(windowId);
    }
  } catch (error) {
    // 窗口可能已关闭，忽略
  }
});

// 窗口关闭时清理历史
chrome.windows.onRemoved.addListener((windowId) => {
  const index = focusedWindowHistory.indexOf(windowId);
  if (index >= 0) {
    focusedWindowHistory.splice(index, 1);
  }
});

// 点击扩展图标
chrome.action.onClicked.addListener(async (tab) => {
  if (isToggling) {
    return;
  }

  isToggling = true;

  try {
    await handleToggle(tab);
  } catch (error) {
    console.error("切换失败：", error);
  } finally {
    setTimeout(() => {
      isToggling = false;
    }, 300);
  }
});

// 消息处理
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type) {
    return;
  }

  if (message.type === "SAVE_SCREEN_DETAILS") {
    chrome.storage.local
      .set({ screenDetails: message.payload })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        console.error("保存屏幕信息失败：", error);
        sendResponse({ ok: false, error: String(error) });
      });
    return true;
  }

  if (message.type === "OPEN_OPTIONS_PAGE") {
    openOptionsPage()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        console.error("打开选项页失败：", error);
        sendResponse({ ok: false, error: String(error) });
      });
    return true;
  }
});