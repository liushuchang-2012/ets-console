# 发布到 GitHub（一次性，约 2 分钟）

仓库已经初始化并提交好了（`main` 分支，1 个 commit）。剩下只差「创建远程仓库 + 推上去」，这一步需要你的 GitHub 身份，工具无法代替。

## 方式 A：网页建仓 + 一条命令（推荐）

1. 打开 <https://github.com/new>
   - Repository name：`ets-console`
   - 选 **Public**
   - **不要**勾选 "Add a README / .gitignore / license"（会让 push 冲突）
   - Create repository
2. 在 `ets-tool` 目录里执行（把 URL 换成你自己的）：

```bash
git remote add origin https://github.com/<你的用户名>/ets-console.git
git push -u origin main
```

第一次 push 会弹一个浏览器/GCM 登录窗口，登录一次以后就不用再登了。

## 方式 B：用 GitHub CLI（更省事）

```powershell
winget install --id GitHub.cli -e
gh auth login          # 选 GitHub.com → HTTPS → Login with a web browser
cd ets-tool
gh repo create ets-console --public --source . --push
```

## 方式 C：双击脚本

运行 `发布到GitHub.bat`，按提示粘贴仓库地址即可（内部就是方式 A 的命令）。

---

## 发布前检查清单

- [ ] `node src/ets.js doctor` 能定位到 ETS（换台机器也应如此）
- [ ] 双击 `启动控制台.bat` 能打开 <http://127.0.0.1:5173>
- [ ] 仓库里没有个人信息：账号、学校、token、日志、截图里的人名

如果以后要换仓库名或作者信息：

```bash
git remote set-url origin <新地址>
git config user.name "你的名字"
git config user.email "你的邮箱"
```
