# Plan: PreToolUse + PreAskUser Hook 路由（PreToolConfirm 已移除）

## TL;DR

扩展层（Copilot extension）只保留两种 pre-tool hook 的路由：

| Hook             | 触发条件                              | 说明                                                                     |
| ---------------- | ------------------------------------- | ------------------------------------------------------------------------ |
| **`PreToolUse`** | 除 `vscode_askQuestions` 外的所有工具 | 工具执行前触发，可 allow / deny / ask / updatedInput / additionalContext |
| **`PreAskUser`** | 工具名是 `vscode_askQuestions`        | agent 向用户提问时触发，返回结构同 `PreToolUse`                          |

**`PreToolConfirm` 已从代码中移除**，原因见下文「为什么移除 PreToolConfirm」。

### 路由规则（扩展层）

```
vscode_askQuestions  →  PreAskUser 触发
any other tool       →  PreToolUse 触发
```

### 为什么移除 PreToolConfirm

最初的计划是新增 `PreToolConfirm`，用于「工具需要用户审批时」触发。但分析后发现，在扩展层无法可靠判断「工具是否需要审批」：

1. **审批决策在下游产生**：是否需要确认由 workbench 的 `LanguageModelToolsService.invokeTool()` 调用 `prepareToolInvocation()` 后、检查 `preparedInvocation.confirmationMessages?.title` 才确定。
2. **扩展层拿不到该信号**：`executePreToolUseHook`（在 `toolCalling.tsx` 中调用）运行时，`confirmationMessages` 还未计算，扩展层无法区分「需要审批」和「不需要审批」。
3. **hook 命令执行器只在扩展层**：`IHookExecutor` 注册在 Copilot 扩展的 DI 容器（`extensions/copilot/src/platform/chat/node/hookExecutor.ts`），workbench 层只有 `ChatRequestHooks` 收集逻辑，没有执行能力。

因此 `PreToolConfirm` 的正确落点应该在 **workbench 层**（`LanguageModelToolsService.invokeTool()` 内，`awaitConfirmation` 之前），而非扩展层。这需要跨层架构调整，作为后续 follow-up。

---

## 当前架构（代码验证）

### `executePreToolUseHook` 路由逻辑

> `extensions/copilot/src/extension/chat/vscode-node/chatHookService.ts`

- 按 `toolName` 路由：`vscode_askQuestions` → `PreAskUser`，其余 → `PreToolUse`
- 共享私有方法 `_executePreHookWithPermission(hookType, ...)`，两种 hook 复用同一套合并逻辑（deny > ask > allow）
- 依赖共享基础设施：
  - `processHookResults()` — 通用迭代器（`hookResultProcessor.ts`），传入 `hookType` 字符串 + `onSuccess`/`onError` 回调
  - `permissionPriority` — `const permissionPriority = { 'deny': 2, 'ask': 1, 'allow': 0 }`

### 调用方（生产代码仅 1 处）

- **唯一生产调用方**: `toolCalling.tsx` — `chatHookService.executePreToolUseHook(...)`
- 测试 / mock: `chatHookService.spec.ts`、`toolCalling.spec.ts`、`mockChatHookService.ts`、`services.ts`
- 没有其他生产路径（Claude / Copilot CLI）调用它

### `executeHook` 是通用的

> `chatHookService.ts`

```typescript
async executeHook(hookType: vscode.ChatHookType, hooks, input, sessionId?, token?): Promise<vscode.ChatHookResult[]>
```

- 按 `hooks[hookType]` 取命令执行，**不校验 hookType 白名单**，任何字符串都能用

### `appendHookContext` 调用 `executePostToolUseHook`

> `toolCalling.tsx`（`appendHookContext` 函数内）

- 在工具执行成功后调用 `chatHookService.executePostToolUseHook(...)`
- 如果 `preHookResult?.permissionDecision === 'deny'` 则提前返回（跳过 PostToolUse）
- `vscode_askQuestions` 跳过 `PostToolUse`（只用 `PreAskUser`），但仍追加 `PreAskUser` 的 additionalContext

### 设计约束: 工具服务不关心是哪个 hook 产生的结果

`LanguageModelToolsService.invokeTool()` 只读 `dto.preToolUseResult`（类型 `IExternalPreToolUseHookResult`），不检查是哪个 hook event 生成的。因此可以把 `vscode_askQuestions` 路由到不同的 hook 方法，只要结果有相同的结构。

---

## 已完成的改动

以下改动已落地，移除了 `PreToolConfirm`，扩展层只保留 `PreToolUse` + `PreAskUser` 路由：

1. **`src/vs/workbench/contrib/chat/common/promptSyntax/hookTypes.ts`**
   - `HookType` 枚举保留 `PreAskUser`，移除 `PreToolConfirm`
   - `HOOKS_BY_TARGET[Target.VSCode]` 保留 `PreAskUser`，移除 `PreToolConfirm`
   - `HOOK_METADATA` 保留 `PreAskUser`，移除 `PreToolConfirm`

