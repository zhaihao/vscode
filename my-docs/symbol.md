这个仓库是 vscode，我希望做一些修改, cmd + shift + o 搜索 symbol 的面板，不支持层级缩进，我希望可以

1. 像 outline 面板一样可以缩进
2. 支持折叠
3. 记住折叠状态

`src/vs/workbench/contrib/codeEditor/browser/quickaccess/gotoSymbolQuickAccess.ts` 这个应该是实现的代码

---

# 层级缩进 + 可折叠的 "Go to Symbol" Picker（已实现）

## 功能说明

**新快捷键 `Cmd+Shift+Alt+O`**（Windows/Linux: `Ctrl+Shift+Alt+O`）打开一个**层级树形 symbol picker**：

- ✅ **层级缩进** — 子符号自动缩进显示在父符号下方（基于 `IQuickTree` 的内置树缩进 + twistie）
- ✅ **折叠/展开** — 点击 twistie 或键盘操作（左右箭头）折叠/展开任意节点
- ✅ **记住折叠状态** — 关闭重开后，之前折叠的节点仍然保持折叠（内存 LRU，按文件 URI 记忆，仅当前会话有效）
- ✅ **搜索过滤** — 输入关键词模糊匹配，自动展开包含匹配项的父节点
- ✅ **导航跳转** — 选中符号 + Enter → 编辑器跳转到该符号（selection + reveal + 高亮装饰 + 状态栏公告）
- ✅ **预览高亮** — 键盘上下移动时实时 reveal + range 高亮

**旧的 `Cmd+Shift+O` 完全保持不变**（扁平列表），两者并存互不干扰。

## 方案背景

### 为什么不用 `IQuickPick`？

旧的 Cmd+Shift+O 使用 `IQuickPick` API，它是**严格的扁平列表**：
- 不支持缩进（`renderIndentGuides: None`，`indent: 0`）
- 不支持每个 item 自定义 CSS 类
- 不支持折叠/展开

### 为什么用 `IQuickTree`？

VS Code 已有 `IQuickTree` API（`src/vs/platform/quickinput/common/quickInput.ts`），它：
- 支持 `children`（层级树）、`collapsed`（折叠状态）
- 底层用 `WorkbenchObjectTree` 自动渲染缩进和 twistie
- 内置 `QuickInputTreeFilter` 模糊过滤（自动展开含匹配项的父节点）
- 已被 chat tool picker、plugin 创建器等生产功能使用

### 为什么是新命令而不是替换？

`IQuickAccessProvider.provide(picker)` 的 `picker` 类型硬编码为 `IQuickPick`，Quick Access 控制器始终调用 `createQuickPick()`，**无法通过 `quickAccess.show()` 流程使用 `IQuickTree`**。

所以新功能注册为独立的 `Action2` 命令，直接调用 `quickInputService.createQuickTree()` 打开，完全绕开 Quick Access 管道。`@` 前缀和 chat `@`-mention 继续走旧管道，保持扁平。

## 改动的文件

### 1. 新建：`src/vs/workbench/contrib/codeEditor/browser/quickaccess/gotoSymbolTreePicker.ts`

核心实现文件，包含：

| 组件                         | 说明                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| `GotoSymbolTreeAction`       | 新命令 `workbench.action.gotoSymbolTree`，快捷键 `Cmd+Shift+Alt+O`，出现在 Command Palette |
| `showGotoSymbolTreePicker()` | 主逻辑：获取活动编辑器 → 解析 `OutlineModel` → 构建树 → 打开 `IQuickTree` → wiring 事件    |
| `IGotoSymbolTreeItem`        | 树节点类型，extends `IQuickTreeItem`，携带 `symbolKind`、`range`、`elementId`              |
| `IGotoSymbolGroupTreeItem`   | 多 provider 时的分组节点（`pickable: false`）                                              |
| `buildTreeItems()`           | 递归遍历 `OutlineModel` 树构建 `IQuickTreeItem[]`，处理层级、图标、折叠状态                |
| `RangeHighlightDecorations`  | 复制旧 picker 的高亮装饰逻辑（rangeHighlight + overview ruler）                            |
| `snapshotCollapseState()`    | 关闭时快照折叠状态到内存 LRU map                                                           |
| `findItemByElementId()`      | 根据 element id 查找树节点（用于定位光标所在符号）                                         |
| `gotoLocation()`             | 导航逻辑（复制自旧 picker 的 `gotoLocation`）                                              |
| `symbolTreeCollapseState`    | 模块级 `LRUCache<string, Map<string, boolean>>`（容量 10），按文件 URI 记忆折叠状态        |

**关键行为：**
- 默认展开 **3 层**（`DEFAULT_EXPAND_DEPTH = 3`），更深层默认折叠
- 设置 `picker.canSelectMany = false`（去掉复选框，单选导航模式）
- label 使用 `$(${icon-id}) name` 语法（IconLabel `supportIcons: true` 渲染图标）
- 打开时自动定位到光标所在符号（`outlineModel.getItemEnclosingPosition`）
- 编辑器切换时自动关闭 picker

### 2. 修改：`src/vs/workbench/contrib/codeEditor/browser/codeEditor.contribution.ts`

添加一行 import 加载新模块：
```ts
import './quickaccess/gotoSymbolTreePicker.js';
```

### 3. 框架改动：给 `IQuickTree` 增加 `canSelectMany` 支持（去掉复选框）

