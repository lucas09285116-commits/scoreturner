# 云端自动编译 APK（无需在本机装 Android Studio）

已为你写好 `.github/workflows/build-android.yml`：把代码推到 GitHub 后，
GitHub 的免费服务器会自动把 ScoreTurner 编译成安卓安装包（app-debug.apk）。
本机**完全不需要** Android Studio / SDK。

## 步骤（一次性）
1. 注册 / 登录 [GitHub](https://github.com)。
2. 新建一个**私有或公开**仓库（名字随意，如 `scoreturner`）。
3. 把本目录（ScoreTurner）初始化并推上去：
   ```bash
   cd ScoreTurner
   git init
   git add .
   git commit -m "ScoreTurner 原生安卓版"
   git branch -M main
   git remote add origin https://github.com/<你的用户名>/<仓库名>.git
   git push -u origin main
   ```
   （本机若没装 git，可装 [Git for Windows](https://git-scm.com/download/win)，或用 GitHub Desktop。）

## 取 APK
4. 打开仓库的 **Actions** 标签页 → 点刚才那条运行记录 → 右下角 **Artifacts** →
   下载 `scoreturner-apk`（里面是 `app-debug.apk`）。
5. 手机用 USB 传过去安装，或发到微信文件助手再点安装。
   - 安卓会提示“允许安装未知来源应用”，开启即可。
   - 无需签名密钥，debug 包即可正常分享使用。

## 之后想更新网页逻辑重新出包
改完 `index.html / js / css / vendor` 后：
```bash
npx cap sync android     # 把网页资源刷进安卓工程
git add . && git commit -m "更新" && git push
```
GitHub 会自动重新编译，去 Actions 下载新 APK 即可。

> 注：已验证 Capacitor 工程与网页资源（含原生分享 `nativeShare.js`）都已就位，
> `cap sync` 在本地通过。云端首次跑若报某个 SDK 平台缺失，按 Actions 日志把
> `build-android.yml` 里 `platforms;android-35` 改成日志提示的版本即可（极小概率）。
