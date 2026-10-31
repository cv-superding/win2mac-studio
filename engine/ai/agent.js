'use strict';

const { chat } = require('./client');

const SYSTEM_PROMPT = `你是 Win2Mac Studio 的内置修复助手，专门排查“Windows 应用转换后在 Mac 上运行失败”的问题。
规则：
1. 先调用 list_known_issues：确定性诊断引擎已经从日志/清单中提取了问题，优先用它，不要凭空猜。
2. 对带 fix 的问题优先 apply_fix(id)；需要重建的，再调用 rebuild；重建后必须 verify_build。
3. MISSING / SIZE_MISMATCH 是传输问题，改配置无效，直接让用户重新解压原始 ZIP。
4. 每次只做少量、可解释的修改；证据不足时说明需要用户做什么，并调用 finish 结束。
5. 若诊断包的 buildId 与当前构建不一致，提醒用户先做一次完整 Mac 验证再导入新诊断包。
6. 不要绕过签名、隔离、DRM、反作弊，只做配置层面修复。
7. 最终必须调用 finish：已应用哪些 fix、重建/校验结果、用户下一步在 Mac 上要做什么。`;

function toToolSchema(tool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters || { type: 'object', properties: {} },
    },
  };
}

function truncate(value, limit = 6000) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit)}\n…（已截断 ${text.length - limit} 字符）` : text;
}

async function runAgent({
  client = chat,
  settings,
  tools,
  userPrompt,
  maxSteps = 8,
  onEvent = () => {},
}) {
  if (!Array.isArray(tools) || !tools.length) throw new Error('Agent 缺少可用工具');
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ];
  const trace = [];
  let finished = false;
  let finalText = '';

  for (let step = 1; step <= maxSteps; step += 1) {
    onEvent({ type: 'step', step, maxSteps });
    const reply = await client({
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.model,
      proxy: settings.proxy,
      temperature: settings.temperature,
      timeoutMs: settings.timeoutMs,
      messages,
      tools: tools.map(toToolSchema),
      toolChoice: 'auto',
    });
    if (!reply || typeof reply !== 'object') throw new Error('模型响应格式无效');
    if (reply.content) {
      finalText = reply.content;
      onEvent({ type: 'assistant', content: reply.content });
    }
    const toolCalls = (Array.isArray(reply.toolCalls) ? reply.toolCalls : [])
      .filter((call) => call && typeof call.name === 'string' && call.name.trim());
    if (!toolCalls.length) {
      trace.push({ step, type: 'message', content: reply.content });
      break;
    }
    // 部分兼容接口会复用/省略 id；assistant.tool_calls 与 tool 消息必须一一对应且 id 唯一。
    const usedIds = new Set();
    const callIds = toolCalls.map((call, index) => {
      const base = String(call.id || `call_${step}_${index}`);
      let id = base;
      let suffix = 1;
      while (usedIds.has(id)) {
        id = `${base}_${suffix}`;
        suffix += 1;
      }
      usedIds.add(id);
      return id;
    });
    const callNames = toolCalls.map((call) => call.name.trim());
    messages.push({
      role: 'assistant',
      content: reply.content || '',
      tool_calls: toolCalls.map((call, index) => ({
        id: callIds[index],
        type: 'function',
        function: { name: callNames[index], arguments: JSON.stringify(call.arguments || {}) },
      })),
    });
    for (let index = 0; index < toolCalls.length; index += 1) {
      const call = toolCalls[index];
      const name = callNames[index];
      const tool = byName.get(name);
      let result;
      if (!tool) {
        result = { error: `未知工具：${name}` };
      } else {
        onEvent({ type: 'tool', step, name, arguments: call.arguments });
        try {
          result = await tool.run(call.arguments || {});
        } catch (error) {
          result = { error: error.message };
        }
      }
      const text = truncate(result);
      trace.push({ step, type: 'tool', name, arguments: call.arguments, result: text });
      onEvent({ type: 'toolResult', step, name, result: text });
      messages.push({ role: 'tool', tool_call_id: callIds[index], content: text });
      if (name === 'finish' && !result?.error) {
        finished = true;
        finalText = result?.summary || finalText;
      }
    }
    if (finished) break;
  }

  return { finished, finalText, trace, messages };
}

module.exports = { runAgent, SYSTEM_PROMPT, toToolSchema };
