# ScoreTurner 原生 App 编译指南（安卓）

本目录已用 **Capacitor** 把网页版 ScoreTurner 包成了真正的安卓原生 App，
因此能像百度网盘、QQ 等原生 App 一样，从 **B站 / 微信 / 文件管理器** 的
「分享 / 用其他应用打开」里直接把乐谱发进来，全程无需先下载到本地。

> 当前运行环境没有 Android SDK / Xcode，无法在这里直接编译出可安装的 APK。
> 以下是在你**自己电脑**上把它变成 APK / 装到手机的步骤。

## 前置（只需装一次）
- 安装 [Android Studio](https://developer.android.com/studio)（会一并装好 Android SDK + Gradle）。
- 安装 Node.js 18+。
- 本目录已 `npm install` 好 Capacitor，无需再装。

## 编译 + 安装到手机
1. 用 USB 把手机连上电脑，打开手机「开发者选项 → USB 调试」。
2. 在项目根目录执行同步（把最新网页资源刷进安卓工程）：
   ```bash
   npx cap sync android
   ```
3. 用 Android Studio 打开安卓工程并运行 / 打包：
   ```bash
   npx cap open android
   ```
   - 想直接装到手机调试：点 Android Studio 的 ▶ Run（选已连接的设备）。
   - 想生成可分发的安装包：菜单 **Build → Generate Signed Bundle / APK**
     → APK → 用自己的签名密钥（没有就新建）→ 选 release → 得到 `app-release.apk`，
     传到手机安装即可。

## 验证「直接分享」
- 手机上装好 ScoreTurner 后，去 B站 / 微信打开一个谱子 → 点「分享」或「…」→
  「用其他应用打开 / 发送给」→ 在列表里选 **ScoreTurner** → 谱子自动打开并开始可用。
- 文件管理器里长按 PDF → 「分享」→ ScoreTurner，效果相同。

## 常见问题
- **列表里看不到 ScoreTurner？** 必须是从应用商店/APK 安装的**原生 App**，
  光用浏览器打开网页不会出现在这里（这是系统级能力，网页拿不到）。
- **从微信分享失败？** 部分微信版本会限制"分享到第三方 App"，可改用
  「在浏览器打开该谱子 → 系统分享 → ScoreTurner」，或用文件管理器分享。
- **想改网页逻辑后重新打包？** 改完 `index.html / js / css / vendor` 后，
  跑一遍 `npx cap sync android` 再 `npx cap open android` 即可。

## iOS 说明（后续步骤）
iPhone 走的是另一条机制（App 的 **Share Extension**），并且上架/真机调试需要
Apple 开发者账号。本仓库暂未生成 iOS 工程。需要时在电脑上执行
`npx cap add ios` 并补一个 Share Extension 目标即可，网页侧 `nativeShare.js`
已兼容（同样走 `ShareReceiver` 插件）。
