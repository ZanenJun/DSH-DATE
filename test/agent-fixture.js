export function fakeAgents(generate = async () => '该喝水了，先拿起水杯喝几口吧。') {
  const calls = [], disposed = [], restrictions = [];
  return { calls, disposed, restrictions,
    agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'test' }) },
    agents: { async create(options) {
      let listener, work = Promise.resolve(), canceled = false;
      const agentCtx = {
        tools: { presentAs() {}, restrict(rule) { restrictions.push(rule); }, guard() {} },
        systemPrompt: { section() {}, suppressRuntimeContext() {} },
        on(name, fn) { listener = fn; return () => { listener = null; }; }
      };
      await options.setup(agentCtx);
      const agent = { id: options.sessionId, ctx: agentCtx, session: { id: options.sessionId },
        followup(message) {
          calls.push(message);
          work = (async () => {
            const text = await generate(message);
            listener?.(agent.session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } });
            listener?.(agent.session, { type: 'turn/end', data: { reason: { kind: canceled ? 'aborted' : 'completed' } } });
          })();
        },
        whenIdle: () => work,
        cancel() { canceled = true; }
      };
      return { agent, async dispose() { disposed.push(agent.id); } };
    } }
  };
}