`IQuickTree` 原本硬编码 `checkBox: true` + `checkAll: true`（多选场景）。为支持单选导航模式（symbol picker 不需要复选框），添加了 `canSelectMany` 属性：

| 文件                                                                  | 改动                                                                                                                                                                                           |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/vs/platform/quickinput/common/quickInput.ts`                     | `IQuickTree` 接口新增 `canSelectMany` 属性                                                                                                                                                     |
| `src/vs/platform/quickinput/browser/tree/quickTree.ts`                | `QuickTree` 类新增 `_canSelectMany` observable + getter/setter（默认 `true` 向后兼容）；`show()`/`update()` 用它控制 `checkBox`/`checkAll`/`count`/`ok` 可见性；新增 autorun 同步到 controller |
| `src/vs/platform/quickinput/browser/tree/quickInputTreeController.ts` | `QuickInputTreeController` 新增 `set canSelectMany` 转发给 renderer                                                                                                                            |
| `src/vs/platform/quickinput/browser/tree/quickInputTreeRenderer.ts`   | `QuickInputTreeRenderer` 新增 `canSelectMany` 标志，`renderElement` 中当为 `false` 时隐藏所有行的 checkbox                                                                                     |

当 `canSelectMany = false` 时：每行复选框隐藏、顶部"全选"控件隐藏、计数徽章隐藏、OK 按钮隐藏。

### 未改动的文件

- `src/vs/workbench/contrib/codeEditor/browser/quickaccess/gotoSymbolQuickAccess.ts` — **完全不动**
- `src/vs/editor/contrib/quickAccess/browser/gotoSymbolQuickAccess.ts` — **完全不动**
- 旧 Cmd+Shift+O、`@` 前缀、chat `@`-mention 全部保持原样

## 数据流

```
Cmd+Shift+Alt+O
       │
       ▼
GotoSymbolTreeAction.run()
       │
       ▼
showGotoSymbolTreePicker(accessor)
       │
       ├─ editorService.activeTextEditorControl → getCodeEditor() → ICodeEditor
       ├─ editor.getModel() → ITextModel
       ├─ outlineModelService.getOrCreate(model, token) → OutlineModel
       │
       ├─ buildTreeItems(outlineModel.children, rememberedCollapseState, depth=0)
       │      └─ 递归遍历 OutlineElement/OutlineGroup → IGotoSymbolTreeItem[]
       │          (label = "$(${icon}) name", children, collapsed from memory or depth)
       │
       ├─ quickInputService.createQuickTree<IGotoSymbolTreeItem>()
       ├─ picker.canSelectMany = false   ← 去掉复选框
       ├─ picker.setItemTree(treeItems)
       │
       ├─ onDidAccept   → gotoLocation(editor, range)  ← Enter 跳转
       ├─ onDidChangeActive → revealRangeInCenter + addDecorations  ← 预览高亮
       ├─ onDidHide     → snapshotCollapseState + clearDecorations  ← 记忆折叠状态
       └─ picker.show()
```

## 设计决策

- **方案 2：新命令并存** — 新注册 `GotoSymbolTreeAction`（Cmd+Shift+Alt+O），旧功能零影响
- **仅会话内记忆折叠状态** — 内存 LRU（按 URI，容量 10），与 Outline 面板行为一致，重启后重置
- **默认展开 3 层** — `DEFAULT_EXPAND_DEPTH = 3`
- **不保留 `@:` 分组搜索** — tree picker 纯做层级树搜索
- **不提取共享导航 helper** — tree picker 内直接写一份 `gotoLocation`，不重构旧代码
- **去掉复选框** — 通过给框架增加 `canSelectMany` 属性实现（向后兼容，默认 `true`）

## 验证方法

1. **类型检查：** 所有改动文件通过 `get_errors`（VS Code 语言服务全量类型检查）零错误
2. **层级缩进：** 打开嵌套 symbol 的 TS 文件 → `Cmd+Shift+Alt+O` → 确认子符号缩进
3. **折叠：** 点击父符号 twistie → 折叠/展开；左右箭头键操作验证
4. **记忆折叠：** 折叠几个符号 → 关闭 → 重开 → 确认同样的折叠状态（会话内）
5. **搜索：** 输入查询 → 确认过滤 + 自动展开匹配项的父节点
6. **导航：** 选中符号 + Enter → 编辑器跳转（行为与旧 picker 一致）
7. **回归测试 — 旧命令不受影响：**
   - `Cmd+Shift+O` → 确认旧 flat picker 仍正常
   - Quick Access 输入 `@` → 仍扁平
   - Chat 输入 `@` 附带 symbol → 仍扁平

## 参考文件

- `src/vs/workbench/contrib/chat/browser/actions/chatToolPicker.ts` — `createQuickTree` 真实使用范例
- `src/vs/editor/contrib/documentSymbols/browser/outlineModel.ts` — `OutlineModel`/`OutlineElement` 树结构
- `src/vs/editor/contrib/quickAccess/browser/editorNavigationQuickAccess.ts` — 旧 picker 的 `gotoLocation` / `addDecorations` 逻辑参考

## 进一步考虑

1. **性能：** 深层嵌套文件（数千 symbols）——`IQuickTree` 使用虚拟化，应该没问题，但值得用大文件测试
2. **非文本编辑器（notebook）：** 当前仅支持文本编辑器路径。notebook 等 outline-service 路径未接入 tree picker（可后续扩展）
3. **持久化折叠状态：** 若需跨重启记忆，可改用 `IStorageService`（Workspace scope）存储
