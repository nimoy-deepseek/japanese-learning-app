# 日学 · 部署到云端（免费、免信用卡）

本 App 全部使用**相对路径**，且语音中转 `/tts` 只用 Python 标准库（零依赖），所以一套代码直接上云即可。
推荐 **GitHub（存代码）+ Render（免费托管并跑中转服务）**。

## 一、把代码放到 GitHub

1. 打开 https://github.com/ 注册 / 登录（没有就注册一个，免费）。
2. 点右上角 **+ → New repository**：名字随意（如 `japanese-learning-app`），选 **Public**，点 **Create**。
3. 在本项目目录，把代码推上去（我已为你在本地建好了 Git 仓库）：

   在项目目录打开 PowerShell，依次执行（把“你的用户名/仓库名”换成真实值）：

   ```powershell
   git config user.name "你的名字"
   git config user.email "you@example.com"
   git add -A
   git commit -m "日学日语学习 App + 语音中转"
   git remote add origin https://github.com/你的用户名/仓库名.git
   git branch -M main
   git push -u origin main
   ```

   > 如果 GitHub 要求登录，按提示在浏览器授权即可。

## 二、用 Render 托管（免费、免信用卡、自动 HTTPS）

1. 打开 https://render.com/ 注册 / 登录。
2. 点 **New → Web Service** → 授权并选择你刚建的 GitHub 仓库。
3. Render 会自动读取 `render.yaml`；确认：
   - Runtime：**Python**
   - Plan：**Free**
   - Start Command：`python server.py`
4. 点 **Deploy**，等几分钟。

## 三、拿到网址并搬到手机

1. 构建完成后，Render 会给你一个地址：`https://xxxx.onrender.com`
2. **手机浏览器**打开这个网址 → 菜单「添加到主屏幕」当 App。
   提示：这下是 **HTTPS 公网地址**，手机随时能用、微信里也能正常放声音了。

## 四、注意

- 原来的局域网地址 `http://192.168.31.146:8000` 需要电脑开着才行，**以后就用公网地址**，电脑关机也能用。
- Render 免费实例 **15 分钟无人访问会休眠**，下次访问首次会慢约 60 秒（之后正常）。介意可升级付费版（$7/月）取消休眠。
- 若发现**国内访问较慢或偶发打不开**（海外云通病），可换用香港/新加坡的服务器或国内托管，把同样的代码部署过去即可，我可以在你选中平台后帮你调整配置。
