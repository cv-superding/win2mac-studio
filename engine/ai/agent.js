'use strict';

const { chat } = require('./client');

const SYSTEM_PROMPT = `你是 Win2Mac Studio 的内置修复助手，专门排查“Windows 应用转换后在 Mac 上运行失败”的问题。
规则：
1. 只能通过提供的工具读取信息和修改配置；不要臆测日志内容，先读再判断。
2. 优先查看诊断包（Report.json / Missing.txt / launcher 日志）和 config.env，再决定改什么。
3. 每次只做少量、可解释的修改；改完用 rebuild 重新打包，并在总结里告诉用户下一步怎么验证。
4. 如果证据不足（例如还没有 Mac 诊断包），先说明需要用户做什么，并调用 finish 结束。
5. 不要尝试绕过安全策略（签名、隔离、DRM、反作弊），只做配置层面的修复。
6. 最终必须调用 finish，给出简短中文总结：已改什么、预期效果、还需要用户在 Mac 上确认什么。`;

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
    if (reply.content) {
      finalText = reply.content;
      onEvent({ type: 'assistant', content: reply.content });
    }
    if (!reply.toolCalls.length) {
      trace.push({ step, type: 'message', content: reply.content });
      break;
    }
    messages.push({
      role: 'assistant',
      content: reply.content || '',
      tool_calls: reply.toolCalls.map((call) => ({
        id: call.id || `call_${step}_${call.name}`,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments || {}) },
      })),
    });
    for (const call of reply.toolCalls) {
      const tool = byName.get(call.name);
      let result;
      if (!tool) {
        result = { error: `未知工具：${call.name}` };
      } else {
        onEvent({ type: 'tool', step, name: call.name, arguments: call.arguments });
        try {
          result = await tool.run(call.arguments || {});
        } catch (error) {
          result = { error: error.message };
        }
      }
      const text = truncate(result);
      trace.push({ step, type: 'tool', name: call.name, arguments: call.arguments, result: text });
      onEvent({ type: 'toolResult', step, name: call.name, result: text });
      messages.push({ role: 'tool', tool_call_id: call.id || `call_${step}_${call.name}`, content: text });
      if (call.name === 'finish' && !result?.error) {
        finished = true;
        finalText = result?.summary || finalText;
      }
    }
    if (finished) break;
  }

  return { finished, finalText, trace, messages };
}

module.exports = { runAgent, SYSTEM_PROMPT, toToolSchema };
