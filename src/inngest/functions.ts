import { openai, createAgent } from "@inngest/agent-kit";
import{ Sandbox } from "@e2b/code-interpreter"
import { inngest } from "./client";
import { getSandbox } from "./utils";


export const helloWorld = inngest.createFunction(
  { id: "hello-world" },
  { event: "test/hello.world" },
  async ({ event, step }) => {
    const sandboxId = await step.run("get-sandbox-id", async () => {
      const sandbox = await Sandbox.create("kindra-nextjs-test-2")
      return sandbox.sandboxId
    });
    const codeAgent = createAgent({
      name: "code-agent",
      system: "You are an expert next.js developer. You write readable, maintainable code. You write simple Next.js & React snippets.",
      model: openai({ 
      //model: "mistralai/devstral-2512:free",
      model: "qwen/qwen3-coder:free",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: process.env.OPENROUTER_API_KEY, 
      headers: {
  "HTTP-Referer": "http://localhost:3000",
  "X-Title": "Kindra Lovable Clone",
}
     }as any),
    });

    const { output } = await codeAgent.run(
  `Write the following snippet: ${event.data.value}`,
);
console.log(output);
// [{ role: 'assistant', content: 'function removeUnecessaryWhitespace(...' }]

const sandboxUrl = await step.run("get-sandbox-url", async () => {
  const sandbox = await getSandbox(sandboxId);
  const host = sandbox.getHost(3000);
  return `https://${host}`
});
  
    return { output, sandboxUrl };
  },
);