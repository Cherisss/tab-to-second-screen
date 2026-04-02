const checkPermissionBtn = document.getElementById("checkPermissionBtn");
const detectBtn = document.getElementById("detectBtn");
const openOptionsBtn = document.getElementById("openOptionsBtn");
const output = document.getElementById("output");

// 输出文本
function print(obj) {
  output.textContent =
    typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
}

// 查询权限状态
async function getPermissionState() {
  try {
    const result = await navigator.permissions.query({
      name: "window-management"
    });
    return result.state;
  } catch (error) {
    return `query 失败：${error?.message || String(error)}`;
  }
}

// 格式化屏幕信息
function mapScreen(screen, index, currentIndex) {
  return {
    index,
    isCurrent: index === currentIndex,
    label: screen.label ?? "",
    left: screen.left,
    top: screen.top,
    width: screen.width,
    height: screen.height,
    availLeft: screen.availLeft,
    availTop: screen.availTop,
    availWidth: screen.availWidth,
    availHeight: screen.availHeight,
    isPrimary: screen.isPrimary,
    isInternal: screen.isInternal,
    devicePixelRatio: screen.devicePixelRatio
  };
}

// 检查权限
checkPermissionBtn.addEventListener("click", async () => {
  const state = await getPermissionState();

  print({
    support: "getScreenDetails" in window,
    isExtended: window.screen?.isExtended ?? false,
    permissionState: state
  });
});

// 检测屏幕
detectBtn.addEventListener("click", async () => {
  try {
    if (!("getScreenDetails" in window)) {
      throw new Error("当前浏览器不支持 getScreenDetails");
    }

    print("正在申请权限并检测屏幕...");

    const beforeState = await getPermissionState();
    const details = await window.getScreenDetails();

    const currentIndex = details.screens.findIndex(
      (screen) =>
        screen.left === details.currentScreen.left &&
        screen.top === details.currentScreen.top &&
        screen.width === details.currentScreen.width &&
        screen.height === details.currentScreen.height
    );

    const result = {
      support: true,
      isExtended: window.screen?.isExtended ?? false,
      permissionStateBeforeCall: beforeState,
      totalScreens: details.screens.length,
      currentScreenIndex: currentIndex,
      detectedAt: Date.now(),
      screens: details.screens.map((screen, index) =>
        mapScreen(screen, index, currentIndex)
      )
    };

    print(result);

    const saveRes = await chrome.runtime.sendMessage({
      type: "SAVE_SCREEN_DETAILS",
      payload: result
    });

    if (!saveRes?.ok) {
      console.warn("保存屏幕信息失败：", saveRes?.error);
    }
  } catch (error) {
    print({
      errorName: error?.name || "UnknownError",
      errorMessage: error?.message || String(error),
      tip: [
        "如果 permissionState 是 denied，说明之前拒绝过，需要重新允许。",
        "若浏览器没有弹权限框，请保持此页打开后再次点击检测。",
        "副屏布局变化后，请重新检测一次。"
      ]
    });

    console.error("检测失败：", error);
  }
});

// 打开选项页
openOptionsBtn.addEventListener("click", async () => {
  try {
    const res = await chrome.runtime.sendMessage({ type: "OPEN_OPTIONS_PAGE" });
    if (!res?.ok) {
      throw new Error(res?.error || "打开失败");
    }
  } catch (error) {
    console.error("打开选项页失败：", error);
    print(`打开选项页失败：${error?.message || String(error)}`);
  }
});