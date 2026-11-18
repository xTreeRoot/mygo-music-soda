# 汽水音乐 · MB iOS 兼容版

基于 [sogud/mygo-music-soda](https://github.com/sogud/mygo-music-soda) 0.2.0 的 MIT 开源插件，当前版本 **0.2.1**。浏览公开推荐歌单、音乐分类，播放服务端提供的完整 AAC 音频并显示逐字歌词。无需桌面辅助进程、Node、ffmpeg 或本机服务。

## 安装

在 MB → 我的 → 插件中从 GitHub 安装 `xTreeRoot/mygo-music-soda`，或者从 [Releases](https://github.com/xTreeRoot/mygo-music-soda/releases) 下载 ZIP 导入。插件 ID 保持 `soda`，音源名称为「汽水音乐」。宿主插件兼容版本需达到 0.1.21。

## 已实现能力

- 公开推荐歌单、歌单歌曲、音乐分类与分类歌曲。
- 标准/高码率 AAC，交给 iOS AVFoundation 原生播放。请求无损时选用可用的高码率 AAC，并返回真实音质。
- 逐字歌词；没有逐字数据时返回原始歌词。
- 试听片段会明确报错，避免把片段当成完整歌曲。

此分支移除了尚未通过 iOS 验收的实验扫码登录，只声明已实现的公开内容能力。**不支持搜索、私人歌单和会员专属内容。** 其他汽水插件使用的官方桌面 SDK、签名进程和解密组件不能直接在 iOS 启动。

## 验证

MB 的真实 QuickJS 宿主已完成首页、公开歌单、完整音频下载和 AVFoundation 可播放性检查。可播放范围由平台、地区和版权状态决定；本插件不承诺每首歌都可用，与汽水音乐及其运营方无关联。

```sh
npm run check
npm test
npm run pack
```

Node 与 Python 仅用于开发测试和打包。运行时只使用宿主网络能力，不保存账号凭据。

[MIT](LICENSE) · [第三方来源](THIRD_PARTY_NOTICES.md)
