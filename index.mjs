/**
 * magpie 插件入口。
 *
 * ⚠️⚠️ **只导出插件契约，绝不导出工具函数**（2026-10-27 实测真缺陷）。
 *
 * magpie 宿主加载插件时会**遍历模块的全部导出**并探测性调用 —— 只要有一个
 * 导出不是「插件工厂」形状，就会被无参调用后抛错，**整个插件加载失败**
 * （`plugin list` 报 `failed`）。
 *
 * 故此处只暴露 `JetHubPlugin`（插件工厂）与 `PROVIDER` / `DISPLAY_NAME`
 * 两个字符串常量。需要内部函数做单元测试时，从 `src/*.mjs` 直接 import。
 */
export { JetHubPlugin, PROVIDER, DISPLAY_NAME } from './src/plugin.mjs'
