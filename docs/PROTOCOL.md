# 协议与实现说明（ETS / 讯飞 E 听说 PC 5.7.9）

> 本文只描述**公开可观测的客户端行为**，不含任何账号、密钥或个人数据。
> 版本升级后接口可能变化；遇到异常先跑 `node src/ets.js doctor`。

## 1. 架构

- 客户端是 CEF（Chromium Embedded Framework）壳 + 远程 Web 前端：
  `https://statics.ets100.com/ets-student-pc-web/index.html`
- 原生能力通过 `.pln` 插件桥暴露给页面：
  `cef.message.sendMessage(callbackId, pluginName, method, JSON)`
  插件包括 `appcontroller / etshelper / filehelper / httphelper / sevenzip / shellhelper / soundhelper / sqlitepln`。
- 页面脚本、托盘/悬浮球、录音上传等都在客户端侧完成。

## 2. 连接方式

1. 发布版默认开启 DevTools 端口，端口号写在：
   `<ETS目录>\temp\Cache_ETSShell\DevToolsActivePort`（首行为端口，第二行为 `/devtools/browser/<uuid>`）。
2. `GET http://127.0.0.1:<port>/json/list` 能拿到页面 target 的 `webSocketDebuggerUrl`。
3. 连上后用 `Runtime.evaluate` 在页面上下文执行 JS（本工具注入一个 `window.__ETS` 小运行库）。

## 3. 请求签名（不破解算法）

前端所有业务请求都经过原生插件：

```js
cef.message.sendMessage(guid, "EtsHelper", "encode_api_body_v2", JSON.stringify({ body, time }));
// => { key_id, pid, sign, sign_version: "2" }
```

- `body` = base64(JSON.stringify([{ r: path, params }]))
- `time` 必须是**字符串**（数字会返回空串）
- 请求体：`{ body: <base64>, head: { version:"1.0", sign, pid, time, time_second, key_id, sign_version } }`
- `POST https://api.ets100.com{path}`

因为签名在本地插件里完成，本工具直接调用它即可，无需知道任何密钥。

## 4. 作业数据

- 列表：`g/homework/list`，参数含 `parent_account_id / status / version:11 / limit` 等。
  `status`：1 待做、2 已完成、3 逾期；服务端返回 `all_count` 为真实总数，`data[]` 为当前页。
- 详情：`m/homework/info`（分数、完成度、时长、pass、seq_id 等）
- 结构：
  - 单词/朗读单词：`g/homework/struct` → `body.word_question[]`
  - 整段朗读等：`m/homework/struct` → `body.audio[] / dub[] / combination[] / composition[]`，每项含 `set_id` 与 `contents[].real_id`

列表行里的 `plat_data` 是提交的关键：

```json
[{"item_id":"...","item_code":"...","item_type":1,
  "total_point":5,"item_orders":[{"order":1,"total_point":5}]}]
```

## 5. 提交

### 5.1 整段朗读 / 短文（item_type = 1）→ `m/audio/sync-v2`

```json
{"resource_id":"55","real_score":5,"score":5,"set_id":"","entity_id":"","order":"1",
 "item_id":"...","item_code":"...","item_order":1,"item_type":1,
 "score_detail":"{\"accuracy_score\":\"5.0000\",\"fluency_score\":\"5.0000\",\"integrity_score\":\"5.0000\",\"standard_score\":\"5.0000\",\"total_score\":5,\"real_score\":5,\"category\":\"read_chapter\",\"rate_scale\":0}",
 "version":"2","auto_submit":1,"correct":0,"graduation":0,"source":1,"mark_service":1,
 "seq_id":"","homework_id":"<id>","exam_id":null,"client_time":"YYYY-MM-DD HH:mm:ss"}
```

响应 `code 0` 且 `body.point / complete / pass` 更新；`/m/homework/info` 复查即生效。

### 5.2 逐句跟读（item_type = 2）→ `m/audio/batch-sync-v2`

外层带 `homework_id` + 非空 `seq_id`（随机 16 位 hex），`info[]` 每句一条（`order/item_order/real_score/score/score_detail`）。
漏掉 `homework_id`/`seq_id` 时只更新 item、作业不完成。

### 5.3 单词类 → `g/homework/score-sync`

`detail[]` 每项 `{word_id, question_id, score_rate, score_detail, client_time}`，服务端按客户端上报值汇总。

## 6. 时长

`m/homework/set-use-time { homework_id, use_time, version:2 }` —— 客户端上报，立即生效，无 clamp。

## 7. 服务端行为（实测结论）

| 项目 | 行为 |
| --- | --- |
| 分数来源 | 完全采用客户端上报的 `real_score`，服务端不改算 |
| 音频校验 | 首次提交不校验是否真有录音/评测文件 |
| 事后改分 | 作业首次完成后 `is_update=0`，分数冻结 |
| 学习时长 | 任意值，无交叉校验 |
| 达标判定 | `pass` 只看分数是否过线，与音频无关 |

## 8. 风险与痕迹

服务端能看到的：`seq_id`（每次上报都变）、`complete_count`、`submit_time`、`score_detail` 的数值分布，
以及「有分数但没有音频文件」这一事实。异常模式（全满分、0 时长、瞬时完成、同一作业多次上报）都可聚类。

## 9. 兼容性

协议在 5.7.9 上验证。2026-10 期间服务端曾从 `set/entity` 维度切换到 `item` 维度（缺 `item_id/item_code` 返回
`9001 API_SERVICE_INNER_INVALID`）。如果整批提交突然全 9001，先比对一次客户端真实提交的报文字段。