2. **`src/vscode-dts/vscode.proposed.chatHooks.d.ts`**
   - `ChatHookType` union 保留 `'PreAskUser'`，移除 `'PreToolConfirm'`

3. **`extensions/copilot/src/platform/chat/common/hookCommandTypes.ts`**
   - 保留 `IPreAskUserHookCommandInput` / `IPreAskUserHookSpecificCommandOutput`
   - 移除 `IPreToolConfirmHookCommandInput` / `IPreToolConfirmHookSpecificCommandOutput`

4. **`extensions/copilot/src/extension/chat/vscode-node/chatHookService.ts`**
   - `executePreToolUseHook` 路由改为：
     ```typescript
     const hookType = toolName === ToolName.CoreAskQuestions ? 'PreAskUser' : 'PreToolUse';
     ```
   - `_executePreHookWithPermission` 签名改为 `'PreToolUse' | 'PreAskUser'`
   - hookInput / hookSpecificOutput 类型改回 `IPreToolUseHook*` / `IPreAskUserHook*`

5. **`extensions/copilot/src/extension/prompts/node/panel/toolCalling.tsx`**
   - `appendHookContext` 注释更新：`PreAskUser` 替代 `PreToolUse`（针对 `vscode_askQuestions`）

---

## 后续: PreToolConfirm 的 workbench 层落点（未实现）

`PreToolConfirm` 的正确触发位置在 workbench 层，需要以下架构调整：

- 在 `LanguageModelToolsService.invokeTool()` 中、`awaitConfirmation` 之前，当 `preparedInvocation.confirmationMessages?.title` 为 true 时触发
- workbench 层需要 hook 执行能力（当前 `IHookExecutor` 只在扩展层），可通过：
  - 方案 A: 在 workbench 层实现 hook 执行器
  - 方案 B: workbench 通过 command/IPC 委托扩展层执行 hook 命令
- 触发时序：
  ```
  PreToolUse (扩展层，所有工具)
    → preToolUseResult 传给 workbench
      → prepareToolInvocation() → confirmationMessages?.title?
        → ★ PreToolConfirm 在这里触发 (workbench 层)
          → awaitConfirmation (确认 UI)
            → 执行工具
  ```

这是独立的后续工作项，不影响当前 `PreToolUse` + `PreAskUser` 的扩展层路由。

---

## 相关文件（已改动）

| 文件                                                                   | 改动                                                      |
| ---------------------------------------------------------------------- | --------------------------------------------------------- |
| `src/vs/workbench/contrib/chat/common/promptSyntax/hookTypes.ts`       | 保留 `PreAskUser`，移除 `PreToolConfirm` 枚举/映射/元数据 |
| `src/vscode-dts/vscode.proposed.chatHooks.d.ts`                        | `ChatHookType` 保留 `PreAskUser`，移除 `PreToolConfirm`   |
| `extensions/copilot/src/platform/chat/common/hookCommandTypes.ts`      | 保留 `IPreAskUserHook*`，移除 `IPreToolConfirmHook*`      |
| `extensions/copilot/src/extension/chat/vscode-node/chatHookService.ts` | 路由改回 `PreToolUse` / `PreAskUser`，更新签名和注释      |
| `extensions/copilot/src/extension/prompts/node/panel/toolCalling.tsx`  | 注释修正：`PreAskUser` 替代 `PreToolConfirm`              |

## 验证步骤

1. `npm run typecheck-client` — 验证 src/ TypeScript
2. `npm run gulp compile-extensions` — 验证 extensions/ TypeScript
3. 运行 `chatHookService.spec.ts` 测试
4. 运行 `toolCalling.spec.ts` 测试
5. 手动测试: 配置 `PreAskUser` hook，验证 `vscode_askQuestions` 路由和 allow/deny/ask/updatedInput 生效

## 决策（已确认）

- ✅ **扩展层两种 hook**: `PreToolUse`（除 askQuestions 外的所有工具）和 `PreAskUser`（agent 提问）。
- ✅ **PreToolConfirm 移除**: 无法在扩展层可靠判断「是否需要审批」，交由 workbench 层后续实现。
- ✅ **PostToolUse 排除**: `vscode_askQuestions` 跳过 `PostToolUse`（只用 `PreAskUser`）。
- ✅ **PostAskUser**: 暂不做，只做 PreAskUser。后续 follow-up。
- ✅ **CLI 格式对齐**: 只加 `Target.VSCode` (PascalCase)，不加 `Target.GitHubCopilot` (camelCase)。
- ✅ **避免代码重复**: 提取共享私有方法 `_executePreHookWithPermission`，复用同一套合并逻辑，不复制代码。
