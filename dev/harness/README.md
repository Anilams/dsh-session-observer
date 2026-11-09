# 渲染探针

不启动 DSH，直接在浏览器里把 `client.js` 的视图组件跑起来，用来验证版式和交互。

```bash
cd dev/harness
npm i react@18 react-dom@18
python3 -m http.server 8901 --bind 127.0.0.1
# 打开 http://127.0.0.1:8901/index.html
# 深色：http://127.0.0.1:8901/index.html#dark
```

它做的事：

1. 用 UMD 版 React 建一个假的 `__ModuleLoader__`
2. 装载 `../../client.js`，调 `apply(ctx)` 拿到注册的视图组件
3. 把 `fixture.mjs` 里的快照当作 RPC 返回值喂进去
4. 注入宿主侧的 `--dsw-*` 令牌（明暗两套）

`fixture.mjs` 是合成数据，形状与宿主 `toView()` 的返回一致：`verdict` / `spine` / `beats` / `metrics` / `usage`。
